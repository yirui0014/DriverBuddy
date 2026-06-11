// ============================================================================
// Purpose: Provides face tracking and drowsiness detection capabilities for the
// DriveBuddy application using MediaPipe FaceMesh and Eye Aspect Ratio
// (EAR) analysis. Tracks driver attention, computes risk indices, and
// triggers alerts and trip events in real-time.

import { useEffect, useRef, useState } from "react";
import { FaceMesh } from "@mediapipe/face_mesh";
import { Camera } from "@mediapipe/camera_utils";
import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(import.meta.env.VITE_GEMINI_API_KEY);
const API_BASE = import.meta.env.VITE_BACKEND_URL || "http://localhost:3000";

const CLOSED_THR = 0.10;
const LOW_THR = 0.15;

const PERC_DROWSY_MIN = 0.40;
const AVG_BLINK_DROWSY = 300;
const LBR_DROWSY = 0.25;

const INDEX_ALPHA_UP = 0.70;
const INDEX_ALPHA_DOWN = 0.35;

const GAUGE_BANDS = {
  OK_MAX: 3.0,
  CAUTION_MAX: 4.5,
  HIGH_MAX: 6.0,
};

const clamp01 = (x) => Math.max(0, Math.min(1, x));


/**
* getAlertMessage()
* Generates short, safe, and contextually relevant voice alerts using Gemini.
* @param {string} state - Eye state (e.g., CLOSED or OPEN)
* @returns {Promise<string>} A short driver alert or encouragement message.
*/
async function getAlertMessage(state) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const prompt =
      state === "CLOSED"
        ? "Give a very short, direct safety alert for a drowsy driver. Do NOT use the words 'sleep' or 'pull over'. Prefer phrases like 'take a rest at a nearby rest stop'. Keep it under 12 words."
        : "Give a short encouragement to stay alert while driving. Avoid 'sleep' and 'pull over'; prefer 'rest' and 'take a short break at a nearby rest stop'. Keep it under 12 words.";

    const r = await model.generateContent(prompt);
    let text = (r.response.text() || "Stay alert! Take a rest at a nearby rest stop.").trim();
    text = text.replace(/\bsleep\b/gi, "rest");
    text = text.replace(/\bpull over\b/gi, "go to a nearby rest stop");
    return text;
  } catch {
    return "Stay alert! Take a rest at a nearby rest stop.";
  }
}


/**
* speak()
* Performs text-to-speech (TTS) output using browser SpeechSynthesis.
* @param {string} text - The message to be spoken.
*/
function speak(text) {
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  window.speechSynthesis.speak(u);
}


