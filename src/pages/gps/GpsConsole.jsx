/**
 * ================================================================
 * File: GpsConsole.jsx
 * Purpose:
 *   Displays the live in-drive console including:
 *   - Upcoming turn direction and distance.
 *   - Real-time fatigue level indicator (based on risk index).
 *   - Camera and voice-chat controls.
 *   - System status indicators with tooltip legend.
 *   - Confirmation modal for ending or deleting trip data.
 *
 * Dependencies:
 *   - useFaceTracker() hook: provides face detection and risk metrics.
 *   - VoiceChat.MicOnly component for audio interaction.
 *   - CSS: gpsConsole.css for layout and visuals.
 *
 * Integration:
 *   Used inside Gps.jsx as the right-side HUD panel
 *   providing driver feedback and system control.
 * ================================================================
 */
import { useFaceTracker } from "../../components/FaceTracker.jsx";
import { useState, useMemo } from "react";
import "../gps/gpsConsole.css";
import VoiceChat from "../../components/VoiceChat.jsx";

const API_BASE = import.meta.env.VITE_BACKEND_URL || "http://localhost:3000";

/* --- Small inline SVG icon set --- */
function IconLeft({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#3b82f6" aria-label="Turn left">
      <path d="M14.5 5l-6 6 6 6v-4h6v-4h-6V5z" />
    </svg>
  );
}
function IconRight({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#3b82f6" aria-label="Turn right">
      <path d="M9.5 19l6-6-6-6v4h-6v4h6v4z" />
    </svg>
  );
}
function IconStraight({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#3b82f6" aria-label="Go straight">
      <path d="M12 2l5 7h-3v13h-4V9H7l5-7z" />
    </svg>
  );
}
function IconUTurn({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#3b82f6" aria-label="U-turn">
      <path d="M12 3a7 7 0 00-7 7v11h4V10a3 3 0 116 0v11h4V10a7 7 0 00-7-7z" />
    </svg>
  );
}
/** Simple roundabout glyph with exit number badge */
function IconRoundabout({ exit = 2, size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-label={`Roundabout exit ${exit}`}>
      <circle cx="24" cy="24" r="14" fill="none" stroke="#3b82f6" strokeWidth="5" />
      {/* small break showing the exit at ~45deg */}
      <path d="M33.5 14.5 L38 10" stroke="#3b82f6" strokeWidth="5" strokeLinecap="round"/>
      {/* exit arrow */}
      <path d="M34 14 L44 10" stroke="#3b82f6" strokeWidth="5" strokeLinecap="round"/>
      {/* badge */}
      <circle cx="10" cy="10" r="8" fill="#3b82f6"/>
      <text x="10" y="13" textAnchor="middle" fontSize="11" fontWeight="700" fill="white">{exit}</text>
    </svg>
  );
}

