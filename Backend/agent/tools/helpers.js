// ============================================================================
// File: helpers.js
// Purpose: Provides core utility functions for geolocation parsing, ISO time
// manipulation, weather data fetching (Open-Meteo), and Google
// Maps-based geocoding for DriveBuddy’s AI backend.
// These functions support DriveBuddy’s AI agent and weather tools.
// ============================================================================


/** ---------------------------------------------------------------------------
* Parse a [GEO: lat=... lon=...] tag from a text string and return coordinates.
* @param {string} text - Input text containing a [GEO] tag.
* @returns {{lat:number, lon:number} | null}
*/
export function parseGeoTag(text = "") {
  const m = text.match(/\[GEO:\s*lat=([+-]?\d+(\.\d+)?)\s+lon=([+-]?\d+(\.\d+)?)\s*]/i);
  return m ? { lat: Number(m[1]), lon: Number(m[3]) } : null;
}

/** ---------------------------------------------------------------------------
* Normalize a local time string to the nearest hour ISO (UTC format).
* Example: “2024-10-10 12:34” → “2024-10-10T13:00”.
*/
export function toNearestHourIso(localIso) {
  try {
    const d = new Date(localIso.replace(" ", "T") + "Z");
    const m = d.getUTCMinutes();
    if (m >= 30) d.setUTCHours(d.getUTCHours() + 1);
    d.setUTCMinutes(0, 0, 0);
    const y = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
    const da = String(d.getUTCDate()).padStart(2, "0");
    const h = String(d.getUTCHours()).padStart(2, "0");
    return `${y}-${mo}-${da}T${h}:00`;
  } catch {
    return localIso.slice(0, 13) + ":00";
  }
}

/** ---------------------------------------------------------------------------
* Add hours to a given ISO hour string (UTC-based) and return updated ISO.
*/  
export function addHoursToIso(localHourIso, hours) {
  const d = new Date(localHourIso + "Z");
  d.setUTCHours(d.getUTCHours() + Number(hours || 0));
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  return `${y}-${m}-${day}T${h}:00`;
}


/** ---------------------------------------------------------------------------
* Find index of the closest timestamp (ISO hour) in a given list.
*/
export function nearestHourIndex(times, wantIso) {
  const target = new Date(wantIso + "Z").getTime();
  let best = 0, bestDiff = Infinity;
  for (let i = 0; i < times.length; i++) {
    const t = new Date(times[i] + "Z").getTime();
    const d = Math.abs(t - target);
    if (d < bestDiff) { bestDiff = d; best = i; }
  }
  return best;
}

// WMO codes describe weather states (used by Open-Meteo).
export const WMO = {
  0: "clear", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
  45: "fog", 48: "rime fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
  56: "freezing drizzle", 57: "freezing drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain",
  66: "freezing rain", 67: "freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow",
  77: "snow grains", 80: "light showers", 81: "showers", 82: "heavy showers",
  85: "snow showers", 86: "heavy snow showers",
  95: "thunderstorm", 96: "thunderstorm (light hail)", 99: "thunderstorm (heavy hail)",
};

/** ---------------------------------------------------------------------------
* Build a short one-line weather summary from numeric parameters.
*/
export function briefLine({ t, feels, cond, windKph, rainMm, rainProb, humidity }) {
  const parts = [];
  if (t != null) parts.push(`${Math.round(t)}°C`);
  parts.push(cond || "conditions");
  if (rainMm != null && rainMm > 0) parts.push(`rain ${rainMm} mm`);
  if (rainProb != null) parts.push(`${rainProb}% chance of rain`);
  if (humidity != null) parts.push(`humidity ${humidity}%`);
  if (windKph != null) parts.push(`wind ${Math.round(windKph)} km/h`);
  if (feels != null && t != null && Math.abs(feels - t) >= 2) parts.push(`feels like ${Math.round(feels)}°C`);
  return parts.join(", ");
}

