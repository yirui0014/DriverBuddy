// ============================================================================
// File: weatherRouteTool.js
// Purpose: Defines the route-based weather LangChain tool for DriveBuddy.
// This tool provides weather forecasts along a driving route between
// two locations. It combines Google Directions API (for route steps
// and ETA) with Open-Meteo (for forecast sampling along the route).
// It returns a concise summary covering conditions at multiple points.
// ============================================================================
import { tool } from "@langchain/core/tools";
import z from "zod";
import { parseGeoTag, geocodeWithGoogle, toNearestHourIso, addHoursToIso, getCurrentLocalHourIso, fetchOpenMeteo, briefLine } from "./helpers.js";

/** ─────────────── ROUTE WEATHER TOOL (two locations) ─────────────── **/
/**
* LangChain Tool: weatherRoute
* Retrieves weather forecast along a route between two places.
* - Uses Google Geocoding for coordinates and Google Directions for route steps.
* - Samples weather at multiple route fractions using Open-Meteo.
* - Returns a readable summary of weather conditions along the journey.
* @param {object} input - Includes origin, destination, and optional time.
* @returns {Promise<string>} - A route weather report summary.
*/
export const weatherRouteTool = tool(
  async ({ from, to, isoLocal, relativeHours, raw }) => {
    try {
      if (!from || !to) return "Please provide exactly two locations (origin and destination).";

      // 1) Geocode both ends (bias with current [GEO] if available)
      const hint = raw ? parseGeoTag(raw) : null;
      const origin = await geocodeWithGoogle(from, hint);
      const dest = await geocodeWithGoogle(to, hint);
      if (!origin || !dest) return "I couldn't resolve one of the locations.";

      // 2) If time unspecified, anchor to current local hour at origin
      let baseIso = isoLocal ? toNearestHourIso(isoLocal) : await getCurrentLocalHourIso(origin.lat, origin.lon);
      if (relativeHours) baseIso = addHoursToIso(baseIso, relativeHours);

      // 3) Directions API to get route duration + steps (for sampling)
      const key = process.env.VITE_GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
      const dirUrl = new URL("https://maps.googleapis.com/maps/api/directions/json");
      dirUrl.searchParams.set("origin", `${origin.lat},${origin.lon}`);
      dirUrl.searchParams.set("destination", `${dest.lat},${dest.lon}`);
      dirUrl.searchParams.set("key", key);
      const dirRes = await fetch(dirUrl);
      const dir = await dirRes.json();
      const leg = dir?.routes?.[0]?.legs?.[0];

      let travelSecs = 0;
      let steps = [];
      if (leg) {
        travelSecs = leg.duration?.value || 0;
        steps = Array.isArray(leg.steps) ? leg.steps : [];
      } else {
        console.warn("[weatherRoute] directions missing leg", { url: String(dirUrl), dir });
      }

      // 4) Build sample points along the route (start, 25%, 50%, 75%, end)
      const fractions = [0, 0.25, 0.5, 0.75, 1];
      const samples = [];

      if (steps.length) {
        // Construct cumulative distance array to place fractions accurately
        const dist = steps.map(s => s.distance?.value || 0);
        const cum = [];
        dist.reduce((a, v, i) => (cum[i] = a + v, a + v), 0);
        const total = cum.at(-1) || 1;

        function pointAtFraction(frac) {
          const target = frac * total;
          let i = cum.findIndex(c => c >= target);
          if (i < 0) i = steps.length - 1;
          const step = steps[i];
          const start = step.start_location || { lat: origin.lat, lng: origin.lon };
          const end = step.end_location || { lat: dest.lat, lng: dest.lon };
          const prevCum = i === 0 ? 0 : cum[i - 1];
          const remain = dist[i] || 1;
          const t = Math.max(0, Math.min(1, (target - prevCum) / remain));
          const lat = start.lat + (end.lat - start.lat) * t;
          const lon = start.lng + (end.lng - start.lng) * t;
          return { lat, lon };
        }

        for (const f of fractions) {
          const offsetHrs = (travelSecs / 3600) * f;
          const whenIso = addHoursToIso(baseIso, offsetHrs);
          const p = pointAtFraction(f);
          samples.push({ f, whenIso, ...p });
        }
      } else {
        // Fallback: just origin and destination
        for (const f of fractions) {
          const whenIso = addHoursToIso(baseIso, (travelSecs / 3600) * f);
          const p = f < 1 ? { lat: origin.lat, lon: origin.lon } : { lat: dest.lat, lon: dest.lon };
          samples.push({ f, whenIso, ...p });
        }
      }

      // 5) Fetch weather for each sample
      const wx = [];
      for (const s of samples) {
        const w = await fetchOpenMeteo({ lat: s.lat, lon: s.lon, isoLocal: s.whenIso });
        wx.push({ f: s.f, where: s.f === 0 ? "start" : s.f === 1 ? "destination" : `${Math.round(s.f * 100)}%`, when: w.timeIso, ...w });
      }

      // 6) Destination at arrival time (last sample)
      const destWx = wx[wx.length - 1];

      // Logs for debugging
      console.log("[weatherRoute] query", {
        origin: { name: origin.name, lat: origin.lat, lon: origin.lon },
        dest: { name: dest.name, lat: dest.lat, lon: dest.lon },
        baseIso, travelSecs, samples: samples.length
      });

      // 7) Build concise summary
      const hours = Math.round(travelSecs / 3600);
      let summary = `Route ${origin.name} → ${dest.name}${hours ? ` (~${hours}h)` : ""}.\n`;
      for (const r of wx) {
        summary += `${r.where}: ${briefLine(r)} (${r.when.replace("T"," ")}). `;
      }
      return summary.trim();
    } catch (e) {
      console.error("[weatherRoute] error", e);
      return "Sorry, I couldn't get the route weather.";
    }
  },
  {
    name: "weatherRoute",
    description: `
Weather along a route between two locations (origin → destination).
- Inputs: from, to (exactly two places). Optional isoLocal or relativeHours (e.g., "in 2 hours").
- Uses Google Places/Geocoding to resolve coordinates, Google Directions for route duration and path sampling, and Open-Meteo for weather at each sampled point/time.
- If more than two locations are provided, the assistant should refuse and ask for exactly two.
`,
    schema: z.object({
      from: z.string().describe("Origin place"),
      to: z.string().describe("Destination place"),
      isoLocal: z.string().optional().describe('Local time at origin "YYYY-MM-DDTHH:mm"'),
      relativeHours: z.number().int().optional().describe("If user said 'in N hours'"),
      raw: z.string().optional().describe("Original user text (may contain [GEO] for bias)"),
    }),
  }
);