export default function GpsConsole({ nextTurn}) {
  const { riskIndex, startCamera, stopCamera, hasFace } = useFaceTracker();
  const [cameraActive, setCameraActive] = useState(false);
  const [showTripDeletePrompt, setShowTripDeletePrompt] = useState(false);

  // toggleCamera with prompt logic
  const toggleCamera = async () => {
    if (cameraActive) {
      // Camera is ON → prompt before stopping
      setShowTripDeletePrompt(true);
    } else {
      await startCamera();
      setCameraActive(true);
    }
  };

 // helper to delete current trip
  const handleDeleteTrip = async () => {
    try {
      const activeTrip = window?.__drivebuddy_active_trip;
      if (!activeTrip) {
        setShowTripDeletePrompt(false);
        await stopCamera();
        setCameraActive(false);
        return;
      }
      await fetch(`${API_BASE}/api/trips/${activeTrip}`, { method: "DELETE" });
      // ✅ tell the app a trip was deleted
      window.dispatchEvent(new CustomEvent("drivebuddy:trip-deleted", { detail: { trip_id: activeTrip } }));

      alert("Trip data deleted.");
      window.dispatchEvent(
        new CustomEvent("drivebuddy:trip-stopped", {
          detail: { summary: { total_alerts: 0, avg_risk: 0 } },
        })
      );
    } catch (e) {
      console.error("Failed to delete trip:", e);
      alert("Failed to delete trip data.");
    } finally {
      await stopCamera();
      setCameraActive(false);
      setShowTripDeletePrompt(false);
    }
  };

  const handleKeepData = async () => {
    await stopCamera();
    setCameraActive(false);
    setShowTripDeletePrompt(false);
  };


  const getCircleColor = () => {
    if (riskIndex <= 3) return "#16a34a";
    if (riskIndex <= 4.5) return "#facc15";
    if (riskIndex <= 6) return "#fb923c";
    return "#ef4444";
  };

  const { dotClass } = useMemo(() => {
    if (!cameraActive) return { dotClass: "dot-red" };
    if (hasFace) return { dotClass: "dot-green" };
    return { dotClass: "dot-yellow" };
  }, [cameraActive, hasFace]);

  const renderIcon = (t) => {
    if (!t) return null;
    switch (t.kind) {
      case "left":
      case "slight-left":
        return <IconLeft />;
      case "right":
      case "slight-right":
        return <IconRight />;
      case "straight":
        return <IconStraight />;
      case "uturn":
        return <IconUTurn />;
      case "roundabout":
        return <IconRoundabout exit={t.exit ?? 2} />;
      default:
        return <IconStraight />;
    }
  };

  return (
    <>
      <div className="gps-console">
        {/* Left: turn banner */}
        {nextTurn && (
          <div className="turn-indicator">
            <div className="turn-icon">{renderIcon(nextTurn)}</div>
            <div className="turn-text">
              <div className="turn-instruction">{nextTurn.label}</div>
              <div className="turn-distance">{nextTurn.distance}m</div>
            </div>
          </div>
        )}

        {/* Center gauge */}
        <div className="fatigue-circle" style={{ borderColor: getCircleColor() }}>
          <span className="fatigue-label">Drowsy</span>
          <span className="fatigue-label">Level</span>
          <span className="fatigue-value">{riskIndex.toFixed(1)}/10</span>
        </div>

        {/* Right side icons */}
        <div className="gps-console-right">
          <div className="icon-row">
            <VoiceChat.MicOnly />
            <button
              className="icon-btn cam-btn"
              onClick={toggleCamera}
              style={{ backgroundColor: cameraActive ? "#16a34a" : "#dc2626" }}
              title={cameraActive ? "Camera On (click to stop)" : "Camera Off (click to start)"}
            >
              📷
            </button>
          </div>

          <div className="sys-indicator">
            <span className={`status-dot ${dotClass}`} />
            <span className="sys-text">DriverBuddy System Active</span>
            <div className="tooltip">
              <p><span className="legend-dot dot-green"></span> Camera on & face detected</p>
              <p><span className="legend-dot dot-yellow"></span> Camera on & no face detected</p>
              <p><span className="legend-dot dot-red"></span> Camera off</p>
            </div>
          </div>
        </div>
      </div>

      {/* 🔔 Confirmation Modal */}
      {showTripDeletePrompt && (
        <div className="report-modal-backdrop" onClick={() => setShowTripDeletePrompt(false)}>
          <div className="report-modal" onClick={(e) => e.stopPropagation()}>
            <div className="report-head">
              <h3>End Trip</h3>
              <button onClick={() => setShowTripDeletePrompt(false)}>✕</button>
            </div>
            <div className="report-body">
              <p>Do you want to retain trip data for report generation or delete it?</p>
            </div>
            <div className="report-foot">
              <button onClick={handleKeepData}>Keep Data</button>
              <button
                style={{ background: "#ef4444", color: "white" }}
                onClick={handleDeleteTrip}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