/** ---------------------------------------------------------------------------
* Use Google Maps Places → Geocoding → Open-Meteo fallback to find coordinates
* of a given location string.
*/
export async  function geocodeWithGoogle(place, hint /* {lat, lon} */) {
  const key = process.env.VITE_GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error("Missing Google Maps API key");

  // 1) Places API (New)
  try {
    const u = "https://places.googleapis.com/v1/places:searchText";
    const body = { textQuery: place, languageCode: "en" };
    if (hint?.lat && hint?.lon) {
      body.locationBias = {
        circle: { center: { latitude: hint.lat, longitude: hint.lon }, radius: 20000 },
      };
    }
    const r = await fetch(u, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location",
      },
      body: JSON.stringify(body),
    });
    if (r.ok) {
      const j = await r.json();
      const p = j?.places?.[0];
      if (p?.location?.latitude != null && p?.location?.longitude != null) {
        return { lat: p.location.latitude, lon: p.location.longitude, name: p.displayName?.text || place, provider: "google-places" };
      }
    }
  } catch (e) { console.warn("[geocode] places error", e); }

  // 2) Geocoding API
  try {
    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("address", place);
    url.searchParams.set("key", key);
    const r = await fetch(url);
    if (r.ok) {
      const j = await r.json();
      const res = j?.results?.[0];
      if (res?.geometry?.location) {
        return { lat: res.geometry.location.lat, lon: res.geometry.location.lng, name: res.formatted_address || place, provider: "google-geocode" };
      }
    }
  } catch (e) { console.warn("[geocode] geocode error", e); }

  // 3) Open-Meteo fallback
  try {
    const geoUrl = new URL("https://geocoding-api.open-meteo.com/v1/search");
    geoUrl.searchParams.set("name", place);
    geoUrl.searchParams.set("count", "1");
    const g = await fetch(geoUrl);
    const gj = await g.json();
    if (g.ok && gj?.results?.length) {
      const r = gj.results[0];
      return { lat: r.latitude, lon: r.longitude, name: r.name || place, provider: "open-meteo-geocode" };
    }
  } catch (e) { console.warn("[geocode] open-meteo error", e); }

  return null;
}

/** ─────────────── Open-Meteo Provider ─────────────── **/
/** ---------------------------------------------------------------------------
* Fetch weather forecast data for a location and time using Open-Meteo API.
*/
export async  function fetchOpenMeteo({ lat, lon, isoLocal, tz = "auto" }) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("timezone", tz);
  url.searchParams.set("forecast_days", "7");
  url.searchParams.set("past_days", "1");
  url.searchParams.set("hourly", "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation,relative_humidity_2m,precipitation_probability");
  url.searchParams.set("current", "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation,relative_humidity_2m,precipitation_probability");

  const r = await fetch(url);
  if (!r.ok) throw new Error(`Open-Meteo error ${r.status}`);
  const j = await r.json();

  const currentLocalIso = j?.current?.time || j?.hourly?.time?.[0];
  const times = j?.hourly?.time || [];
  const idx = nearestHourIndex(times, isoLocal || currentLocalIso);

  return {
    provider: "open-meteo",
    timeIso: times[idx],
    t: j?.hourly?.temperature_2m?.[idx],
    feels: j?.hourly?.apparent_temperature?.[idx],
    windKph: j?.hourly?.wind_speed_10m?.[idx],
    rainMm: j?.hourly?.precipitation?.[idx],
    rainProb: j?.hourly?.precipitation_probability?.[idx],
    humidity: j?.hourly?.relative_humidity_2m?.[idx],
    cond: WMO[j?.hourly?.weather_code?.[idx]] ?? "conditions",
    debug: { url: String(url) },
  };
}

/** ───────────── Current local hour at location (Open-Meteo) ───────────── **/
/** ---------------------------------------------------------------------------
* Helper to get current local hour ISO string for given coordinates.
*/
export async function getCurrentLocalHourIso(lat, lon, tz = "auto") {
  const tempUrl = new URL("https://api.open-meteo.com/v1/forecast");
  tempUrl.searchParams.set("latitude", String(lat));
  tempUrl.searchParams.set("longitude", String(lon));
  tempUrl.searchParams.set("current", "temperature_2m");
  tempUrl.searchParams.set("timezone", tz || "auto");
  const r = await fetch(tempUrl);
  const j = await r.json();
  return j?.current?.time; // "YYYY-MM-DDTHH:00"
}