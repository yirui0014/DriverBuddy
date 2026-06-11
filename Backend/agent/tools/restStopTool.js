// ============================================================================
// File: restStopTool.js
// Purpose: Defines the 'findRestStop' LangChain tool for DriveBuddy. It searches
// for nearby rest stops such as petrol stations, R&R areas, and
// parking lots based on the driver’s current GPS coordinates.
// The tool uses SERP API for Google Maps local results, calculates
// proximity using the Haversine formula, and optionally estimates
// driving times with Google Distance Matrix API.
// ============================================================================
import z from "zod";
import { tool } from "@langchain/core/tools";

const SERP = "https://serpapi.com/search.json";

/**
* Calculate the Haversine distance (in meters) between two lat/lon points.
* @param {{lat:number, lng:number}} a - Starting coordinate.
* @param {{lat:number, lng:number}} b - Destination coordinate.
* @returns {number} Distance in meters.
*/
function haversine(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s1 =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(s1), Math.sqrt(1 - s1));
  return R * c;
}

/**
* Fetch driving duration (in seconds) between two coordinates using Google
* Distance Matrix API.
* @param {{apiKey:string, origin:{lat:number,lng:number}, dest:{lat:number,lng:number}}} params
* @returns {Promise<number|null>} Duration in seconds or null if unavailable.
*/
async function getDriveTime({ apiKey, origin, dest }) {
  const u = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
  u.searchParams.set("key", apiKey);
  u.searchParams.set("mode", "driving");
  u.searchParams.set("departure_time", "now");
  u.searchParams.set("origins", `${origin.lat},${origin.lng}`);
  u.searchParams.set("destinations", `${dest.lat},${dest.lng}`);

  try {
    const r = await fetch(u.toString());
    const j = await r.json().catch(() => ({}));
    const el = j?.rows?.[0]?.elements?.[0] || {};
    return el?.duration_in_traffic?.value ?? el?.duration?.value ?? null;
  } catch (e) {
    console.error("[findRestStop] Error fetching drive time:", e);
    return null;
  }
}

/**
* LangChain tool: findRestStop
* Searches for nearby rest stops within 10 km using SERP API and ranks them by
* weighted score considering distance, driving time, and rest type priority.
* @param {object} input - Includes current latitude and longitude.
* @returns {Promise<object>} - Ranked list of nearby rest options.
*/
export const restStopTool = tool(
  async ({ current_lat, current_lng }) => {
    console.log("[findRestStop] called with:", { current_lat, current_lng });

    const apiKeySerp = process.env.SERPAPI_KEY;
    const gmKey = process.env.VITE_GOOGLE_MAPS_API_KEY || process.env.GMAPS_KEY;
    if (!apiKeySerp) {
      return {
        found: false,
        error: "SERPAPI_KEY missing",
        tts: "Maps key missing, but don’t worry—I’ll keep talking with you to help stay alert.",
      };
    }
    if (!gmKey) {
      console.warn("[findRestStop] ⚠️ No Google Maps API key, using distance only");
    }

    const here = { lat: current_lat, lng: current_lng };
    const categories = [
      { query: "petrol station", weight: 1.0 },
      { query: "R&R OR rest stop", weight: 0.8 },
      { query: "parking lot", weight: 0.6 },
    ];

    const allCandidates = [];

    for (const cat of categories) {
      console.log(`[findRestStop] Searching category: ${cat.query}`);

      const url = `${SERP}?engine=google_maps&hl=en&gl=my&ll=@${current_lat},${current_lng},15z&q=${encodeURIComponent(
        cat.query
      )}&api_key=${apiKeySerp}`;

      const resp = await fetch(url);
      const data = await resp.json().catch(() => ({}));
      const rows = data.local_results || data.places || [];

      const items = (rows || [])
        .map((r) => {
          const gps = r.gps_coordinates || {};
          const lat = Number(gps.latitude);
          const lng = Number(gps.longitude);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
          const dist_m = haversine(here, { lat, lng });
          return {
            name: r.title || r.name || "Unknown",
            address: r.address || "",
            lat,
            lng,
            dist_m,
            type: cat.query,
            weight: cat.weight,
          };
        })
        .filter(Boolean)
        .filter((x) => x.dist_m <= 10000) // only within 10km
        .sort((a, b) => a.dist_m - b.dist_m)
        .slice(0, 2); // top 2 per category

      allCandidates.push(...items);
    }

    if (!allCandidates.length) {
      const tts =
        "I couldn’t find a safe place to stop within 10 kilometers, but don’t worry—I’m here to chat with you for two minutes to keep you alert.";
      console.warn("[findRestStop] No nearby rest options found");
      return { found: false, error: "No nearby rest options", tts };
    }

    // 🚗 Fetch driving times for each candidate
    if (gmKey) {
      for (const c of allCandidates) {
        const dur = await getDriveTime({
          apiKey: gmKey,
          origin: here,
          dest: { lat: c.lat, lng: c.lng },
        });
        c.duration_s = dur ?? null;
      }
    }

    // Normalize distance + time
    const maxDist = Math.max(...allCandidates.map((c) => c.dist_m));
    const maxTime = Math.max(
      ...allCandidates.map((c) => c.duration_s || c.dist_m / 15)
    );

    allCandidates.forEach((c) => {
      const normDist = c.dist_m / maxDist;
      const normTime = (c.duration_s ?? c.dist_m / 15) / maxTime;
      c.score = 0.6 * normTime + 0.4 * normDist - c.weight * 0.1;
    });

    allCandidates.sort((a, b) => a.score - b.score);
    console.log("[findRestStop] Final ranked list:", allCandidates);

    const best = allCandidates[0];
    console.log("[findRestStop] Best candidate selected:", best);

    return {
      found: true,
      best,
      topList: allCandidates,
      tts: `Best rest option is ${best.name}, about ${(best.dist_m / 1000).toFixed(
        1
      )} km away, approx ${Math.round(
        (best.duration_s ?? best.dist_m / 15) / 60
      )} minutes drive. Shall I reroute you there?`,
    };
  },
  {
    name: "findRestStop",
    description:
      "Find rest stops (petrol, R&R, parking) near user, weighted by priority (petrol > R&R > parking). Uses distance and driving time.",
    schema: z.object({
      current_lat: z.number(),
      current_lng: z.number(),
      destination_lat: z.number().optional(),
      destination_lng: z.number().optional(),
    }),
  }
);
