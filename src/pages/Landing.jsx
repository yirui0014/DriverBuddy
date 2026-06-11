/**
 * ================================================================
 * File: Landing.jsx
 * Purpose:
 *   Acts as the public entry point for the DriverBuddy web app.
 *   Displays the hero section with app title, tagline, and navigation
 *   buttons to start driving or view the dashboard. Also contains a
 *   Terms & Conditions modal explaining privacy and ethical AI usage.
 *
 * Key Features:
 *   - Animated landing hero with background image.
 *   - Links to “/gps” and “/dashboard”.
 *   - Modal with ACS Code-based ethical design principles.
 *   - Keyboard accessibility (ESC to close modal, focus management).
 *
 * Integration:
 *   Shown as the first page on load, providing navigation to the
 *   primary modules of the DriverBuddy application.
 * ================================================================
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import "./Landing.css";
import bgHero from "../assets/lanfingpage.png";
import logoDB from "../assets/driverbuddy-logo.png";

export default function Landing() {
  const [open, setOpen] = useState(false);
  const closeBtnRef = useRef(null);

  // Close on ESC
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Focus the close button when modal opens (simple a11y)
  useEffect(() => {
    if (open) setTimeout(() => closeBtnRef.current?.focus(), 0);
  }, [open]);

  return (
    <div className="landing">
      <section
        className="landing__hero"
        style={{ backgroundImage: `url(${bgHero})` }}
        aria-label="DriverBuddy landing"
      >
        {/* Logo badge removed to avoid overlap with title */}

        <div className="landing__copy">
          <h1 className="landing__title">DriverBuddy</h1>
          <p className="landing__subtitle">
            Real-time drowsiness detection co‑pilot.
          </p>

          <div className="landing__cta-row">
            <Link to="/gps" className="landing__cta landing__cta--primary">Start Navigation</Link>
            <Link to="/dashboard" className="landing__cta landing__cta--secondary">View Dashboard</Link>
          </div>

          <div className="landing__links">
            <button
              type="button"
              className="landing__link-btn"
              onClick={() => setOpen(true)}
            >
              Terms &amp; Conditions
            </button>
          </div>
        </div>
      </section>

      {/* Features removed per request */}

      {/* Modal */}
      {open && (
        <div
          className="landing__modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="tac-title"
          onClick={(e) => {
            // click outside the card closes
            if (e.target.classList.contains("landing__modal-backdrop")) setOpen(false);
          }}
        >
          <div className="landing__modal-card">
            <div className="landing__modal-content">
            <h2 id="tac-title">Terms &amp; Conditions</h2>
           <p className="landing__modal-text">
            <strong>At DriverBuddy</strong>, we are committed to protecting your safety without compromising your privacy.
            Our system is designed to help drivers stay alert and drive safely through real-time fatigue detection and AI
            assistance — while ensuring full transparency and control over how your data is used.
          </p>

          <p className="landing__modal-text">
            We strictly adhere to the principles of the <strong>Australian Computer Society (ACS) Code of Professional Conduct (v2.1)</strong>,
            particularly the values of <em>Public Interest, Enhancement of Quality of Life, Honesty, Competence,</em> and
            <em> Professionalism</em>. This means prioritizing driver wellbeing, maintaining trust, and protecting
            personal data at all times.
          </p>

          <h3 className="landing__modal-subtitle">1. Camera Use for Real-Time Monitoring Only</h3>
          <p className="landing__modal-text">
            DriverBuddy uses your device’s front-facing camera only during active driving sessions to detect early signs
            of fatigue such as eye closure, yawning, and gaze direction. The camera feed is processed instantly and locally
            on your device using AI-powered image analysis. No video footage, photos, or facial images are ever stored,
            transmitted, or reviewed by DriverBuddy, its developers, or third parties. Once detection is complete, the
            system converts raw data into temporary, anonymized indicators ensuring that no identifiable visual data remains.
          </p>

          <h3 className="landing__modal-subtitle">2. Session-Based Data Handling</h3>
          <p className="landing__modal-text">
            DriverBuddy follows a strict session-based privacy model. All behavioural data are processed locally. These
            data points are stored without any personal identifiers, account links, or facial data, ensuring that they
            cannot be traced back to an individual. DriverBuddy does not collect or maintain unique identifiers, user
            profiles, or biometric images.
          </p>

          <h3 className="landing__modal-subtitle">3. Privacy-First Design Philosophy</h3>
          <p className="landing__modal-text">
            DriverBuddy is built with a privacy-first architecture that ensures safety never comes at the cost of surveillance.
            We do not conduct hidden tracking, background monitoring, or third-party analytics. Every component of our
            system is designed to protect your autonomy and dignity, not to exploit your data. Our ethical AI operates
            transparently — serving as a trusted companion rather than an observer — so you can drive confidently,
            knowing your information remains yours alone.
          </p>  
          </div>

            <div className="landing__modal-actions">
              <button
                ref={closeBtnRef}
                type="button"
                className="landing__close-btn"
                onClick={() => setOpen(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
