// ============================================================================
// File: weatherTool.js
// Purpose: Defines the single-location weather LangChain tool for DriveBuddy.
// This tool retrieves current or future weather conditions for a
// specific place or coordinate using Open-Meteo API, optionally
// geocoding place names via Google Maps APIs. The tool supports
// relative hour queries and can use embedded [GEO] tags for bias.
// ============================================================================

import { tool } from "@langchain/core/tools";
import z from "zod";
import { parseGeoTag, geocodeWithGoogle, toNearestHourIso, addHoursToIso, getCurrentLocalHourIso, fetchOpenMeteo, briefLine } from "./helpers.js";

/** ─────────────── SINGLE-LOCATION WEATHER TOOL ─────────────── **/
/**
* LangChain Tool: weather
* Retrieves weather forecast for a single specified location and time.
* - Supports {lat, lon} or a textual place name.
* - If no coordinates are provided, it attempts geocoding.
* - If no time is specified, defaults to the current local hour at location.
* - Outputs a concise weather summary string.
* @param {object} input - Weather query parameters.
* @returns {Promise<string>} - A short weather summary for the location.
*/
export const weatherTool = tool(
  async ({ lat, lon, place, isoLocal, relativeHours, raw }) => {
    try {
      let hint = null;
      if (raw) {
        const tag = parseGeoTag(raw);
        if (tag) { hint = tag; if (lat == null || lon == null) { lat = tag.lat; lon = tag.lon; } }
      }

      let whereLabel = null;
      if ((lat == null || lon == null) && place) {
        const g = await geocodeWithGoogle(place, hint);
        if (g) { lat = g.lat; lon = g.lon; whereLabel = g.name; }
        else return `Sorry, I couldn't find "${place}".`;
      }

      if (lat == null || lon == null) return "I need a location to check the weather.";

      if (isoLocal) isoLocal = toNearestHourIso(isoLocal);
      if (!isoLocal || relativeHours) {
        const baseIso = await getCurrentLocalHourIso(lat, lon);
        isoLocal = relativeHours ? addHoursToIso(baseIso, relativeHours) : baseIso;
      }

      const out = await fetchOpenMeteo({ lat, lon, isoLocal });

      console.log("[weatherTool] query", { provider: out.provider, lat, lon, isoLocal, place: whereLabel || place || null, debugUrl: out.debug?.url });

      const line = briefLine(out);
      const where = whereLabel ? ` in ${whereLabel}` : "";
      const when = out.timeIso?.replace("T", " ");
      return `Forecast${where}: ${line} (${when}).`;
    } catch (e) {
      console.error("[weatherTool] error", e);
      return "Sorry, I couldn't get the weather.";
    }
  },
  {
    name: "weather",
    description: `
Get weather at a location and time.
- Use {lat,lon} when known or parse [GEO: ...] from raw.
- If a place name is provided, set {place}; the tool will geocode via Google (biased to [GEO] if present).
- Time: set isoLocal = "YYYY-MM-DDTHH:mm" (local) or relativeHours = N.
- If nothing is specified, treat as "now".
`,
    schema: z.object({
      lat: z.number().optional(),
      lon: z.number().optional(),
      place: z.string().optional(),
      isoLocal: z.string().optional(),
      relativeHours: z.number().int().optional(),
      raw: z.string().optional(),
    }),
  }
);