/**
* useFaceTracker()
* React hook that initializes MediaPipe FaceMesh, monitors blink metrics, and
* calculates driver drowsiness risk index in real time.
* It integrates with the DriveBuddy API to record trip, minute, and alert data.
* @returns {object} { riskIndex, startCamera, stopCamera, hasFace }
*/
export function useFaceTracker() {
  const [riskIndex, setRiskIndex] = useState(0);
  const [hasFace, setHasFace] = useState(false);        // <<< NEW

  const videoRef = useRef(document.createElement("video"));
  const faceMeshRef = useRef(null);
  const cameraRef = useRef(null);

  const prevTsRef = useRef(null);
  const minuteStartRef = useRef(null);
  const totalMsRef = useRef(0);
  const closedMsRef = useRef(0);
  const inBlinkRef = useRef(false);
  const blinkStartRef = useRef(null);
  const validBlinkDurationsRef = useRef([]);
  const longBlinkCountRef = useRef(0);

  const indexEwmaRef = useRef(0);
  const prevIndexRef = useRef(0);

  const closedSince = useRef(null);
  const reopenSince = useRef(null);
  const lastSpoken = useRef(0);
  const alertCount = useRef(0);

  const drowsyCooldownRef = useRef(null);
  const inDrowsyWindowRef = useRef(false);

  const userId = "demo-user";
  const tripIdRef = useRef(null);
  const faceMsRef = useRef(0);          // ms of face present in the current minute
  const minuteAlertRef = useRef(false); // did an alert occur this minute?


  const computeEAR = (lm, idxArr) => {
    const [p1, p2, p3, p4, p5, p6] = idxArr.map((i) => lm[i]);
    const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    return (d(p2, p6) + d(p3, p5)) / (2.0 * d(p1, p4) + 1e-6);
  };
  const LEFT = [33, 160, 158, 133, 153, 144];
  const RIGHT = [362, 385, 387, 263, 373, 380];


  // ===== map risk → band (DB enum uses OK/CAUTION/HIGH/CRITICAL/NO_FACE) =====
  function mapBand(idx) {
    if (idx == null) return "NO_FACE";
    if (idx > GAUGE_BANDS.HIGH_MAX) return "CRITICAL";
    if (idx > GAUGE_BANDS.CAUTION_MAX) return "HIGH";
    if (idx > GAUGE_BANDS.OK_MAX) return "CAUTION";
    return "OK";
  }

   // ===== TRIP HELPERS =====
  async function startTrip() {
    try {
      if (tripIdRef.current) return tripIdRef.current;
      const r = await fetch(`${API_BASE}/api/trips/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId })
      });
      const j = await r.json();
      tripIdRef.current = j.trip_id;
      // 🔵 make trip id globally available for GpsConsole delete button
      window.__drivebuddy_active_trip = j.trip_id;

      window.dispatchEvent(new CustomEvent("drivebuddy:trip-started", { detail: { trip_id: j.trip_id } }));
      return j.trip_id;
    } catch (e) {
      console.error("trip/start failed", e);
    }
  }

  async function stopTrip() {
    try {
      const id = tripIdRef.current;
      if (!id) return;
      const r = await fetch(`${API_BASE}/api/trips/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trip_id: id })
      });
      const j = await r.json();
      window.dispatchEvent(new CustomEvent("drivebuddy:trip-stopped", {
        detail: { trip_id: id, summary: j }
      }));
    } catch (e) {
      console.error("trip/stop failed", e);
    } finally {
      // 🔵 clear global trip id
      window.__drivebuddy_active_trip = null;
      tripIdRef.current = null;
    }
  }

  async function postMinuteAndBroadcast({ risk_index, band, alert_entered, at }) {
    try {
      if (!tripIdRef.current) return;
      const payload = {
        trip_id: tripIdRef.current,
        timestamp: new Date(at || Date.now()).toISOString().slice(0, 19).replace("T", " "),
        lat: null,
        lon: null,
        weather: null,
        risk_index,
        band,
        alert_entered: !!alert_entered
      };
      await fetch(`${API_BASE}/api/trips/minute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      // refresh quick summary for any UI to display
      const rs = await fetch(`${API_BASE}/api/trips/${tripIdRef.current}/summary`);
      const sum = await rs.json();
      window.dispatchEvent(new CustomEvent("drivebuddy:trip-summary", {
        detail: { trip_id: tripIdRef.current, summary: sum }
      }));
    } catch (e) {
      console.error("trip/minute failed", e);
    }
  }

function sqlMalaysiaTime(ts = Date.now()) {
  const d = new Date(ts);
  const kl = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Kuala_Lumpur" }));
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${kl.getFullYear()}-${pad(kl.getMonth() + 1)}-${pad(kl.getDate())} ` +
    `${pad(kl.getHours())}:${pad(kl.getMinutes())}:${pad(kl.getSeconds())}`
  );
}


async function postAlert({ band, risk_index, at }) {
  if (!tripIdRef.current) return;
  try {
    await fetch(`${API_BASE}/api/trips/alert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trip_id: tripIdRef.current,
        occurred_at: sqlMalaysiaTime(at || Date.now()),   // <-- LOCAL time string
        risk_index: (risk_index != null) ? Number(risk_index) : null,
        band
      })
    });
  } catch (e) {
    console.error("trip/alert failed", e);
  }
}


const onResults = async (results) => {
    const now = performance.now();
    if (minuteStartRef.current == null) minuteStartRef.current = now;
    if (prevTsRef.current == null) prevTsRef.current = now;

    let ear = null;
    let eyeState = "NO_FACE";

    // FACE PRESENCE + dt for faceMs counter
    const facePresent = !!(results.multiFaceLandmarks && results.multiFaceLandmarks.length);
    setHasFace(facePresent);

    const dt = now - (prevTsRef.current ?? now);
    prevTsRef.current = now;
    if (facePresent) faceMsRef.current += dt;

    if (facePresent) {
      const lm = results.multiFaceLandmarks[0];
      ear = (computeEAR(lm, LEFT) + computeEAR(lm, RIGHT)) / 2;
      if (ear < CLOSED_THR) eyeState = "CLOSED";
      else if (ear < LOW_THR) eyeState = "LOW";
      else eyeState = "OPEN";

      // EMERGENCY (eyes closed >=2s) — also mark alert for this minute
      if (eyeState === "CLOSED") {
          if (!closedSince.current) closedSince.current = Date.now();

          if (Date.now() - closedSince.current >= 2000) {
            // Speak emergency message immediately after 2s continuous eye closure
            speak(await getAlertMessage(eyeState));
            alertCount.current += 1;

            // Reset timers and flags
            closedSince.current = null;
            minuteAlertRef.current = true;

            // Persist exact timestamped alert
            await postAlert({
              band: "EMERGENCY",
              risk_index: null,
              at: Date.now(),
            });

            // Dispatch event to other components (TripSummary, etc.)
            window.dispatchEvent(
              new CustomEvent("drivebuddy:drowsy", {
                detail: {
                  at: Date.now(),
                  source: "facetracker",
                  index: null,
                  band: "EMERGENCY",
                },
              })
            );
          }
        } else {
          // brief LOW/OPEN blips (<=250 ms) won't reset the 2s CLOSED timer
          if (!reopenSince.current) reopenSince.current = Date.now();
          if (Date.now() - reopenSince.current > 250) {
            closedSince.current = null;
            reopenSince.current = null;
          }
        }
    }

    if (ear != null) {
      totalMsRef.current += dt;
      if (eyeState === "CLOSED") closedMsRef.current += dt;

      if (!inBlinkRef.current && ear < LOW_THR) {
        inBlinkRef.current = true;
        blinkStartRef.current = now;
      }
      if (inBlinkRef.current && ear >= LOW_THR) {
        const dur = now - (blinkStartRef.current ?? now);
        inBlinkRef.current = false;
        blinkStartRef.current = null;
        if (dur >= 80 && dur <= 800) {
          validBlinkDurationsRef.current.push(dur);
          if (dur >= 250) longBlinkCountRef.current += 1;
        }
      }
    }

    if (now - (minuteStartRef.current ?? now) >= 60000) {
      finalizeMinute();
    }
  };

  function triggerRiskAlert(band, idx) {
    // mark that an alert occurred in this minute
    minuteAlertRef.current = true;
    // NEW: persist exact timestamped alert (non-blocking)
    postAlert({ band, risk_index: Number(idx), at: Date.now() });

    window.dispatchEvent(new CustomEvent("drivebuddy:drowsy", {
      detail: { at: Date.now(), source: "facetracker", index: idx, band }
    }));
    inDrowsyWindowRef.current = true;
    clearTimeout(drowsyCooldownRef.current);
    drowsyCooldownRef.current = setTimeout(() => {
      inDrowsyWindowRef.current = false;
    }, 2 * 60 * 1000);
  }

function finalizeMinute() {
    const total = Math.max(1, totalMsRef.current);
    const perclos = Math.min(1, closedMsRef.current / total);

    const durations = validBlinkDurationsRef.current.slice();
    const blinkCount = durations.length;
    const avgBlinkMs = blinkCount ? Math.round(durations.reduce((a, b) => a + b, 0) / blinkCount) : 0;
    const longBlinkRatio = blinkCount ? +(longBlinkCountRef.current / blinkCount).toFixed(2) : 0;

    const perclos_risk = clamp01(perclos / PERC_DROWSY_MIN);
    const blink_risk   = clamp01((avgBlinkMs || 0) / AVG_BLINK_DROWSY);
    const lbr_risk     = clamp01((longBlinkRatio || 0) / LBR_DROWSY);
    const combo = clamp01(0.5 * blink_risk + 0.5 * lbr_risk + 0.5 * (blink_risk * lbr_risk));
    const rawIndex01 = 0.6 * perclos_risk + 0.4 * combo;
    const rawIndex10 = Math.max(0, Math.min(10, rawIndex01 * 10));

    const prev = indexEwmaRef.current;
    const alpha = rawIndex10 >= prev ? INDEX_ALPHA_UP : INDEX_ALPHA_DOWN;
    const ewma = alpha * rawIndex10 + (1 - alpha) * prev;
    indexEwmaRef.current = Math.max(0, Math.min(10, ewma));

    const idx = indexEwmaRef.current;
    setRiskIndex(+idx.toFixed(1));

    if (!inDrowsyWindowRef.current) {
      if (idx > GAUGE_BANDS.HIGH_MAX) {
        triggerRiskAlert("HIGH", idx.toFixed(1));
      } else if (idx > GAUGE_BANDS.CAUTION_MAX) {
        triggerRiskAlert("CAUTION", idx.toFixed(1));
      }
    }

    // === SAVE minute only if face≥30s this minute ===
    if (faceMsRef.current >= 30000) {
      const band = mapBand(idx);
      postMinuteAndBroadcast({
        risk_index: +idx.toFixed(1),
        band,
        alert_entered: minuteAlertRef.current === true,
        at: Date.now()
      });
      // 🔔 Tell the UI what band this *minute* ended in
        window.dispatchEvent(
              new CustomEvent("drivebuddy:minute-band", {
                detail: { band, risk_index: +idx.toFixed(1) }
              })
            );
    }

    // reset per-minute trackers
    totalMsRef.current = 0;
    closedMsRef.current = 0;
    validBlinkDurationsRef.current = [];
    longBlinkCountRef.current = 0;
    minuteAlertRef.current = false;
    faceMsRef.current = 0;
    prevIndexRef.current = idx;
    minuteStartRef.current = performance.now();
  }

  useEffect(() => {
    const fm = new FaceMesh({
      locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}`,
    });
    fm.setOptions({
      selfieMode: true,
      maxNumFaces: 1,
      refineLandmarks: true,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    fm.onResults(onResults);
    faceMeshRef.current = fm;

    return () => {
      try { fm.close(); } catch {}
      stopCamera();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

const startCamera = async () => {
  try {
    const constraints = {
      audio: false,
      video: {
        facingMode: "user",
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, min: 15 },
      },
    };

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: "user" } });
    }

    const v = videoRef.current;
    v.srcObject = stream;
    await v.play();

    // 🟢 Wait for FaceMesh graph to finish loading
    const fm = faceMeshRef.current;
    if (fm && typeof fm.initialize === "function") {
      await fm.initialize(); // only available in newer builds
    } else {
      // fallback delay for older builds
      await new Promise((res) => setTimeout(res, 1000));
    }

    const cam = new Camera(v, {
      onFrame: async () => {
        try {
          await fm.send({ image: v });
        } catch (e) {
          console.warn("FaceMesh frame skipped:", e.message);
        }
      },
      width: 1280,
      height: 720,
    });

    cameraRef.current = cam;
    cam.start();

    // reset trackers on start
    setHasFace(false);
    alertCount.current = 0;
    closedSince.current = null;
    lastSpoken.current = 0;
    prevTsRef.current = null;
    minuteStartRef.current = null;
    totalMsRef.current = 0;
    closedMsRef.current = 0;
    validBlinkDurationsRef.current = [];
    longBlinkCountRef.current = 0;
    indexEwmaRef.current = 0;
    prevIndexRef.current = 0;
    inDrowsyWindowRef.current = false;
    faceMsRef.current = 0;
    minuteAlertRef.current = false;

    // CAMERA ON ⇒ START TRIP
    await startTrip();
  } catch (e) {
    console.error("Camera start failed:", e);
  }
};

  const stopCamera = async () => {
    try {
      cameraRef.current?.stop();
    } catch {}
    const v = videoRef.current;
    if (v && v.srcObject instanceof MediaStream) {
      v.srcObject.getTracks().forEach((t) => t.stop());
      v.srcObject = null;
    }
    setHasFace(false);

    // CAMERA OFF ⇒ STOP TRIP
    await stopTrip();
  };

  return { riskIndex, startCamera, stopCamera, hasFace };
}