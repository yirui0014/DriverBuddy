/**
 * ================================================================
 * File: Gps.jsx
 * Purpose:
 *   Main navigation and trip-tracking interface for DriverBuddy.
 *   Handles all GPS logic, including:
 *     - Route building via Google Maps Directions API.
 *     - Real-time tracking with continuous geolocation updates.
 *     - Fatigue alert integration with FaceTracker.
 *     - Dynamic rerouting, ETA updates, and traffic coloring.
 *     - Step-by-step turn announcements with voice guidance.
 *     - Badge system for focused/caution/fatigued driving behavior.
 *
 * Key Components & Utilities:
 *   - GpsConsole: right-panel console for fatigue and camera.
 *   - TripSummaryCard: summarizes alerts, risks, and allows export.
 *   - Google Maps JS API (geometry, places, traffic layers).
 *   - Browser Geolocation API for live tracking.
 *   - Audio manager for TTS-based navigation cues.
 *
 * Integration:
 *   Serves as the core of DriverBuddy’s in-drive experience,
 *   combining navigation, fatigue detection, and safety feedback.
 * ================================================================
 */

import { useEffect, useRef, useState } from "react";
import { Loader } from "@googlemaps/js-api-loader";
import "./gps.css";
import GpsConsole from "./gps/GpsConsole.jsx";
import { Link, useNavigate } from "react-router-dom";
import logo from "../assets/driverbuddy-logo.png";
import { FaUserShield, FaExclamationTriangle, FaBed } from "react-icons/fa";


const API_BASE = import.meta.env.VITE_BACKEND_URL || "http://localhost:3000";
const FALLBACK_CENTER = { lat: 1.3521, lng: 103.8198 };

// Refresh + thresholds
const REFRESH_MS = 2500;
const PAN_MIN_METERS = 10;
const TRIM_MIN_METERS = 15;

// Filters
const MAX_BUFFER_POINTS = 5;
const ACCURACY_MAX_M = 80;
const TELEPORT_MAX_MPS = 60;
const FOLLOW_ZOOM = 16;

// Reroute controls
const REROUTE_DISTANCE_M = 60;
const REROUTE_MIN_FIXES = 3;
const REROUTE_COOLDOWN_MS = 10000;

// Traffic refresh cadence + thresholds
const TRAFFIC_REFRESH_MS = 30000; // how often to poll live traffic severity
const SPEED_RATIO_GOOD = 1.10;    // duration_in_traffic <= 1.10 * duration  => blue
const SPEED_RATIO_MOD  = 1.35;    // <= 1.35 => yellow, else red

// Colors for *driver route*
const COLOR_FREE  = "#1a73e8"; // blue
const COLOR_MOD   = "#fbbc05"; // yellow
const COLOR_HEAVY = "#ea4335"; // red

// Turn announcement windows
const TURN500_MIN = 420; // meters
const TURN500_MAX = 520;
const TURN100_MIN = 60;
const TURN100_MAX = 120;
const STEP_PASS_TOL = 35; // consider step done when within 35m of end

// ---- nav TTS (uses your shared audio manager; preempts chat safely) ----
async function speakNav(text) {
  try { window.__drivebuddyAbortSTT?.(); } catch {}
  await window.DriveBuddyAudio?.speak(text, "nav");
}
const stripHtml = (html) => {
  const div = document.createElement("div");
  div.innerHTML = html || "";
  return div.textContent || div.innerText || "";
};

async function fetchTripAlerts(tripId, limit = 50) {
  const res = await fetch(`${API_BASE}/api/trips/${tripId}/alerts?limit=${limit}`);
  if (!res.ok) throw new Error(`alerts HTTP ${res.status}`);
  return await res.json();
}


/* ===================== PRETTY TRIP SUMMARY CARD ===================== */
function bandFromAvg(avg) {
  if (avg == null) return "NO_FACE";
  if (avg > 6.0) return "CRITICAL";
  if (avg > 4.5) return "HIGH";
  if (avg > 3.0) return "CAUTION";
  return "OK";
}

// Parse MySQL "YYYY-MM-DD HH:mm[:ss]" or ISO strings into a local Date,
// without forcing UTC for naive timestamps.
function formatDT(isoOrSql) {
  if (!isoOrSql) return "—";

  let d;

  if (isoOrSql instanceof Date) {
    d = isoOrSql; // already a Date
  } else if (typeof isoOrSql === "string") {
    const s = isoOrSql.trim();

    const hasTZ = /[zZ]|[+\-]\d{2}:?\d{2}$/.test(s); // explicit timezone
    const isISO = /\dT\d/.test(s);                   // has 'T' separator

    // 1) If timezone is present (e.g., ...Z or +08:00), let JS handle it.
    if (hasTZ) {
      d = new Date(s);
    }
    // 2) Naive ISO ("YYYY-MM-DDTHH:mm[:ss]" with no TZ): treat as local.
    else if (isISO) {
      // Safari-safe split (avoid Date.parse ambiguity without TZ)
      const m = s.match(
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/
      );
      if (m) {
        const [, Y, M, D, h, m2, s2] = m;
        d = new Date(
          Number(Y), Number(M) - 1, Number(D),
          Number(h), Number(m2), s2 ? Number(s2) : 0, 0
        );
      } else {
        d = new Date(s); // fallback
      }
    }
    // 3) Naive SQL ("YYYY-MM-DD HH:mm[:ss]"): treat as local.
    else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(s)) {
      const m = s.match(
        /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/
      );
      const [, Y, M, D, h, m2, s2] = m;
      d = new Date(
        Number(Y), Number(M) - 1, Number(D),
        Number(h), Number(m2), s2 ? Number(s2) : 0, 0
      );
    }
    // 4) Anything else: let JS try.
    else {
      d = new Date(s);
    }
  } else {
    d = new Date(isoOrSql); // numbers, etc.
  }

  if (isNaN(d)) return "—";

  // Format as local wall-clock "YYYY-MM-DD HH:mm"
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

