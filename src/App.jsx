// src/App.jsx
import "./App.css";
import VoiceChat from "./components/VoiceChat.jsx";
import { Link, useLocation } from "react-router-dom";
import logo from "./assets/driverbuddy-logo.png"; 

export default function App({ children }) {
  const location = useLocation();
  const isDashboard = location.pathname === "/dashboard";

  return (
    <div className="app-shell">
      {/* Shared Navbar */}
      <header className="app-header">
        <div className="app-header-left">
          <Link to="/" className="nav-btn brand-btn" aria-label="Go to landing">
            <img src={logo} alt="DriveBuddy" className="app-logo" />
          </Link>
          <h1 className="app-title">DriverBuddy</h1>
        </div>
        <nav className="app-nav">
          <Link to="/gps" className="nav-btn">
            Navigation
          </Link>
        </nav>
      </header>

      {/* Content switches layout depending on page */}
      {isDashboard ? (
        // Dashboard manages its own layout via Dashboard.css
        <div className="dashboard-wrapper">{children}</div>
      ) : (
        <main className="home-layout">
          {children || (
            <aside className="side">
              <section className="card timer-card">
                <VoiceChat.TimerPanel />
              </section>
              <section className="card voice-card">
                <VoiceChat.Controls />
              </section>
            </aside>
          )}
        </main>
      )}
    </div>
  );
}
