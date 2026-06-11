// ============================================================================
// File: index.js
// Purpose: Entry point for DriveBuddy backend agent service. Sets up an Express
// server with REST API endpoints to interact with the DriveBuddy AI
// co-pilot agent. Handles requests for conversation messages and tool
// execution, and integrates CORS + JSON middleware.
// ============================================================================
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mysql from "mysql2/promise";
import { agent } from "./agent.js";
import { restStopTool } from "./tools/restStopTool.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

/** ─────────────── MIDDLEWARE ─────────────── **/
app.use(cors());
app.use(express.json());

/** ─────────────── MySQL CONNECTION POOL ─────────────── **/
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 8,
  queueLimit: 0,
});

async function dbQuery(sql, params = []) {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(sql, params);
    return rows;
  } finally {
    conn.release();
  }
}

/** ─────────────── BASIC + AI ENDPOINTS ─────────────── **/
app.get("/", (_req, res) => res.send("DriveBuddy API is up"));

app.post("/generate", async (req, res) => {
  const { prompt, thread_id } = req.body;
  try {
    const state = await agent.invoke(
      { messages: [{ role: "human", content: prompt }] },
      { configurable: { thread_id } }
    );

    const texts = [];
    for (const m of state?.messages ?? []) {
      const c = m?.content;
      if (typeof c === "string" && c.trim()) texts.push(c.trim());
      else if (Array.isArray(c))
        for (const b of c) {
          const t = (b?.text ?? "").trim();
          if (t) texts.push(t);
        }
      else if (c && typeof c.text === "string" && c.text.trim()) {
        texts.push(c.text.trim());
      }
    }
    const lastText = texts.at(-1) || "I’m here with you—how’s the drive going?";
    res.json({ text: lastText });
  } catch (e) {
    console.error("Agent error:", e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.get("/tools/reststop", async (req, res) => {
  try {
    const { lat, lng, dest_lat, dest_lng } = req.query;
    const result = await restStopTool.func({
      current_lat: Number(lat),
      current_lng: Number(lng),
      destination_lat: dest_lat != null ? Number(dest_lat) : undefined,
      destination_lng: dest_lng != null ? Number(dest_lng) : undefined,
    });
    res.json(result);
  } catch (e) {
    console.error("reststop error:", e);
    res.status(500).json({ error: e?.message || "reststop failed" });
  }
});

/** ─────────────── DATABASE ROUTES ─────────────── **/

// 1) National Trends (adjusted for DB columns like year_2011)
app.get("/api/national-trends", async (_req, res) => {
  try {
    const rows = await dbQuery("SELECT * FROM national_trend_analysis");

    if (!rows || rows.length === 0) return res.json([]);

    // Extract all year columns (like year_2011, year_2012)
    const allKeys = Object.keys(rows[0]);
    const yearKeys = allKeys.filter((k) => /^year_\d{4}$/.test(k));
    const typeKey =
      allKeys.find((k) => k.toLowerCase().includes("accident_injury_type")) ||
      "accident_injury_type";

    // Helper to fetch the value per label-year combo
    const getVal = (label, yearKey) => {
      const row = rows.find(
        (r) => (r[typeKey] || "").trim().toLowerCase() === label.toLowerCase()
      );
      return row && row[yearKey] != null ? Number(row[yearKey]) : 0;
    };

    // Transform into frontend-friendly structure
    const result = yearKeys.map((yearKey) => {
      const year = yearKey.replace("year_", "");
      return {
        year,
        deaths: getVal("Deaths", yearKey),
        fatalAccidents: getVal("Fatal Accidents", yearKey),
        seriousAccidents: getVal("Serious Accidents", yearKey),
        seriousInjuries: getVal("Seriously Injured", yearKey),
        minorAccidents: getVal("Minor Accidents", yearKey),
        minorInjuries: getVal("Lightly Injured", yearKey),
        total: getVal("Total Accidents", yearKey),
      };
    });

    res.json(result);
  } catch (err) {
    console.error("national-trends error:", err);
    res.status(500).json({ error: err.message || "national-trends failed" });
  }
});

// 2) State Treemap
app.get("/api/state-treemap", async (_req, res) => {
  const acc = await dbQuery("SELECT * FROM malaysia_road_accidents_by_state_cleaned");
  const pop = await dbQuery("SELECT * FROM state_population_2019_cleaned");

  const popMap = {};
  pop.forEach((p) => {
    const key = String(p.state ?? p.State ?? "").trim().toUpperCase();
    popMap[key] = Number(p.population ?? p.Population ?? 0);
  });

  const result = acc.map((r) => {
    const state = String(r.State ?? r.state ?? "").trim().toUpperCase();
    const total = Number(r.Total ?? r.total ?? r.total_accidents ?? 0);
    const population = popMap[state] || 1;
    return {
      state,
      accidents_per_100k: (total / population) * 100000,
      total_accidents: total,
      population,
    };
  });

  res.json(result);
});

// 3) Top Causes
app.get("/api/top-causes", async (_req, res) => {
  const rows = await dbQuery("SELECT * FROM accident_causes");
  const slug = (s) => String(s || "").toLowerCase().replace(/\s+/g, "_");
  const mapTips = {
    speeding: "Follow posted limits; use cruise control on highways.",
    risky_driving: "Keep safe following distance; avoid weaving/late merges.",
    fatigue: "Take breaks every 2 hours; avoid night-time drowsy driving.",
  };
  const causes = rows
    .map((r) => {
      const cause = r.Cause ?? r.cause ?? "Unknown";
      const key = slug(cause);
      return {
        cause,
        percentage: Number(r.Percentage ?? r.percentage ?? 0),
        tip: mapTips[key] || "Stay safe and drive responsibly.",
      };
    })
    .sort((a, b) => b.percentage - a.percentage);
  res.json(causes);
});

app.post("/api/top-causes", async (req, res) => {
  const { cause, percentage } = req.body;
  if (!cause) return res.status(400).json({ error: "cause required" });
  await dbQuery(
    "INSERT INTO accident_causes (Cause, Percentage) VALUES (?, ?) ON DUPLICATE KEY UPDATE Percentage=VALUES(Percentage)",
    [cause, Number(percentage ?? 0)]
  );
  res.json({ success: true });
});

// 4) States + Road Type
app.get("/api/states", async (_req, res) => {
  const rows = await dbQuery(
    "SELECT DISTINCT UPPER(TRIM(state)) AS state FROM malaysia_road_accidents_by_state_cleaned"
  );
  res.json(["All Malaysia", ...rows.map((r) => r.state).filter(Boolean)]);
});

app.get("/api/road-type", async (req, res) => {
  try {
    const { state = "All Malaysia" } = req.query;
    const norm = (s) => String(s ?? "").trim().toUpperCase();

    // Columns exactly as per your DB
    const columns = [
      "federal_road",
      "highway",
      "municipal_road",
      "other_roads",
      "state_road"
    ];

    let rows = await dbQuery("SELECT * FROM malaysia_road_accidents_by_state_cleaned");
    if (state !== "All Malaysia") {
      rows = rows.filter((r) => norm(r.state) === norm(state));
    }

    // Aggregate totals for each column
    const agg = {};
    columns.forEach((c) => (agg[c] = 0));
    rows.forEach((r) =>
      columns.forEach((c) => {
        const v = Number(r[c] ?? 0);
        if (!Number.isNaN(v)) agg[c] += v;
      })
    );

    // Prepare response in readable format for charts
    const data = [
      { roadType: "Federal Road", accidents: agg.federal_road },
      { roadType: "Highway", accidents: agg.highway },
      { roadType: "Municipal Road", accidents: agg.municipal_road },
      { roadType: "Other Roads", accidents: agg.other_roads },
      { roadType: "State Road", accidents: agg.state_road },
    ];

    res.json({ state, year: 2019, data });
  } catch (err) {
    console.error("road-type error:", err);
    res.status(500).json({ error: err.message || "road-type failed" });
  }
});

// 5) Fatigue Factors
app.get("/api/fatigue-factors", async (_req, res) => {
  const rows = await dbQuery("SELECT * FROM fatigue_factors");
  const factors = rows
    .map((r) => ({
      rank: Number(r.Rank ?? r.rank ?? 0),
      factor: r.Factor ?? r.factor ?? "",
      percentage: Number(r.Percentage ?? r.percentage ?? 0),
    }))
    .filter((x) => x.factor)
    .sort((a, b) => a.rank - b.rank || b.percentage - a.percentage);
  res.json(factors);
});

app.post("/api/fatigue-factors", async (req, res) => {
  const { rank, factor, percentage } = req.body;
  if (!factor) return res.status(400).json({ error: "factor required" });

  await dbQuery(
    "INSERT INTO fatigue_factors (Rank, Factor, Percentage) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE Rank=VALUES(Rank), Percentage=VALUES(Percentage)",
    [Number(rank ?? 0), factor, Number(percentage ?? 0)]
  );
  res.json({ success: true });
});

// 6) State Ranking
app.get("/api/state-ranking", async (_req, res) => {
  const rows = await dbQuery("SELECT * FROM malaysia_states_ranking_2019_cleaned");
  res.json(rows);
});

// 7) India Causes
app.get("/api/india-causes", async (_req, res) => {
  const rows = await dbQuery("SELECT * FROM india_accident_causes_summary");
  res.json(rows);
});

// ---------- Trip API ----------

// Start a trip (returns trip_id)
app.post("/api/trips/start", async (req, res) => {
  const { user_id = "demo-user" } = req.body || {};
  try {
    const r = await dbQuery(
      "INSERT INTO trip_sessions (user_id, started_at) VALUES (?, CONVERT_TZ(NOW(), '+00:00', '+08:00'))",
      [user_id]
    );
    res.json({ trip_id: r.insertId });
  } catch (e) {
    console.error("trip/start", e);
    res.status(500).json({ error: "Failed to start trip" });
  }
});

// Stop a trip: set ended_at, duration + rollup totals
app.post("/api/trips/stop", async (req, res) => {
  const { trip_id } = req.body || {};
  if (!trip_id) return res.status(400).json({ error: "trip_id required" });
  try {
    await dbQuery(
      "UPDATE trip_sessions SET ended_at = NOW(), duration_min = TIMESTAMPDIFF(MINUTE, started_at, NOW()) WHERE id = ?",
      [trip_id]
    );
    const [agg] = await dbQuery(
      `SELECT 
         COALESCE(SUM(alert_entered = 1), 0) AS total_alerts,
         COALESCE(ROUND(AVG(risk_index), 2), 0) AS avg_risk
       FROM trip_minutes WHERE trip_id = ?`,
      [trip_id]
    );
    await dbQuery(
      "UPDATE trip_sessions SET total_alerts = ?, avg_risk = ? WHERE id = ?",
      [agg?.total_alerts ?? 0, agg?.avg_risk ?? 0, trip_id]
    );
    res.json({ success: true, ...agg });
  } catch (e) {
    console.error("trip/stop", e);
    res.status(500).json({ error: "Failed to stop trip" });
  }
});

app.delete("/api/trips/:id", async (req, res) => {
  const trip_id = Number(req.params.id);
  console.log("[DELETE /api/trips/:id] Received request:", req.params);

  if (!trip_id || Number.isNaN(trip_id)) {
    console.warn("[DELETE] Invalid trip_id:", trip_id);
    return res.status(400).json({ error: "trip_id required" });
  }

  try {
    // Log existence check
    const [exists] = await dbQuery("SELECT id FROM trip_sessions WHERE id = ?", [trip_id]);
    if (!exists) {
      console.warn("[DELETE] No trip found with id:", trip_id);
      return res.status(404).json({ error: "Trip not found" });
    }

    console.log("[DELETE] Deleting trip data for ID:", trip_id);

    // Log number of alerts before delete
    const [alertCount] = await dbQuery(
      "SELECT COUNT(*) AS count FROM trip_alerts WHERE trip_id = ?",
      [trip_id]
    );
    const [minuteCount] = await dbQuery(
      "SELECT COUNT(*) AS count FROM trip_minutes WHERE trip_id = ?",
      [trip_id]
    );
    console.log(`[DELETE] Found ${alertCount.count} alerts, ${minuteCount.count} minutes.`);

    // Delete manually (extra safety even with ON DELETE CASCADE)
    await dbQuery("DELETE FROM trip_alerts WHERE trip_id = ?", [trip_id]);
    await dbQuery("DELETE FROM trip_minutes WHERE trip_id = ?", [trip_id]);
    const result = await dbQuery("DELETE FROM trip_sessions WHERE id = ?", [trip_id]);

    console.log("[DELETE] Deletion result:", result);

    // Check whether deletion actually affected rows
    if (result.affectedRows === 0) {
      console.warn("[DELETE] trip_sessions delete had no effect for id:", trip_id);
    }

    // Verify no remaining data
    const [postAlerts] = await dbQuery(
      "SELECT COUNT(*) AS count FROM trip_alerts WHERE trip_id = ?",
      [trip_id]
    );
    const [postMinutes] = await dbQuery(
      "SELECT COUNT(*) AS count FROM trip_minutes WHERE trip_id = ?",
      [trip_id]
    );
    const [postTrips] = await dbQuery(
      "SELECT COUNT(*) AS count FROM trip_sessions WHERE id = ?",
      [trip_id]
    );

    console.log(`[DELETE] After deletion — alerts: ${postAlerts.count}, minutes: ${postMinutes.count}, sessions: ${postTrips.count}`);

    res.json({
      success: true,
      deleted: {
        trip_id,
        alerts_deleted: alertCount.count,
        minutes_deleted: minuteCount.count,
      },
    });
  } catch (e) {
    console.error("[DELETE] trip/delete failed:", e);
    res.status(500).json({ error: "Failed to delete trip", details: e.message });
  }
});


// Add one minute of trip data
app.post("/api/trips/minute", async (req, res) => {
  const { trip_id, timestamp, lat, lon, weather, risk_index, band, alert_entered } = req.body || {};
  if (!trip_id || !timestamp) return res.status(400).json({ error: "trip_id & timestamp required" });

  try {
    await dbQuery(
      `INSERT INTO trip_minutes (trip_id, timestamp, lat, lon, weather, risk_index, band, alert_entered)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        Number(trip_id),
        new Date(timestamp),
        lat ?? null,
        lon ?? null,
        weather ?? null,
        risk_index != null ? Number(risk_index) : null,
        band ?? 'NO_FACE',
        !!alert_entered
      ]
    );
    res.json({ success: true });
  } catch (e) {
    console.error("trip/minute", e);
    res.status(500).json({ error: "Failed to save minute" });
  }
});

// Create a single alert row
app.post("/api/trips/alert", async (req, res) => {
  const { trip_id, occurred_at, risk_index, band } = req.body || {};
  if (!trip_id || !occurred_at || !band) {
    return res.status(400).json({ error: "trip_id, occurred_at, band required" });
  }
  try {
    await dbQuery(
      `INSERT INTO trip_alerts (trip_id, occurred_at, risk_index, band)
       VALUES (?, ?, ?, ?)`,
      [Number(trip_id), new Date(occurred_at), risk_index ?? null, band]
    );
    res.json({ success: true });
  } catch (e) {
    console.error("trip/alert", e);
    res.status(500).json({ error: "Failed to save alert" });
  }
});

// List alerts for a trip (most recent first)
app.get("/api/trips/:id/alerts", async (req, res) => {
  const trip_id = Number(req.params.id);
  const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
  try {
    const rows = await dbQuery(
      `SELECT id, occurred_at, risk_index, band
         FROM trip_alerts
        WHERE trip_id = ?
        ORDER BY occurred_at DESC
        LIMIT ?`,
      [trip_id, limit]
    );
    res.json(rows);
  } catch (e) {
    console.error("trip/alerts", e);
    res.status(500).json({ error: "Failed to fetch alerts" });
  }
});

// summary should count trip_alerts instead of minutes boolean
app.get("/api/trips/:id/summary", async (req, res) => {
  const trip_id = Number(req.params.id);
  try {
    const [agg] = await dbQuery(
      `SELECT
         (SELECT COUNT(*) FROM trip_alerts WHERE trip_id = ?) AS total_alerts,
         COALESCE(ROUND(AVG(risk_index), 2), 0) AS avg_risk
       FROM trip_minutes
       WHERE trip_id = ?`,
      [trip_id, trip_id]
    );
    res.json(agg || { total_alerts: 0, avg_risk: 0 });
  } catch (e) {
    console.error("trip/summary", e);
    res.status(500).json({ error: "Failed to fetch summary" });
  }
});

// Get active (open) trip for a user (optional helper)
app.get("/api/trips/active", async (req, res) => {
  const user_id = req.query.user_id || "demo-user";
  try {
    const rows = await dbQuery(
      "SELECT * FROM trip_sessions WHERE user_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1",
      [user_id]
    );
    res.json(rows[0] || null);
  } catch (e) {
    console.error("trip/active", e);
    res.status(500).json({ error: "Failed to fetch active trip" });
  }
});

const LOCAL_TZ = process.env.LOCAL_TZ || "Asia/Kuala_Lumpur";

// Format a JS Date in LOCAL_TZ as "YYYY-MM-DD HH:mm"
function fmtLocal(d) {
  if (!d) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: LOCAL_TZ, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit"
  }).formatToParts(d);
  const m = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${m.year}-${m.month}-${m.day} ${m.hour}:${m.minute}`;
}

// Parse MySQL "YYYY-MM-DD HH:mm[:ss]" as a *local* Date (no TZ math)
function parseSqlNaiveLocal(sql) {
  if (!sql) return null;
  const m = String(sql).match(
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/
  );
  if (!m) return new Date(sql); // fallback
  const [, Y, M, D, h, mi, s] = m;
  return new Date(
    Number(Y), Number(M) - 1, Number(D),
    Number(h), Number(mi), s ? Number(s) : 0, 0
  );
}


app.get("/api/trips/:id/report", async (req, res) => {
  const trip_id = Number(req.params.id);
  if (!trip_id) return res.status(400).json({ error: "trip_id required" });

  try {
    const [core] = await dbQuery(
      `SELECT 
         ts.started_at,
         ts.ended_at,
         COALESCE(ROUND(AVG(tm.risk_index), 2), 0) AS avg_risk,
         COALESCE(ROUND(MAX(tm.risk_index), 2), 0) AS max_risk
       FROM trip_sessions ts
       LEFT JOIN trip_minutes tm ON tm.trip_id = ts.id
       WHERE ts.id = ?
       GROUP BY ts.id`,
      [trip_id]
    );
    if (!core) return res.status(404).json({ error: "trip not found" });

    const [{ total_alerts }] = await dbQuery(
      `SELECT COUNT(*) AS total_alerts FROM trip_alerts WHERE trip_id = ?`,
      [trip_id]
    );
    const alerts = await dbQuery(
      `SELECT occurred_at, band, risk_index
         FROM trip_alerts
        WHERE trip_id = ?
        ORDER BY occurred_at ASC`,
      [trip_id]
    );

    // Use local wall-clock for both ends of the subtraction:
    const startedLocal = parseSqlNaiveLocal(core.started_at);
    const exportedLocal = new Date(); // local

    const durationSec = Math.max(0, Math.floor((exportedLocal - startedLocal) / 1000));

    const fmtHMS = (s) => {
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = s % 60;
      const parts = [];
      if (h) parts.push(`${h}h`);
      if (m || h) parts.push(`${m}m`);
      parts.push(`${sec}s`);
      return parts.join(" ");
    };

    res.json({
      meta: {
        // raw from DB (for debugging) + formatted LOCAL strings for UI
        started_at: core.started_at,
        started_at_local: fmtLocal(startedLocal),
        ended_at: core.ended_at,
        ended_at_local: core.ended_at ? fmtLocal(parseSqlNaiveLocal(core.ended_at)) : null,
        exported_at: exportedLocal.toISOString(),
        exported_at_local: fmtLocal(exportedLocal),
        duration_seconds: durationSec,
        duration_hms: fmtHMS(durationSec),
      },
      metrics: {
        total_alerts,
        avg_risk: Number(core.avg_risk || 0),
        max_risk: Number(core.max_risk || 0),
      },
      alerts: alerts.map(a => ({
        ...a,
        occurred_at_local: fmtLocal(parseSqlNaiveLocal(a.occurred_at)),
      })),
    });
  } catch (e) {
    console.error("trip/report", e);
    res.status(500).json({ error: "Failed to build trip report" });
  }
});




/** ─────────────── START SERVER ─────────────── **/
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