function TripSummaryCard({ activeTripId, tripIdForExport, tripSummary, isTracking }) {
  const avg = Number(tripSummary?.avg_risk || 0);
  const alerts = Number(tripSummary?.total_alerts || 0);
  const percent = Math.max(0, Math.min(100, (avg / 10) * 100));
  const band = bandFromAvg(avg);

  // local UI state for the drawer + loaded alerts
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [list, setList] = useState([]);

  async function toggleAlerts() {
    if (!activeTripId) {
      setOpen((o) => !o);
      return;
    }
    if (!open) {
      try {
        setLoading(true);
        const rows = await fetchTripAlerts(activeTripId, 100);
        setList(rows || []);
      } catch (e) {
        console.error("fetch alerts failed", e);
      } finally {
        setLoading(false);
      }
    }
    setOpen((o) => !o);
  }

    // Report preview state
  const [showPreview, setShowPreview] = useState(false);
  const [report, setReport] = useState(null);
  const [loadingReport, setLoadingReport] = useState(false);
  const exportableTripId = tripIdForExport; // can be active or last trip

  async function fetchTripReport() {
    if (!exportableTripId) return alert("No trip available to export.");
    try {
      setLoadingReport(true);
      const res = await fetch(`${API_BASE}/api/trips/${exportableTripId}/report`);
      if (!res.ok) throw new Error(`report HTTP ${res.status}`);
      const data = await res.json();
      setReport(data);
      setShowPreview(true);
    } catch (e) {
      console.error("export report failed", e);
      alert("Failed to create report. Please try again.");
    } finally {
      setLoadingReport(false);
    }
  }

  // Small helper to format times consistently with your existing formatter
  const showTime = (localStr, raw) => localStr || (raw ? formatDT(raw) : "—");

  return (
    <div className="tripcards">
      <div className="tripcard">
        <div className="triphead">
          <div className="triptitle">
            <span>📊 Trip Data</span>
            {exportableTripId ? <small>Trip #{exportableTripId}</small> : <small>Not Active</small>}
          </div>
          <span className="trippill">{isTracking ? "Navigation On" : "Idle"}</span>
        </div>

        <div className="tripbody">
          {/* Progress Ring (unchanged) */}
          <div className="ring" style={{ "--p": percent }}>
            <div className="ring-inner">
              <div className="ring-value">{avg.toFixed(2)}</div>
              <div className="ring-sub">Avg Risk</div>
            </div>
          </div>

          {/* Metrics (unchanged) */}
          <div className="metrics">
            <div className="metric" style={{ position: "relative" }}>
                  <div className="k">Alerts</div>
                  <div className="v">{alerts}</div>
                  <div className="s">Total this session</div>

                  {/* Dropdown toggle button */}
                  {alerts > 0 && (
                    <button className="alerts-btn" onClick={toggleAlerts}>
                      {open ? "Hide" : "View"}
                    </button>
                  )}

                  {/* Dropdown content */}
                  {open && (
                    <div className="alerts-dropdown">
                      {loading ? (
                        <div className="alert-row">Loading alerts…</div>
                      ) : list.length === 0 ? (
                        <div className="alert-row">No alerts yet</div>
                      ) : (
                        list.map((a) => (
                          <div key={a.id} className="alert-row">
                            <span className="alert-time">{formatDT(a.occurred_at)}</span>
                            <span className={`alert-pill alert-${a.band}`}>{a.band}</span>
                            <span className="alert-risk">
                              {a.risk_index != null ? `RI ${Number(a.risk_index).toFixed(2)}` : ""}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>


            <div className="metric">
              <div className="k">Risk Band</div>
              <div className="v">
                <span className={`band-badge band-${band}`}>{band}</span>
              </div>
              <div className="s">Based on average risk</div>
            </div>

            <div className="metric">
              <div className="k">Status</div>
              <div className="v">{activeTripId ? "Active" : "Stopped"}</div>
              <div className="s">{isTracking ? "GPS following route" : "GPS idle"}</div>
            </div>
          </div>
        </div>

        <div className="tripfoot">
          <span>Camera-driven sessions: face ≥ 30s/min recorded</span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              className="export-btn"
              disabled={!exportableTripId || loadingReport}
              onClick={fetchTripReport}
              title={exportableTripId ? "Generate report preview" : "No trip to export"}
            >
              {loadingReport ? "Preparing…" : "Export"}
            </button>
            <span>DriverBuddy</span>
          </div>
        </div>
      </div>

      {/* --- Preview Modal --- */}
      {showPreview && (
        <div className="report-modal-backdrop" onClick={() => setShowPreview(false)}>
          <div className="report-modal" onClick={(e) => e.stopPropagation()}>
            <div className="report-head">
              <h3>Trip Report Preview</h3>
              <button onClick={() => setShowPreview(false)}>✕</button>
            </div>

            {!report ? (
              <div style={{ padding: 16 }}>Loading…</div>
            ) : (
              <div className="report-body">
                <div className="report-grid">
                  <div><strong>Trip start:</strong> {showTime(null, report.meta.started_at)}</div>
                 <div><strong>Export time:</strong> {showTime(report.meta.exported_at_local, report.meta.exported_at)}</div>
                  <div><strong>Total alerts:</strong> {report.metrics.total_alerts}</div>
                  <div><strong>Avg risk index:</strong> {Number(report.metrics.avg_risk).toFixed(2)}</div>
                  <div><strong>Max risk index:</strong> {Number(report.metrics.max_risk).toFixed(2)}</div>
                  <div><strong>Total duration:</strong> {report.meta.duration_hms}</div>
                </div>

                <div className="report-alerts">
                  <div className="alerts-title">Alerts (chronological)</div>
                  <div className="alerts-list">
                    {report.alerts.length === 0 && <div className="alert-row">No alerts</div>}
                    {report.alerts.map((a, i) => (
                      <div className="alert-row" key={i}>
                        <span className="alert-time">{showTime(a.occurred_at_local, a.occurred_at)}</span>
                        <span className={`alert-pill alert-${a.band}`}>{a.band}</span>
                        <span className="alert-risk">{a.risk_index != null ? `RI ${Number(a.risk_index).toFixed(2)}` : ""}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <div className="report-foot">
              <button onClick={() => window.print()}>Print / Save PDF</button>
              <button onClick={() => setShowPreview(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
  


export default function Gps() {
  const navigate = useNavigate(); 
  const mapRef = useRef(null);
  const infoRef = useRef(null);

  const googleRef = useRef(null);
  const mapObjRef = useRef(null);

  const directionsServiceRef = useRef(null);
  const distanceMatrixRef = useRef(null);
  const [offRouteUI, setOffRouteUI] = useState(0);

  const [originValue, setOriginValue] = useState(null);
  const [destValue, setDestValue] = useState(null);
  const destValueRef = useRef(null);
  const originValueRef = useRef(null);
  // Main route data we keep trimming/following
  const routePolylineRef = useRef(null); // colored (blue/yellow/red)
  const routeOutlineRef  = useRef(null); // thick black border
  const fullRouteRef = useRef([]);
  const remainingStartIdxRef = useRef(0);

  // Detailed steps for turns (NEW)
  const stepListRef = useRef([]); // [{end:{lat,lng}, instruction, distance}]
  const stepFlagsRef = useRef([]); // [{ann500:false, ann100:false}]
  const stepIdxRef = useRef(0);

  const lastFixRef = useRef(null);
  const fixBufRef = useRef([]);

  const lastPanPosRef = useRef(null);
  const lastTrimPosRef = useRef(null);

  const carMarkerRef = useRef(null);

  const watchIdRef = useRef(null);
  const [isTracking, setIsTracking] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [accM, setAccM] = useState(null);

  const [nextMs, setNextMs] = useState(null);
  const nextAtRef = useRef(null);
  const [fixCount, setFixCount] = useState(0);
  

  // Reroute bookkeeping
  const offRouteCountRef = useRef(0);
  const lastRerouteAtRef = useRef(0);
  const rerouteInProgressRef = useRef(false);

  // Heading helpers
  const lastNearestIdxRef = useRef(null);

  // Traffic overlay (pre-drive) + throttle
  const trafficLayerRef = useRef(null);
  const lastTrafficRefreshAtRef = useRef(0);

  const [nextTurn, setNextTurn] = useState(null); 

  const [focusedLevel, setFocusedLevel] = useState(0);
  const [cautionUnlocked, setCautionUnlocked] = useState(false);
  const [fatiguedUnlocked, setFatiguedUnlocked] = useState(false);

  

  // ========== NEW: Trip summary from FaceTracker ==========
  const [tripSummary, setTripSummary] = useState({ total_alerts: 0, avg_risk: 0 });
  const [activeTripId, setActiveTripId] = useState(null);
  const [lastTripId, setLastTripId] = useState(null);

  useEffect(() => {
    function onStarted(e) {
      setFocusedLevel(0);
      setCautionUnlocked(false);
      setFatiguedUnlocked(false);
      const id = e.detail?.trip_id ?? null;
      setActiveTripId(id);
      setLastTripId(id);
      setTripSummary({ total_alerts: 0, avg_risk: 0 });
    }
    function onSummary(e) {
      const sum = e.detail?.summary || {};
      setTripSummary({
        total_alerts: sum.total_alerts ?? 0,
        avg_risk: sum.avg_risk ?? 0
      });
    }
    function onStopped(e) {
      const sum = e.detail?.summary || {};
      setTripSummary({
        total_alerts: sum.total_alerts ?? 0,
        avg_risk: sum.avg_risk ?? 0
      });
      setActiveTripId(null);
    }
    // ✅ NEW: when a trip is deleted, clear everything including lastTripId
    function onDeleted() {
      setActiveTripId(null);
      setLastTripId(null);             // <- removes "Trip #xx"
      setTripSummary({ total_alerts: 0, avg_risk: 0 });
    }
    // Every finalized minute from FaceTracker
  function onMinute(e) {
    const band = e.detail?.band;
    if (!band) return;

    // Rule 1: OK band → +1 Focused level
    if (band === "OK") {
      setFocusedLevel((x) => x + 1);
    }

    // Rule 2: CAUTION or above → unlock Caution badge
    if (band === "CAUTION" || band === "HIGH" || band === "CRITICAL") {
      setCautionUnlocked(true);
    }

    // Rule 3: HIGH or above → unlock Fatigued badge
    if (band === "HIGH" || band === "CRITICAL") {
      setFatiguedUnlocked(true);
    }
  }
    window.addEventListener("drivebuddy:minute-band", onMinute);
    window.addEventListener("drivebuddy:trip-started", onStarted);
    window.addEventListener("drivebuddy:trip-summary", onSummary);
    window.addEventListener("drivebuddy:trip-stopped", onStopped);
    window.addEventListener("drivebuddy:trip-deleted", onDeleted);  // <- NEW
    return () => {
      window.removeEventListener("drivebuddy:trip-started", onStarted);
      window.removeEventListener("drivebuddy:trip-summary", onSummary);
      window.removeEventListener("drivebuddy:trip-stopped", onStopped);
      window.removeEventListener("drivebuddy:trip-deleted", onDeleted); // <- NEW
      window.removeEventListener("drivebuddy:minute-band", onMinute);
    };
  }, []);


  // helper: ordinal for exits
const toOrdinal = (n) => {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

// helper: derive concise action + type from Google step text
function simplifyInstruction(text) {
  if (!text) return { kind: "straight", label: "Continue" };
  const t = text.toLowerCase();

  // roundabout: "take the 2nd exit"
  const rb = t.match(/roundabout.*?(\d+)(?:st|nd|rd|th)? exit/);
  if (rb) {
    const exit = parseInt(rb[1], 10);
    return { kind: "roundabout", exit, label: `${toOrdinal(exit)} exit at roundabout` };
  }

  if (t.includes("u-turn") || t.includes("u turn")) return { kind: "uturn", label: "Make a U-turn" };
  if (t.includes("slight left")) return { kind: "slight-left", label: "Slight left" };
  if (t.includes("slight right")) return { kind: "slight-right", label: "Slight right" };
  if (t.includes("turn left") || t.includes("keep left")) return { kind: "left", label: "Turn left" };
  if (t.includes("turn right") || t.includes("keep right")) return { kind: "right", label: "Turn right" };
  if (t.includes("continue") || t.includes("straight")) return { kind: "straight", label: "Continue straight" };

  return { kind: "straight", label: "Continue" };
}


  useEffect(() => {
  const onReroute = async (evt) => {
    const best = evt?.detail;
    if (!best) return;

    // Build route from current location to rest stop
    const curr = lastFixRef.current;
    if (!curr || !best.lat || !best.lng) return;

    try {
      await buildRoute(curr, { lat: best.lat, lng: best.lng });
      setHud(`Rerouted to rest stop: ${best.name}`);
      await speakNav(`Rerouting you to ${best.name}.`);
    } catch (e) {
      console.error("Reroute to rest stop failed:", e);
      setHud("Reroute to rest stop failed");
    }
  };

  window.addEventListener("drivebuddy:reroute", onReroute);
  return () => window.removeEventListener("drivebuddy:reroute", onReroute);
}, []);


  useEffect(() => {
    const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
    const loader = new Loader({
      apiKey,
      version: "weekly",
      libraries: ["geometry", "places"],
    });

    let mounted = true;

    loader.load().then((google) => {
      if (!mounted) return;
      googleRef.current = google;

      const map = new google.maps.Map(mapRef.current, {
        center: FALLBACK_CENTER,
        zoom: 12,
        fullscreenControl: false,
        streetViewControl: false,
        mapTypeControl: false,
      });
      mapObjRef.current = map;
      // // Simulation: click to fake GPS fix
      // map.addListener("click", (e) => {
      //   const fakePos = {
      //     coords: {
      //       latitude: e.latLng.lat(),
      //       longitude: e.latLng.lng(),
      //       accuracy: 5, // pretend good GPS accuracy
      //     },
      //     timestamp: Date.now(),
      //   };
      //   // console.log("[SIM MODE] Map clicked → new fake position:", fakePos.coords);
      //   onFix(fakePos); // feed into normal GPS pipeline
      // });


      directionsServiceRef.current = new google.maps.DirectionsService();
      distanceMatrixRef.current = new google.maps.DistanceMatrixService();

      // Thick black outline (underneath)
      routeOutlineRef.current = new google.maps.Polyline({
        map,
        path: [],
        strokeOpacity: 1,
        strokeWeight: 9,
        strokeColor: "#000000",
        zIndex: 1,
      });

      // Colored route (above)
      routePolylineRef.current = new google.maps.Polyline({
        map,
        path: [],
        strokeOpacity: 0.95,
        strokeWeight: 6,
        strokeColor: COLOR_FREE,
        zIndex: 2,
      });

      // Car marker; rotated to road direction
      carMarkerRef.current = new google.maps.Marker({
        map,
        visible: false,
        icon: {
          path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
          fillColor: "#1a73e8",
          fillOpacity: 1,
          strokeWeight: 1,
          scale: 6,
          rotation: 0,
        },
      });

      // Pre-drive: show Google's traffic overlay
      trafficLayerRef.current = new google.maps.TrafficLayer({ autoRefresh: true });
      trafficLayerRef.current.setMap(map);

      const originInput = document.getElementById("originField");
      const destInput = document.getElementById("destinationField");
      if (originInput) new google.maps.places.Autocomplete(originInput);
      if (destInput) new google.maps.places.Autocomplete(destInput);

      centerOnUserOnce();
    });

    return () => {
      mounted = false;
      if (watchIdRef.current && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
    };
  }, []);

  // Countdown refresh + light polling for traffic severity / ETA
  useEffect(() => {
    const id = setInterval(async () => {
      if (!nextAtRef.current || !isTracking) return;
      const remain = Math.max(0, Math.round(nextAtRef.current - performance.now()));
      setNextMs(remain);

      if (remain === 0) {
        const google = googleRef.current;
        const map = mapObjRef.current;
        const curr = lastFixRef.current;

        if (google && map && curr) {
          const lastPan = lastPanPosRef.current;
          const movedEnough =
            !lastPan ||
            google.maps.geometry.spherical.computeDistanceBetween(
              new google.maps.LatLng(lastPan),
              new google.maps.LatLng(curr)
            ) >= PAN_MIN_METERS;

          if (movedEnough) {
            if (map.getZoom() < FOLLOW_ZOOM) map.setZoom(FOLLOW_ZOOM);
            map.panTo(curr);
            lastPanPosRef.current = curr;
          }

          // Keep route trimmed as we tick
          trimRouteToPosition(curr); // keeps remaining path ahead

          // Live ETA
          await updateEtaFromCurrent(curr);

          // Throttled traffic recolor
          if (performance.now() - lastTrafficRefreshAtRef.current > TRAFFIC_REFRESH_MS) {
            await refreshTrafficSeverityColor(curr);
            lastTrafficRefreshAtRef.current = performance.now();
          }

          // Turn notifications (tick-level check too)
          await maybeAnnounceTurn(curr, /*firstFix*/ false);
        }

        nextAtRef.current = performance.now() + REFRESH_MS;
        setNextMs(REFRESH_MS);
      }
    }, 200);
    return () => clearInterval(id);
  }, [isTracking]);

  function setHud(text, acc = null) {
    if (text) setStatus(text);
    if (acc != null) setAccM(acc);
  }

  function centerOnUserOnce() {
    if (!navigator.geolocation) return;
    setHud("Getting current location…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const here = { lat: pos.coords.latitude, lng: pos.coords.longitude, t: pos.timestamp };
        const map = mapObjRef.current;
        if (!map) return;
        map.setCenter(here);
        map.setZoom(15);
        lastFixRef.current = here;
        lastPanPosRef.current = here;
        lastTrimPosRef.current = here;

        if (carMarkerRef.current) {
          carMarkerRef.current.setPosition(here);
          carMarkerRef.current.setVisible(true);
        }

        setHud("Centered on you", Math.round(pos.coords.accuracy ?? 0));
      },
      () => setHud("Using default location (GPS denied)"),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  }

  const handleUseMyLocation = () => {
    if (!navigator.geolocation) return alert("Geolocation not supported.");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        document.getElementById("originField").value =
          `${pos.coords.latitude}, ${pos.coords.longitude}`;
      },
      (err) => alert("Location error: " + err.message),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  };

  const handleStart = async () => {
    const origin = document.getElementById("originField").value.trim();
    const destination = document.getElementById("destinationField").value.trim();
    if (!origin || !destination) return alert("Please set both origin and destination.");
    setOriginValue(origin);
    setDestValue(destination);
    originValueRef.current = origin;
    destValueRef.current = destination;

    // console.log("[handleStart] Origin:", origin, "Destination:", destination);
    await buildRoute(origin, destination);

    // Driving mode visuals: hide global traffic, gray basemap
    trafficLayerRef.current?.setMap(null);
    mapObjRef.current?.setOptions({ styles: null });
    setIsTracking(true); 
    startTracking();
  };

  const handleStop = () => {
    stopTracking();
    // console.log("[handleStop] Resetting origin/dest. Old values:", originValueRef.current, destValueRef.current);
    setOriginValue(null);
    setDestValue(null);
    originValueRef.current = null;
    destValueRef.current = null;
     setNextTurn(null);   // CLEAR turn indicator when stopped
    // Restore pre-drive traffic overlay (normal map style already)
    trafficLayerRef.current?.setMap(mapObjRef.current);
  };

  const handleClear = () => {
    stopTracking();
    fullRouteRef.current = [];
    remainingStartIdxRef.current = 0;
    routeOutlineRef.current?.setPath([]);
    routePolylineRef.current?.setPath([]);
    infoRef.current.textContent = "";
    if (carMarkerRef.current) carMarkerRef.current.setVisible(true);
    offRouteCountRef.current = 0;

    // Reset steps (NEW)
    stepListRef.current = [];
    stepFlagsRef.current = [];
    stepIdxRef.current = 0;

    // Restore pre-drive traffic overlay
    trafficLayerRef.current?.setMap(mapObjRef.current);
    setOriginValue(null);
    setDestValue(null);
    originValueRef.current = null;
    destValueRef.current = null;
    setNextTurn(null);
    setHud("Cleared");
  };

  async function buildRoute(origin, destination) {
    const google = googleRef.current;
    const svc = directionsServiceRef.current;
    const map = mapObjRef.current;

    return new Promise((resolve, reject) => {
      svc.route(
        {
          origin,
          destination,
          travelMode: google.maps.TravelMode.DRIVING,
          drivingOptions: { departureTime: new Date(), trafficModel: "bestguess" },
          provideRouteAlternatives: false,
        },
        (result, status) => {
          if (status === google.maps.DirectionsStatus.OK) {
            const route = result.routes[0];
            const leg = route.legs[0];
            const path = route.overview_path || [];

            fullRouteRef.current = path.map((ll) => ({ lat: ll.lat(), lng: ll.lng() }));
            remainingStartIdxRef.current = 0;

            // --- capture detailed steps for turn announcements (NEW)
            const steps = [];
            (leg?.steps || []).forEach((st) => {
              steps.push({
                end: { lat: st.end_location.lat(), lng: st.end_location.lng() },
                instruction: stripHtml(st.instructions || ""),
                distance: st.distance?.value ?? null, // meters
              });
            });
            stepListRef.current = steps;
            stepFlagsRef.current = steps.map(() => ({ ann500: false, ann100: false }));
            stepIdxRef.current = 0;
            // ---------------------------------------------------------

            setRoutePaths(path);              // set both outline + colored
            colorPolylineByLegTraffic(leg);   // color by current traffic

            map.fitBounds(route.bounds, 60);

            infoRef.current.textContent =
              `Route: ${leg.distance?.text}, about ${leg.duration_in_traffic?.text || leg.duration?.text}. Driving only.`;
            resolve();
          } else {
            alert("Directions request failed: " + status);
            reject(status);
          }
        }
      );
    });
  }

  function startTracking() {
    if (!navigator.geolocation) return alert("Geolocation not supported.");
    if (isTracking) return;

    const opts = { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 };
    navigator.geolocation.getCurrentPosition(onFix, onGeoError, opts);
    watchIdRef.current = navigator.geolocation.watchPosition(onFix, onGeoError, opts);

    setIsTracking(true);
    setHud("Tracking…");
    nextAtRef.current = performance.now() + REFRESH_MS;
    setNextMs(REFRESH_MS);
  }

  function stopTracking() {
    if (watchIdRef.current && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setIsTracking(false);
    nextAtRef.current = null;
    setNextMs(null);
    setHud("Paused");
  }

  function onGeoError(err) {
    setHud("GPS error");
    alert("Location error: " + err.message);
  }

  async function onFix(pos) {
    const google = googleRef.current;
    const map = mapObjRef.current;
    if (!google || !map) return;

    const { latitude, longitude, accuracy } = pos.coords;
    if (accuracy == null || accuracy > ACCURACY_MAX_M) return;

    const newPoint = { lat: latitude, lng: longitude, t: pos.timestamp };
    const prev = lastFixRef.current;
    if (prev) {
      const dt = (newPoint.t - prev.t) / 1000;
      if (dt > 0) {
        const dist = google.maps.geometry.spherical.computeDistanceBetween(
          new google.maps.LatLng(prev),
          new google.maps.LatLng(newPoint)
        );
        if (dist / dt > TELEPORT_MAX_MPS) return;
      }
    }

    fixBufRef.current.push(newPoint);
    if (fixBufRef.current.length > MAX_BUFFER_POINTS) fixBufRef.current.shift();
    const smoothed = medianSmooth(fixBufRef.current);

    lastFixRef.current = smoothed;
    setHud(undefined, Math.round(accuracy ?? 0));
    setFixCount((c) => c + 1);

    // Rotate icon to road direction
    rotateMarker(smoothed, prev);

    // Update marker position
    if (carMarkerRef.current) {
      carMarkerRef.current.setPosition(smoothed);
      carMarkerRef.current.setVisible(true);
    }

    // Pan follow
    const lastPan = lastPanPosRef.current;
    const movedEnoughToPan =
      !lastPan ||
      google.maps.geometry.spherical.computeDistanceBetween(
        new google.maps.LatLng(lastPan),
        new google.maps.LatLng(smoothed)
      ) >= PAN_MIN_METERS;

    if (movedEnoughToPan) {
      if (map.getZoom() < FOLLOW_ZOOM) map.setZoom(FOLLOW_ZOOM);
      map.panTo(smoothed);
      lastPanPosRef.current = smoothed;
    }

    // Trim + distance to route
    const lastTrim = lastTrimPosRef.current;
    const movedEnoughToTrim =
      !lastTrim ||
      google.maps.geometry.spherical.computeDistanceBetween(
        new google.maps.LatLng(lastTrim),
        new google.maps.LatLng(smoothed)
      ) >= TRIM_MIN_METERS;

    let bestDist = null;
    if (movedEnoughToTrim) {
      ({ bestDist } = trimRouteToPosition(smoothed));
      lastTrimPosRef.current = smoothed;
    } else {
      bestDist = distanceToRoute(smoothed).bestDist;
    }

    // Turn announcements (first priority so you hear it immediately on fix)
    await maybeAnnounceTurn(smoothed, /*firstFix*/ true);


    // console.log("[onFix] distToRoute:", bestDist, "offRouteCount:", offRouteCountRef.current, "destValueRef:", destValueRef.current);

    // Maybe re-route
    await maybeReroute(smoothed, bestDist);

    // ETA
    await updateEtaFromCurrent(smoothed);

    // Throttled traffic recolor on fix
    if (performance.now() - lastTrafficRefreshAtRef.current > TRAFFIC_REFRESH_MS) {
      await refreshTrafficSeverityColor(smoothed);
      lastTrafficRefreshAtRef.current = performance.now();
    }

    nextAtRef.current = performance.now() + REFRESH_MS;
    setNextMs(REFRESH_MS);
  }

  // ---------- Helpers ----------

  function setRoutePaths(pathOrLatLngArray) {
    routeOutlineRef.current?.setPath(pathOrLatLngArray);
    routePolylineRef.current?.setPath(pathOrLatLngArray);
  }

  function medianSmooth(buf) {
    const last = buf[buf.length - 1];
    const a = buf[buf.length - 2];
    const b = buf[buf.length - 3];
    const arrLat = [last?.lat, a?.lat, b?.lat].filter(v => v != null).sort((x,y)=>x-y);
    const arrLng = [last?.lng, a?.lng, b?.lng].filter(v => v != null).sort((x,y)=>x-y);
    return {
      lat: arrLat[Math.floor(arrLat.length / 2)],
      lng: arrLng[Math.floor(arrLng.length / 2)],
      t: last?.t
    };
  }

  function rotateMarker(curr, prev) {
    const google = googleRef.current;
    if (!carMarkerRef.current || !google) return;

    const segHeading = routeSegmentHeadingNear(curr);
    let heading = segHeading;

    if (heading == null && prev) {
      const a = new google.maps.LatLng(prev);
      const b = new google.maps.LatLng(curr);
      if (google.maps.geometry.spherical.computeDistanceBetween(a, b) > 2) {
        heading = google.maps.geometry.spherical.computeHeading(a, b);
      }
    }

    if (heading != null) {
      const icon = { ...(carMarkerRef.current.getIcon() || {}) };
      icon.rotation = heading;
      carMarkerRef.current.setIcon(icon);
    }
  }

  function routeSegmentHeadingNear(pos) {
    const google = googleRef.current;
    const full = fullRouteRef.current;
    if (!google || full.length < 2) return null;

    const { bestIdx } = distanceToRoute(pos);
    lastNearestIdxRef.current = bestIdx;

    if (bestIdx != null && bestIdx < full.length - 1) {
      const a = new google.maps.LatLng(full[bestIdx]);
      const b = new google.maps.LatLng(full[bestIdx + 1]);
      return google.maps.geometry.spherical.computeHeading(a, b);
    }
    return null;
  }

  function distanceToRoute(pos) {
    const google = googleRef.current;
    const full = fullRouteRef.current;
    if (!google || !full.length) return { bestDist: Infinity, bestIdx: null };

    let bestIdx = remainingStartIdxRef.current;
    let bestDist = Infinity;
    const p = new google.maps.LatLng(pos);

    for (let i = remainingStartIdxRef.current; i < full.length; i++) {
      const d = google.maps.geometry.spherical.computeDistanceBetween(
        p, new google.maps.LatLng(full[i])
      );
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
      if (bestDist < 15) break;
    }
    return { bestDist, bestIdx };
  }

  function trimRouteToPosition(pos) {
    const { bestDist, bestIdx } = distanceToRoute(pos);
    if (!routePolylineRef.current) return { bestDist, bestIdx };

    if (bestIdx > remainingStartIdxRef.current) {
      remainingStartIdxRef.current = bestIdx;
      const remaining = fullRouteRef.current.slice(bestIdx);
      setRoutePaths(remaining); // update both polylines
    }
    lastNearestIdxRef.current = bestIdx;
    return { bestDist, bestIdx };
  }


async function maybeReroute(currentPos, distToRoute) {
    const now = performance.now();
    if (!destValueRef.current || !fullRouteRef.current.length) {
      // console.log("[maybeReroute] skipped — no destValue or no route. destValueRef:", destValueRef.current);
      return;
    }

    if (distToRoute > REROUTE_DISTANCE_M) {
      offRouteCountRef.current += 1;
    } else {
      offRouteCountRef.current = 0;
    }
    setOffRouteUI(offRouteCountRef.current);

    // console.log("[maybeReroute]", "distToRoute:", distToRoute, "offRouteCount:", offRouteCountRef.current, "destValueRef:", destValueRef.current);

    const shouldReroute =
      offRouteCountRef.current >= REROUTE_MIN_FIXES &&
      now - lastRerouteAtRef.current > REROUTE_COOLDOWN_MS &&
      !rerouteInProgressRef.current;

    if (!shouldReroute) return;

    try {
      rerouteInProgressRef.current = true;
      setHud("Rerouting…");
      await buildRoute(currentPos, destValueRef.current);
      lastRerouteAtRef.current = performance.now();
      offRouteCountRef.current = 0;
      setOffRouteUI(0);
      setHud("Rerouted");

      await refreshTrafficSeverityColor(currentPos);
      lastTrafficRefreshAtRef.current = performance.now();
      // console.log("[maybeReroute] REROUTE TRIGGERED to", destValueRef.current);
    } catch (e) {
      setHud("Reroute failed");
      // console.error("[maybeReroute] error:", e);
    } finally {
      rerouteInProgressRef.current = false;
    }
  }


  async function updateEtaFromCurrent(curr) {
    const google = googleRef.current;
    const dm = distanceMatrixRef.current;
    const dest = document.getElementById("destinationField")?.value?.trim();
    if (!google || !dm || !dest || !curr) return;

    return new Promise((resolve) => {
      dm.getDistanceMatrix(
        {
          origins: [new google.maps.LatLng(curr)],
          destinations: [dest],
          travelMode: google.maps.TravelMode.DRIVING,
          drivingOptions: { departureTime: new Date(), trafficModel: "bestguess" },
        },
        (res, status) => {
          if (status === "OK" && res.rows?.[0]?.elements?.[0]) {
            const el = res.rows[0].elements[0];
            const distTxt = el.distance?.text ?? "—";
            const durTxt = el.duration_in_traffic?.text || el.duration?.text || "—";
            infoRef.current.textContent = `ETA: ${durTxt}  ·  ${distTxt}  ·  Driving only`;
          }
          resolve();
        }
      );
    });
  }

  function colorPolylineByLegTraffic(leg) {
    const dur  = leg.duration?.value;
    const durT = leg.duration_in_traffic?.value ?? dur;
    if (!dur || !routePolylineRef.current) return;

    const ratio = durT / dur;
    let color = COLOR_FREE;                 // blue
    if (ratio > SPEED_RATIO_MOD) color = COLOR_HEAVY;   // red
    else if (ratio > SPEED_RATIO_GOOD) color = COLOR_MOD; // yellow

    routePolylineRef.current.setOptions({ strokeColor: color });
  }

  async function refreshTrafficSeverityColor(curr) {
    const google = googleRef.current;
    const svc = directionsServiceRef.current;
    const dest = document.getElementById("destinationField")?.value?.trim();
    if (!google || !svc || !dest) return;

    return new Promise((resolve) => {
      svc.route(
        {
          origin: curr,
          destination: dest,
          travelMode: google.maps.TravelMode.DRIVING,
          drivingOptions: { departureTime: new Date(), trafficModel: "bestguess" },
        },
        (result, status) => {
          if (status === google.maps.DirectionsStatus.OK) {
            const leg = result.routes?.[0]?.legs?.[0];
            if (leg) colorPolylineByLegTraffic(leg);
          }
          resolve();
        }
      );
    });
  }

  // ======== TURN ANNOUNCEMENTS (NEW) ========
  function distMeters(a, b) {
    const g = googleRef.current;
    return g.maps.geometry.spherical.computeDistanceBetween(
      new g.maps.LatLng(a), new g.maps.LatLng(b)
    );
  }

  async function maybeAnnounceTurn(curr, firstFix) {
    const steps = stepListRef.current;
    if (!steps.length) return;

    let idx = stepIdxRef.current;
    if (idx >= steps.length) return;

    const step = steps[idx];
    const d = distMeters(curr, step.end);
    // update turn indicator every ~100m
    const action = simplifyInstruction(step.instruction);
    const roundedDist = Math.max(0, Math.round(d / 100) * 100);
    setNextTurn({
      ...action,
      distance: roundedDist,
    });

    // Step completion
    if (d < STEP_PASS_TOL) {
      stepIdxRef.current = Math.min(idx + 1, steps.length);
      idx = stepIdxRef.current;
      if (idx >= steps.length) {
        await speakNav("You have arrived at your destination.");
        return;
      }
    }

    const flags = stepFlagsRef.current[idx];
    const instr = (step.instruction || "Proceed to the next turn.").replace(/\s+/g, " ").trim();

    // If first fix after start and we're very close, prioritize the 100 m cue
    if (firstFix && d <= TURN100_MAX && d >= TURN100_MIN && !flags.ann100) {
      flags.ann100 = true;
      await speakNav(`In 100 meters, ${instr}.`);
      return;
    }

    if (d <= TURN500_MAX && d >= TURN500_MIN && !flags.ann500) {
      flags.ann500 = true;
      await speakNav(`In 500 meters, ${instr}.`);
      return;
    }

    if (d <= TURN100_MAX && d >= TURN100_MIN && !flags.ann100) {
      flags.ann100 = true;
      await speakNav(`In 100 meters, ${instr}.`);
      return;
    }
  }
  // ==========================================

return (
  <div className={`app-shell ${isTracking ? "nav-mode" : ""}`}>
    <header className="app-header">
      <div className="app-header-left">
        <img src={logo} alt="DriverBuddy Logo" className="app-logo" />
        <h1 className="app-title">DriverBuddy</h1>
      </div>

      <nav className="app-header-right">
        {/* BADGE STATUS ICONS + LABELS */}
        <div className="nav-badge-cluster" title="Badges earned">
          {focusedLevel === 0 && !cautionUnlocked && !fatiguedUnlocked ? (
            /* Show single empty placeholder when no badges earned */
            <div className="nav-badge-status">
              <FaUserShield className="nav-badge-icon empty" />
              <div className="nav-badge-text">No badges earned</div>
            </div>
          ) : (
            <>
              {/* Focused Driver */}
              {focusedLevel > 0 && (
                <div className="nav-badge-status">
                  <FaUserShield className="nav-badge-icon earned" />
                  <div className="nav-badge-text">Focused</div>
                  <div className="nav-badge-level">LV: {focusedLevel}</div>
                </div>
              )}

              {/* Caution Driver */}
              {cautionUnlocked && (
                <div className="nav-badge-status">
                  <FaExclamationTriangle className="nav-badge-icon caution" />
                  <div className="nav-badge-text caution">Caution</div>
                </div>
              )}

              {/* Fatigued Driver */}
              {fatiguedUnlocked && (
                <div className="nav-badge-status">
                  <FaBed className="nav-badge-icon fatigued" />
                  <div className="nav-badge-text fatigued">Fatigued</div>
                </div>
              )}
            </>
          )}
        </div>

        <button onClick={() => navigate("/dashboard")}>Dashboard</button>
        {isTracking && <button className="stop-btn" onClick={handleStop}>Stop</button>}
      </nav>
    </header>

    <div className="gps-root">
      {!isTracking && (
        <div className="gps-panel">
          <input id="originField" className="text-input" placeholder="Origin" />
          <input id="destinationField" className="text-input" placeholder="Destination" />
          <div className="gps-buttons">
            <button onClick={handleUseMyLocation}>Use my location</button>
            <button onClick={handleStart}>Start Driving</button>
            <button onClick={handleClear}>Clear</button>
          </div>
        </div>
      )}

      <div id="map" ref={mapRef} className="gps-map" />

      <div className="gps-hud">
        <span ref={infoRef}></span>
      </div>

      <GpsConsole nextTurn={isTracking ? nextTurn : null} />
    </div>

    {!isTracking && (
      <div className="gps-extras">
        {/* ======== BADGES CARD ======== */}
        <div className="badges-card">
          <div className="badges-head">
            <div className="badges-title">
              <span role="img" aria-label="medal">🏅</span> Badges Overview
            </div>
          </div>

          <div className="badges-split">
            {/* ===== GOOD BADGES ===== */}
            <div className="badges-group good">
              <div className="group-title">Good Badges to Earn</div>
              <div className="badges-section">
                <div className={`badge-item ${focusedLevel > 0 ? "unlocked" : "locked"}`}>
                  <FaUserShield className="badge-icon" />
                  <div className="badge-label">Focused Driver<br />Level: {focusedLevel}</div>
                </div>
              </div>
              <p className="badge-desc">
                🎯 Stay focused while the camera is on.  
                For every minute your <strong>Risk Index</strong> stays between <strong>0–3</strong>,  
                your <strong>Focused Driver</strong> badge level increases by <strong>+1</strong>.  
                The higher your level, the safer and more consistent your driving!
              </p>
            </div>

            {/* ===== BAD BADGES ===== */}
            <div className="badges-group bad">
              <div className="group-title">Badges to Avoid</div>
              <div className="badges-section">
                <div className={`badge-item ${cautionUnlocked ? "unlocked caution" : "locked"}`}>
                  <FaExclamationTriangle className="badge-icon" />
                  <div className="badge-label">Caution Driver</div>
                </div>

                <div className={`badge-item ${fatiguedUnlocked ? "unlocked fatigued" : "locked"}`}>
                  <FaBed className="badge-icon" />
                  <div className="badge-label">Fatigued Driver</div>
                </div>
              </div>

              <p className="badge-desc caution">
                ⚠️ <strong>Caution Driver</strong> badge unlocks if your risk index reaches <strong>3.0–4.5</strong>.  
                Avoid unlocking this one — staying below this range means you’re keeping your attention steady.
              </p>
              <p className="badge-desc fatigued">
                😴 <strong>Fatigued Driver</strong> badge unlocks if your risk level crosses <strong>4.5+</strong>.  
                This is a serious warning — it means your alertness dropped too low.  
                By <strong>not</strong> unlocking it, you’re proving you’re a safe and responsible driver.
              </p>
            </div>
          </div>
        </div>

        {/* Trip Data Card */}
        <div className="gps-extras">
          <TripSummaryCard
            activeTripId={activeTripId}
            tripIdForExport={activeTripId ?? lastTripId}
            tripSummary={tripSummary}
            isTracking={isTracking}
          />
        </div>
      </div>
    )}
  </div>
);

}
