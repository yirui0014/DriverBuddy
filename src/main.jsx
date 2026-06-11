// src/main.jsx
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import App from "./App.jsx";
import "./index.css";
import Dashboard from "./pages/Dashboard.jsx";
import Landing from "./pages/Landing.jsx";

// Lazy-load GPS page to keep home fast
const Gps = React.lazy(() => import("./pages/Gps.jsx"));

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />   {/* <- NEW landing */}
        <Route
          path="/gps"
          element={
            <React.Suspense fallback={<div style={{ padding: 20 }}>Loading map…</div>}>
              <Gps />
            </React.Suspense>
          }
        />
        <Route path="/dashboard" element={<App><Dashboard /></App>} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
