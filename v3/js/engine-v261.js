(function initEngineV261(global) {
  "use strict";

  const namespace = global.SolarPlanner = global.SolarPlanner || {};

  const BATTERY_USABLE_KWH = 13.5 * 0.9;
  const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const MONTHLY_DAYLIGHT_HOURS = [9.8, 10.7, 11.9, 13.1, 14.1, 14.6, 14.4, 13.5, 12.3, 11.1, 10.0, 9.5];
  const SYNTHETIC_TEMP_MONTHLY_AVG_F = [47, 50, 55, 60, 67, 75, 81, 80, 75, 66, 55, 48];
  const DEFAULT_MONTHLY_RESERVE_PCT = [50, 50, 30, 30, 20, 20, 20, 20, 20, 30, 50, 50];
  const PEAK_HOURS = new Set([16, 17, 18, 19, 20]);
  const DAY_CHARGING_HOURS = [9, 10, 11, 12, 13, 14, 15];
  const NIGHT_CHARGING_HOURS = [21, 22, 23, 0, 1, 2, 3, 4, 5];
  const POST_PEAK_HOURS = [21, 22, 23];
  const DAY_CHARGING_HOUR_SET = new Set(DAY_CHARGING_HOURS);
  const NIGHT_CHARGING_HOUR_SET = new Set(NIGHT_CHARGING_HOURS);
  const POST_PEAK_HOUR_SET = new Set(POST_PEAK_HOURS);
  const SUMMER_MONTHS = new Set([4, 5, 6, 7, 8]);
  const WINTER_MONTHS = new Set([10, 11, 0, 1]);
  const PEAK_WINDOW_HOURS = [16, 17, 18, 19, 20];
  const PEAK_WINDOW_HOUR_SET = new Set(PEAK_WINDOW_HOURS);
  const BASE_SUMMER_SETPOINT_F = 74;
  const BASE_WINTER_SETPOINT_F = 68;
  const SUMMER_SETPOINT_LOAD_SENSITIVITY_PER_DEG = 0.03;
  const WINTER_SETPOINT_LOAD_SENSITIVITY_PER_DEG = 0.025;
  const POWERWALL3_AC_KW = 11.5;
  const VPP_CREDIT_PER_KW_YEAR = 35;
  const NREL_DEMO_KEY = "DEMO_KEY";
  const NREL_PVWATTS_URL = "https://developer.nrel.gov/api/pvwatts/v8.json";
  const NREL_CACHE_STORAGE_KEY = "solarUpgradeV3.nrelCache.v2";
  const ZIP_COORD_CACHE_STORAGE_KEY = "solarUpgradeV3.zipCoordCache.v1";
  const NREL_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const ZIP_COORD_CACHE_TTL_MS = 180 * 24 * 60 * 60 * 1000;

  const DEFAULT_LOAD_PROFILE_RAW = [1.02, 0.95, 0.91, 0.82, 0.79, 0.83, 0.96, 1.07, 0.96, 0.89, 0.91, 0.99];
  const DEFAULT_SOLAR_PROFILE_RAW = [0.58, 0.66, 0.86, 1.02, 1.12, 1.18, 1.16, 1.08, 0.98, 0.83, 0.64, 0.53];
  const BASE_LOAD_HOURLY_RAW = [
    0.021, 0.019, 0.018, 0.018, 0.018, 0.021,
    0.028, 0.037, 0.043, 0.045, 0.043, 0.041,
    0.040, 0.039, 0.040, 0.044, 0.054, 0.066,
    0.074, 0.078, 0.070, 0.056, 0.042, 0.031
  ];

  const ZIP_YIELD_HINTS = [
    { start: 90000, end: 93599, annualYield: 1850, label: "SoCal inland profile" },
    { start: 93600, end: 96199, annualYield: 1700, label: "NorCal inland profile" },
    { start: 97000, end: 98699, annualYield: 1300, label: "Pacific Northwest profile" },
    { start: 80000, end: 81699, annualYield: 1650, label: "Mountain West profile" },
    { start: 85000, end: 86599, annualYield: 1950, label: "Desert Southwest profile" }
  ];

  const NREL_PROFILE_PARAMS = {
    system_capacity: 1,
    module_type: 1,
    array_type: 1,
    tilt: 20,
    azimuth: 180,
    losses: 14,
    timeframe: "hourly"
  };

  const LOAD_PROFILE = normalizeProfile(DEFAULT_LOAD_PROFILE_RAW);
  const SOLAR_PROFILE = normalizeProfile(DEFAULT_SOLAR_PROFILE_RAW);
  const BASE_LOAD_HOURLY = normalizeProfile(BASE_LOAD_HOURLY_RAW);

  function clamp(n, low, high) {
    return Math.min(high, Math.max(low, n));
  }

  function asFinite(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function normalizeProfile(values) {
    const total = values.reduce((acc, v) => acc + v, 0);
    if (!Number.isFinite(total) || total <= 0) {
      return new Array(values.length).fill(1 / values.length);
    }
    return values.map((v) => v / total);
  }

  function decimalPlaces(value) {
    const asText = String(value);
    if (!asText.includes(".")) return 0;
    return asText.length - asText.indexOf(".") - 1;
  }

  function buildSolarCandidates(minKw, maxKw, stepKw) {
    const precision = Math.min(6, Math.max(decimalPlaces(minKw), decimalPlaces(maxKw), decimalPlaces(stepKw), 3));
    const factor = Math.pow(10, precision);

    const start = Math.round(minKw * factor);
    const end = Math.round(maxKw * factor);
    const inc = Math.round(stepKw * factor);

    if (inc <= 0 || end < start) return [];

    const values = [];
    let guard = 0;
    for (let value = start; value <= end; value += inc) {
      values.push(Number((value / factor).toFixed(precision)));
      guard += 1;
      if (guard > 50000) break;
    }

    const exactMax = Number((end / factor).toFixed(precision));
    if (!values.length) {
      values.push(exactMax);
    } else if (Math.abs(values[values.length - 1] - exactMax) > 1e-9) {
      values.push(exactMax);
    }

    return Array.from(new Set(values)).sort((a, b) => a - b);
  }

  function monthSeason(monthIndex) {
    if (SUMMER_MONTHS.has(monthIndex)) return "summer";
    if (WINTER_MONTHS.has(monthIndex)) return "winter";
    return "shoulder";
  }

  function buildHourRange(startHour, endHour, maxHours) {
    const safeStart = clamp(Math.floor(startHour), 0, 23);
    const safeEnd = clamp(Math.floor(endHour), 0, 23);
    const limit = Math.max(1, Math.floor(maxHours || 24));
    const range = [safeStart];
    let cursor = safeStart;
    while (range.length < limit) {
      if (cursor === safeEnd) break;
      cursor = (cursor + 1) % 24;
      if (range.includes(cursor)) break;
      range.push(cursor);
    }
    return range;
  }

  function inferYieldFromZip(zipRaw) {
    const zipNum = Number(String(zipRaw || "").trim());
    if (!Number.isFinite(zipNum)) {
      return { annualYield: 1700, label: "Default profile" };
    }
    const match = ZIP_YIELD_HINTS.find((entry) => zipNum >= entry.start && zipNum <= entry.end);
    if (match) {
      return {
        annualYield: match.annualYield,
        label: match.label + " (ZIP inference)"
      };
    }
    return { annualYield: 1700, label: "Default profile" };
  }

  function parseZip(zipRaw) {
    const trimmed = String(zipRaw || "").trim();
    return /^\d{5}$/.test(trimmed) ? Number(trimmed) : null;
  }

  function shortHash(text) {
    const asText = String(text || "");
    let hash = 2166136261;
    for (let i = 0; i < asText.length; i += 1) {
      hash ^= asText.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function buildClimateContext(zipRaw, apiKeyRaw) {
    const parsedZip = parseZip(zipRaw);
    if (parsedZip === null) return { ok: false, zipRaw: String(zipRaw || "") };
    const zip = String(parsedZip).padStart(5, "0");
    const userKey = String(apiKeyRaw || "").trim();
    const apiKey = userKey || NREL_DEMO_KEY;
    const keyMode = userKey ? "user_key" : "demo_key";
    const apiKeyHash = shortHash(apiKey);
    const signature = zip + "|" + apiKeyHash;
    const cacheKey = [
      zip,
      "sc" + NREL_PROFILE_PARAMS.system_capacity,
      "mt" + NREL_PROFILE_PARAMS.module_type,
      "at" + NREL_PROFILE_PARAMS.array_type,
      "tilt" + NREL_PROFILE_PARAMS.tilt,
      "az" + NREL_PROFILE_PARAMS.azimuth,
      "loss" + NREL_PROFILE_PARAMS.losses,
      NREL_PROFILE_PARAMS.timeframe,
      apiKeyHash
    ].join("|");
    return { ok: true, zip, apiKey, keyMode, signature, cacheKey };
  }

  function loadJsonStorage(storage, key, fallbackValue) {
    try {
      const raw = storage.getItem(key);
      if (!raw) return fallbackValue;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : fallbackValue;
    } catch (_err) {
      return fallbackValue;
    }
  }

  function saveJsonStorage(storage, key, value) {
    try {
      storage.setItem(key, JSON.stringify(value));
    } catch (_err) {
      // ignore storage failures
    }
  }

  function isValidMonthlyProfile(monthlyProfile) {
    return Array.isArray(monthlyProfile)
      && monthlyProfile.length === 12
      && monthlyProfile.every((v) => Number.isFinite(v) && v >= 0);
  }

  function isValidHourlyByMonth(hourlyByMonth) {
    return Array.isArray(hourlyByMonth)
      && hourlyByMonth.length === 12
      && hourlyByMonth.every((row) => Array.isArray(row)
        && row.length === 24
        && row.every((v) => Number.isFinite(v) && v >= 0));
  }

  function isValidTempHourlyByMonth(hourlyByMonth) {
    return Array.isArray(hourlyByMonth)
      && hourlyByMonth.length === 12
      && hourlyByMonth.every((row) => Array.isArray(row)
        && row.length === 24
        && row.every((v) => Number.isFinite(v)));
  }

  function profileHasPositiveEnergy(profile) {
    if (!profile || !isValidMonthlyProfile(profile.monthlyProfile) || !isValidHourlyByMonth(profile.hourlyByMonth)) {
      return false;
    }
    const monthlyTotal = profile.monthlyProfile.reduce((sum, value) => sum + value, 0);
    const hourlyTotal = profile.hourlyByMonth.reduce((sum, row) => {
      return sum + row.reduce((rowSum, value) => rowSum + value, 0);
    }, 0);
    return Number.isFinite(monthlyTotal)
      && Number.isFinite(hourlyTotal)
      && monthlyTotal > 0
      && hourlyTotal > 0;
  }

  function isValidClimateProfile(profile) {
    return !!profile
      && Number.isFinite(profile.annualKwhPerKw)
      && profile.annualKwhPerKw > 0
      && isValidMonthlyProfile(profile.monthlyProfile)
      && isValidHourlyByMonth(profile.hourlyByMonth)
      && isValidTempHourlyByMonth(profile.tempHourlyFByMonth)
      && profileHasPositiveEnergy(profile)
      && (profile.tempSource === "nrel_tamb" || profile.tempSource === "synthetic_temp_fallback");
  }

  function readClimateCacheStore() {
    return loadJsonStorage(localStorage, NREL_CACHE_STORAGE_KEY, {});
  }

  function writeClimateCacheStore(store) {
    saveJsonStorage(localStorage, NREL_CACHE_STORAGE_KEY, store);
  }

  function readZipCoordCacheStore() {
    return loadJsonStorage(localStorage, ZIP_COORD_CACHE_STORAGE_KEY, {});
  }

  function writeZipCoordCacheStore(store) {
    saveJsonStorage(localStorage, ZIP_COORD_CACHE_STORAGE_KEY, store);
  }

  function getCachedZipCoordEntry(zip) {
    const store = readZipCoordCacheStore();
    const now = Date.now();
    let changed = false;
    Object.keys(store).forEach((key) => {
      const entry = store[key];
      if (!entry || !Number.isFinite(entry.cachedAt) || (now - entry.cachedAt) > ZIP_COORD_CACHE_TTL_MS) {
        delete store[key];
        changed = true;
      }
    });
    if (changed) writeZipCoordCacheStore(store);
    const entry = store[String(zip)];
    if (!entry) return null;
    if (!Number.isFinite(entry.lat) || !Number.isFinite(entry.lon)) return null;
    return entry;
  }

  function putCachedZipCoordEntry(zip, entry) {
    if (!entry || !Number.isFinite(entry.lat) || !Number.isFinite(entry.lon)) return;
    const store = readZipCoordCacheStore();
    store[String(zip)] = {
      lat: entry.lat,
      lon: entry.lon,
      label: entry.label || String(zip),
      cachedAt: Date.now()
    };
    writeZipCoordCacheStore(store);
  }

  function parseZipCoordEntry(rawEntry, fallbackLabel) {
    if (!rawEntry || typeof rawEntry !== "object") return null;
    const lat = Number(rawEntry.lat);
    const lon = Number(rawEntry.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return {
      lat,
      lon,
      label: typeof rawEntry.label === "string" && rawEntry.label.trim() ? rawEntry.label.trim() : fallbackLabel
    };
  }

  function fetchZipCoordinatesFromZippopotam(zip) {
    const url = "https://api.zippopotam.us/us/" + encodeURIComponent(zip);
    return fetch(url, { method: "GET" })
      .then((response) => {
        if (!response.ok) throw { type: "network_error" };
        return response.json().catch(() => {
          throw { type: "parse_error" };
        });
      })
      .then((json) => {
        const place = json && Array.isArray(json.places) ? json.places[0] : null;
        const parsed = parseZipCoordEntry({
          lat: place && place.latitude,
          lon: place && place.longitude,
          label: place
            ? (((place["place name"] || "").trim()) + ", " + (((place["state abbreviation"] || place.state || "").trim())) + " (" + zip + ")")
            : zip
        }, zip);
        if (!parsed) throw { type: "missing_data" };
        return parsed;
      });
  }

  function fetchZipCoordinatesFromCensus(zip) {
    const params = new URLSearchParams({
      benchmark: "Public_AR_Current",
      format: "json",
      zip
    });
    const url = "https://geocoding.geo.census.gov/geocoder/locations/address?" + params.toString();
    return fetch(url, { method: "GET" })
      .then((response) => {
        if (!response.ok) throw { type: "network_error" };
        return response.json().catch(() => {
          throw { type: "parse_error" };
        });
      })
      .then((json) => {
        const matches = json && json.result && Array.isArray(json.result.addressMatches)
          ? json.result.addressMatches
          : [];
        const match = matches[0];
        const coords = match && match.coordinates;
        const parsed = parseZipCoordEntry({
          lat: coords && coords.y,
          lon: coords && coords.x,
          label: match && match.matchedAddress ? (String(match.matchedAddress).trim() + " (" + zip + ")") : zip
        }, zip);
        if (!parsed) throw { type: "missing_data" };
        return parsed;
      });
  }

  function resolveZipCoordinates(zip) {
    const cached = getCachedZipCoordEntry(zip);
    if (cached) {
      return Promise.resolve(parseZipCoordEntry(cached, zip));
    }
    return fetchZipCoordinatesFromZippopotam(zip)
      .catch(() => fetchZipCoordinatesFromCensus(zip))
      .then((coords) => {
        if (!coords) throw { type: "location_lookup_failed" };
        putCachedZipCoordEntry(zip, coords);
        return coords;
      });
  }

  function getCachedClimateEntry(cacheKey) {
    const store = readClimateCacheStore();
    const now = Date.now();
    let changed = false;
    Object.keys(store).forEach((key) => {
      const entry = store[key];
      if (!entry || !Number.isFinite(entry.cachedAt) || (now - entry.cachedAt) > NREL_CACHE_TTL_MS) {
        delete store[key];
        changed = true;
      }
    });
    if (changed) writeClimateCacheStore(store);
    const entry = store[String(cacheKey)];
    if (!entry) return null;
    if (!isValidClimateProfile(entry.profile)) {
      delete store[String(cacheKey)];
      writeClimateCacheStore(store);
      return null;
    }
    return entry;
  }

  function putCachedClimateEntry(cacheKey, entry) {
    if (!entry || !isValidClimateProfile(entry.profile)) return;
    const store = readClimateCacheStore();
    store[String(cacheKey)] = {
      profile: entry.profile,
      locationLabel: entry.locationLabel || "",
      cachedAt: Date.now(),
      lastVerifiedAt: new Date().toISOString(),
      keyMode: entry.keyMode === "user_key" ? "user_key" : "demo_key"
    };
    writeClimateCacheStore(store);
  }

  function buildSyntheticSolarHourlyShape(monthIndex) {
    const daylight = MONTHLY_DAYLIGHT_HOURS[monthIndex] || 12;
    const sunrise = 12 - daylight / 2;
    const sunset = 12 + daylight / 2;
    const sigma = Math.max(1.4, daylight / 4.2);
    const profile = new Array(24).fill(0).map((_, hour) => {
      const center = hour + 0.5;
      if (center < sunrise || center > sunset) return 0;
      const spread = center - 12;
      return Math.exp(-(spread * spread) / (2 * sigma * sigma));
    });
    return normalizeProfile(profile);
  }

  function getSyntheticHourlyByMonthProfiles() {
    return new Array(12).fill(0).map((_, month) => buildSyntheticSolarHourlyShape(month));
  }

  function buildSyntheticTempHourlyShape(monthIndex) {
    const monthAvg = SYNTHETIC_TEMP_MONTHLY_AVG_F[monthIndex] || 65;
    const amplitude = SUMMER_MONTHS.has(monthIndex) ? 14 : (WINTER_MONTHS.has(monthIndex) ? 10 : 12);
    return new Array(24).fill(0).map((_, hour) => {
      const radians = ((hour - 15) / 24) * (2 * Math.PI);
      return monthAvg + Math.cos(radians) * amplitude;
    });
  }

  function getSyntheticTempHourlyByMonthProfiles() {
    return new Array(12).fill(0).map((_, month) => buildSyntheticTempHourlyShape(month));
  }

  function getSyntheticClimateProfile(zipHint) {
    const inferred = inferYieldFromZip(zipHint || "");
    return {
      annualKwhPerKw: inferred.annualYield,
      monthlyProfile: SOLAR_PROFILE,
      hourlyByMonth: getSyntheticHourlyByMonthProfiles(),
      tempHourlyFByMonth: getSyntheticTempHourlyByMonthProfiles(),
      tempSource: "synthetic_temp_fallback"
    };
  }

  function deriveClimateProfileFromHourly(acValues, tambValues) {
    if (!Array.isArray(acValues) || acValues.length < 8760) return null;
    const hourlyTotalsByMonth = new Array(12).fill(0).map(() => new Array(24).fill(0));
    const monthlyTotals = new Array(12).fill(0);
    const monthOffset = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    const tempTotalsByMonth = new Array(12).fill(0).map(() => new Array(24).fill(0));
    const tempCountsByMonth = new Array(12).fill(0).map(() => new Array(24).fill(0));
    const hasTemp = Array.isArray(tambValues) && tambValues.length >= 8760;

    for (let idx = 0; idx < 8760; idx += 1) {
      const dayOfYear = Math.floor(idx / 24);
      const hour = idx % 24;
      let month = 11;
      for (let m = 0; m < 11; m += 1) {
        if (dayOfYear < monthOffset[m + 1]) {
          month = m;
          break;
        }
      }
      const ac = Number(acValues[idx]);
      const acKwh = Number.isFinite(ac) ? Math.max(0, ac / 1000) : 0;
      hourlyTotalsByMonth[month][hour] += acKwh;
      monthlyTotals[month] += acKwh;

      if (hasTemp) {
        const tempC = Number(tambValues[idx]);
        if (Number.isFinite(tempC)) {
          const tempF = (tempC * 9 / 5) + 32;
          tempTotalsByMonth[month][hour] += tempF;
          tempCountsByMonth[month][hour] += 1;
        }
      }
    }

    const syntheticTemp = getSyntheticTempHourlyByMonthProfiles();
    const tempFullyValid = hasTemp && tempCountsByMonth.every((row) => row.every((count) => count > 0));
    const annualKwh = monthlyTotals.reduce((acc, v) => acc + v, 0);
    if (!Number.isFinite(annualKwh) || annualKwh <= 0) return null;
    const tempHourlyFByMonth = tempFullyValid
      ? tempTotalsByMonth.map((row, month) => row.map((total, hour) => {
        const count = tempCountsByMonth[month][hour];
        return count > 0 ? (total / count) : syntheticTemp[month][hour];
      }))
      : syntheticTemp;

    return {
      annualKwhPerKw: annualKwh,
      monthlyProfile: normalizeProfile(monthlyTotals),
      hourlyByMonth: hourlyTotalsByMonth.map((row, idx) => {
        const total = row.reduce((acc, v) => acc + v, 0);
        return total > 0 ? normalizeProfile(row) : buildSyntheticSolarHourlyShape(idx);
      }),
      tempHourlyFByMonth,
      tempSource: tempFullyValid ? "nrel_tamb" : "synthetic_temp_fallback"
    };
  }

  function resolveClimateLocationLabel(json, fallbackLabel) {
    const stationInfo = json && typeof json.station_info === "object" ? json.station_info : null;
    const city = stationInfo && typeof stationInfo.city === "string" ? stationInfo.city.trim() : "";
    const state = stationInfo && typeof stationInfo.state === "string" ? stationInfo.state.trim() : "";
    if (city && state) return city + ", " + state;
    if (city) return city;
    return fallbackLabel;
  }

  function fetchNrelClimateProfile(context, coordinates) {
    const params = new URLSearchParams({
      api_key: context.apiKey,
      lat: String(coordinates.lat),
      lon: String(coordinates.lon),
      system_capacity: String(NREL_PROFILE_PARAMS.system_capacity),
      module_type: String(NREL_PROFILE_PARAMS.module_type),
      array_type: String(NREL_PROFILE_PARAMS.array_type),
      tilt: String(NREL_PROFILE_PARAMS.tilt),
      azimuth: String(NREL_PROFILE_PARAMS.azimuth),
      losses: String(NREL_PROFILE_PARAMS.losses),
      timeframe: NREL_PROFILE_PARAMS.timeframe
    });

    return fetch(NREL_PVWATTS_URL + "?" + params.toString(), { method: "GET" })
      .then((response) => {
        if (!response.ok) throw { type: response.status === 429 ? "rate_limit_429" : "network_error" };
        return response.json().catch(() => {
          throw { type: "parse_error" };
        });
      })
      .then((json) => {
        const acValues = json && json.outputs && Array.isArray(json.outputs.ac) ? json.outputs.ac : null;
        const tambValues = json && json.outputs && Array.isArray(json.outputs.tamb) ? json.outputs.tamb : null;
        const profile = deriveClimateProfileFromHourly(acValues, tambValues);
        if (!profile) throw { type: "missing_data" };
        return {
          profile,
          locationLabel: resolveClimateLocationLabel(json, coordinates.label || context.zip)
        };
      });
  }

  function climateFallbackReason(err) {
    if (err && err.type === "rate_limit_429") return "rate_limit_429";
    if (err && err.type === "location_lookup_failed") return "location_lookup_failed";
    if (err && err.type === "missing_data") return "missing_data";
    if (err && err.type === "parse_error") return "parse_error";
    return "network_error";
  }

  function getClimateProfile(context, options) {
    const opts = options || {};
    const forceRefresh = !!opts.forceRefresh;

    if (!context || !context.ok) {
      const profile = getSyntheticClimateProfile(context && context.zipRaw);
      return Promise.resolve({
        status: "fallback_synthetic",
        fallbackReason: "invalid_zip",
        locationLabel: (context && context.zipRaw) ? String(context.zipRaw) : "ZIP invalid",
        keyMode: "demo_key",
        lastVerifiedAt: null,
        profile
      });
    }

    const cached = getCachedClimateEntry(context.cacheKey);
    if (cached && !forceRefresh) {
      return Promise.resolve({
        status: "verified_cache",
        fallbackReason: null,
        locationLabel: cached.locationLabel || context.zip,
        keyMode: cached.keyMode || context.keyMode,
        lastVerifiedAt: cached.lastVerifiedAt || null,
        profile: cached.profile
      });
    }

    if (typeof fetch !== "function") {
      const profile = getSyntheticClimateProfile(context.zip);
      return Promise.resolve({
        status: "fallback_synthetic",
        fallbackReason: "network_error",
        locationLabel: context.zip,
        keyMode: context.keyMode,
        lastVerifiedAt: null,
        profile
      });
    }

    return resolveZipCoordinates(context.zip)
      .then((coords) => fetchNrelClimateProfile(context, coords)
        .then((result) => {
          putCachedClimateEntry(context.cacheKey, {
            profile: result.profile,
            locationLabel: result.locationLabel,
            keyMode: context.keyMode
          });
          return {
            status: "verified_live",
            fallbackReason: null,
            locationLabel: result.locationLabel || context.zip,
            keyMode: context.keyMode,
            lastVerifiedAt: new Date().toISOString(),
            profile: result.profile
          };
        }))
      .catch((err) => {
        const profile = getSyntheticClimateProfile(context.zip);
        return {
          status: "fallback_synthetic",
          fallbackReason: climateFallbackReason(err),
          locationLabel: context.zip,
          keyMode: context.keyMode,
          lastVerifiedAt: null,
          profile
        };
      });
  }

  function buildHourlyLoadShape(targetPeakShare) {
    const basePeakShare = BASE_LOAD_HOURLY.reduce((acc, v, hour) => acc + (PEAK_HOURS.has(hour) ? v : 0), 0);
    if (basePeakShare <= 0 || basePeakShare >= 1) {
      return BASE_LOAD_HOURLY;
    }

    const constrainedTarget = clamp(targetPeakShare, 0.05, 0.95);
    const peakScale = constrainedTarget / basePeakShare;
    const offScale = (1 - constrainedTarget) / (1 - basePeakShare);
    return normalizeProfile(BASE_LOAD_HOURLY.map((v, hour) => v * (PEAK_HOURS.has(hour) ? peakScale : offScale)));
  }

  function buildSolarHourlyShape(monthIndex, solarHourlyByMonth) {
    if (isValidHourlyByMonth(solarHourlyByMonth) && Array.isArray(solarHourlyByMonth[monthIndex]) && solarHourlyByMonth[monthIndex].length === 24) {
      return normalizeProfile(solarHourlyByMonth[monthIndex].map((v) => Number.isFinite(v) ? Math.max(0, v) : 0));
    }
    return buildSyntheticSolarHourlyShape(monthIndex);
  }

  function getSeasonDailyHvacShiftCapacity(ha, monthIndex, preWindowHours) {
    const summerCap = ha.maxPrecoolOffsetF * ha.hvacSensitivityKwhPerDegHour * preWindowHours;
    const winterCap = ha.maxPreheatOffsetF * ha.hvacSensitivityKwhPerDegHour * preWindowHours;
    const summerRelaxCap = ha.maxPeakRelaxOffsetF * ha.hvacSensitivityKwhPerDegHour * PEAK_WINDOW_HOURS.length;
    const winterRelaxCap = ha.maxPeakRelaxOffsetF * ha.hvacSensitivityKwhPerDegHour * PEAK_WINDOW_HOURS.length;
    const shoulderCap = 0.5 * summerCap + 0.5 * winterCap;
    const shoulderRelaxCap = 0.5 * summerRelaxCap + 0.5 * winterRelaxCap;
    const season = monthSeason(monthIndex);
    const seasonPreCap = season === "summer" ? summerCap : (season === "winter" ? winterCap : shoulderCap);
    const seasonRelaxCap = season === "summer" ? summerRelaxCap : (season === "winter" ? winterRelaxCap : shoulderRelaxCap);
    return Math.max(0, Math.min(ha.maxShiftKwhPerDay, seasonPreCap + seasonRelaxCap));
  }

  function getSeasonLoadMultiplier(loadConfig, monthIndex) {
    const season = monthSeason(monthIndex);
    const summerDelta = loadConfig.summerSetpointF - BASE_SUMMER_SETPOINT_F;
    const winterDelta = BASE_WINTER_SETPOINT_F - loadConfig.winterSetpointF;
    if (season === "summer") return Math.max(0.70, 1 - (summerDelta * SUMMER_SETPOINT_LOAD_SENSITIVITY_PER_DEG));
    if (season === "winter") return Math.max(0.75, 1 + (winterDelta * WINTER_SETPOINT_LOAD_SENSITIVITY_PER_DEG));
    const summerMult = Math.max(0.70, 1 - (summerDelta * SUMMER_SETPOINT_LOAD_SENSITIVITY_PER_DEG));
    const winterMult = Math.max(0.75, 1 + (winterDelta * WINTER_SETPOINT_LOAD_SENSITIVITY_PER_DEG));
    return 0.5 * summerMult + 0.5 * winterMult;
  }

  function getMonthTempProfile(tempHourlyFByMonth, monthIndex) {
    if (isValidTempHourlyByMonth(tempHourlyFByMonth)) {
      return tempHourlyFByMonth[monthIndex];
    }
    return buildSyntheticTempHourlyShape(monthIndex);
  }

  function deriveAutoWhfProfile(tempHourlyFByMonth, summerSetpointF) {
    const successRateByMonth = new Array(12).fill(0.1);
    const autoWindowByMonth = new Array(12).fill(0).map(() => ({
      startMinuteOfDay: (20 * 60) + 30,
      endMinuteOfDay: 6 * 60
    }));
    const autoActiveMonths = [];
    const candidateBandHours = [18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6, 7, 8];

    for (let month = 0; month < 12; month += 1) {
      const monthTemps = getMonthTempProfile(tempHourlyFByMonth, month);
      const days = DAYS_IN_MONTH[month];
      const eligiblePerDay = monthTemps.reduce((sum, tempF) => sum + ((tempF >= 55 && tempF <= 82) ? 1 : 0), 0);
      const monthlyCoolingStress = monthTemps.reduce((sum, tempF) => sum + Math.max(0, tempF - summerSetpointF), 0) / 24;
      const monthlyEligibleHours = eligiblePerDay * days;

      let best = {
        score: Number.NEGATIVE_INFINITY,
        eligibleWindowHours: 0,
        windowHours: 1,
        startHour: 20,
        endHour: 6
      };

      for (let startIdx = 0; startIdx < candidateBandHours.length - 1; startIdx += 1) {
        for (let endIdx = startIdx + 2; endIdx <= candidateBandHours.length; endIdx += 1) {
          const windowHoursList = candidateBandHours.slice(startIdx, endIdx);
          const windowHours = windowHoursList.length;
          const eligibleWindowHours = windowHoursList.reduce((sum, hour) => {
            return sum + ((monthTemps[hour] >= 55 && monthTemps[hour] <= 82) ? 1 : 0);
          }, 0);
          const avgCoolingStress = windowHoursList.reduce((sum, hour) => {
            return sum + Math.max(0, monthTemps[hour] - summerSetpointF);
          }, 0) / Math.max(1, windowHours);
          const score = (eligibleWindowHours * 1.5) + (avgCoolingStress * 0.35);

          if (score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && eligibleWindowHours > best.eligibleWindowHours)) {
            best = {
              score,
              eligibleWindowHours,
              windowHours,
              startHour: windowHoursList[0],
              endHour: (windowHoursList[windowHoursList.length - 1] + 1) % 24
            };
          }
        }
      }

      const successRate = clamp(best.eligibleWindowHours / Math.max(1, best.windowHours), 0.1, 0.95);
      const active = monthlyEligibleHours >= 45 && monthlyCoolingStress >= 0.5;
      successRateByMonth[month] = successRate;
      autoWindowByMonth[month] = {
        startMinuteOfDay: best.startHour * 60,
        endMinuteOfDay: best.endHour * 60
      };
      if (active) autoActiveMonths.push(month);
    }

    return {
      successRateByMonth,
      autoWindowByMonth,
      autoActiveMonths
    };
  }

  function deriveAutoHaProfile(tempHourlyFByMonth, summerSetpointF, winterSetpointF) {
    const successRateByMonth = new Array(12).fill(0.15);
    const autoPreWindowByMonth = new Array(12).fill(0).map(() => ({ startHour: 13, endHour: 16 }));

    for (let month = 0; month < 12; month += 1) {
      const monthTemps = getMonthTempProfile(tempHourlyFByMonth, month);
      const coolingStress = monthTemps.reduce((sum, tempF) => sum + Math.max(0, tempF - summerSetpointF), 0) / 24;
      const heatingStress = monthTemps.reduce((sum, tempF) => sum + Math.max(0, winterSetpointF - tempF), 0) / 24;
      const stressIndex = clamp((coolingStress + heatingStress) / 8, 0, 1);
      successRateByMonth[month] = clamp(0.15 + (stressIndex * 0.8), 0.15, 0.95);

      if (coolingStress > (heatingStress * 1.1)) {
        autoPreWindowByMonth[month] = { startHour: 12, endHour: 16 };
      } else if (heatingStress > (coolingStress * 1.1)) {
        autoPreWindowByMonth[month] = { startHour: 11, endHour: 15 };
      } else {
        autoPreWindowByMonth[month] = { startHour: 13, endHour: 16 };
      }
    }

    return {
      successRateByMonth,
      autoPreWindowByMonth
    };
  }

  function getHvacShiftPlan(dayInput, loadShape) {
    const empty = {
      schedulePreByHour: new Array(24).fill(0),
      schedulePostByHour: new Array(24).fill(0),
      totalCapacityKwh: 0,
      totalScheduledKwh: 0,
      totalExecutedKwh: 0,
      totalShiftToPreKwh: 0,
      totalShiftToPostKwh: 0,
      totalPeakImportAvoidedKwh: 0
    };
    if (!dayInput.haEnabled || !dayInput.ha || dayInput.haSuccessRate <= 0) return empty;

    const preCandidate = buildHourRange(dayInput.haPreCoolStartHour, dayInput.haPreCoolEndHour, 24);
    const preHours = preCandidate.slice(0, Math.max(0, dayInput.haMaxShiftHoursPerDay));
    if (!preHours.length) return empty;

    const dailyCapacityKwh = getSeasonDailyHvacShiftCapacity(dayInput.ha, dayInput.monthIndex, preHours.length);
    if (dailyCapacityKwh <= 0) return empty;

    const successFactor = clamp(dayInput.haSuccessRate, 0, 1);
    const executedShiftKwh = dailyCapacityKwh * successFactor;

    const schedulePreByHour = new Array(24).fill(0);
    const schedulePostByHour = new Array(24).fill(0);

    const peakWeights = PEAK_WINDOW_HOURS.map((hour) => loadShape[hour]);
    const peakWeightTotal = peakWeights.reduce((acc, v) => acc + v, 0) || 1;
    let shiftRemaining = executedShiftKwh;
    PEAK_WINDOW_HOURS.forEach((hour, idx) => {
      if (shiftRemaining <= 0) return;
      const portion = executedShiftKwh * (peakWeights[idx] / peakWeightTotal);
      const shift = Math.min(shiftRemaining, portion);
      schedulePostByHour[hour] = -shift;
      shiftRemaining -= shift;
    });

    const preWeights = preHours.map((hour) => loadShape[hour]);
    const preWeightTotal = preWeights.reduce((acc, v) => acc + v, 0) || 1;
    let assignRemaining = executedShiftKwh;
    preHours.forEach((hour, idx) => {
      if (assignRemaining <= 0) return;
      const portion = executedShiftKwh * (preWeights[idx] / preWeightTotal);
      const shift = Math.min(assignRemaining, portion);
      schedulePreByHour[hour] += shift;
      assignRemaining -= shift;
    });

    const totalPost = schedulePostByHour.reduce((acc, v) => acc + Math.abs(v), 0);
    const totalPre = schedulePreByHour.reduce((acc, v) => acc + v, 0);

    return {
      schedulePreByHour,
      schedulePostByHour,
      totalCapacityKwh: dailyCapacityKwh,
      totalScheduledKwh: dailyCapacityKwh,
      totalExecutedKwh: executedShiftKwh,
      totalShiftToPreKwh: totalPre,
      totalShiftToPostKwh: totalPost,
      totalPeakImportAvoidedKwh: totalPost
    };
  }

  function minuteInWindow(minuteOfDay, startMinuteOfDay, endMinuteOfDay) {
    const start = ((startMinuteOfDay % 1440) + 1440) % 1440;
    const end = ((endMinuteOfDay % 1440) + 1440) % 1440;
    const minute = ((minuteOfDay % 1440) + 1440) % 1440;
    if (start === end) return true;
    if (start < end) return minute >= start && minute < end;
    return minute >= start || minute < end;
  }

  function getWholeHouseFanPlan(dayInput) {
    const empty = {
      fanByHourKwh: new Array(24).fill(0),
      displacedAcByHourKwh: new Array(24).fill(0),
      netLoadDeltaByHourKwh: new Array(24).fill(0),
      totalFanKwh: 0,
      totalDisplacedAcKwh: 0,
      totalNetReductionKwh: 0,
      activeHours: 0
    };
    if (!dayInput.whfEnabled || !dayInput.whfActiveMonth || dayInput.whfSuccessRate <= 0) return empty;

    const success = clamp(dayInput.whfSuccessRate, 0, 1);
    for (let hour = 0; hour < 24; hour += 1) {
      const minuteStart = hour * 60;
      const minuteMid = minuteStart + 30;
      if (!minuteInWindow(minuteMid, dayInput.whfStartMinuteOfDay, dayInput.whfEndMinuteOfDay)) continue;
      const fanKwh = (dayInput.whfFanWatts / 1000) * success;
      const displacedKwh = (dayInput.whfDisplacedAcWatts / 1000) * success;
      const net = displacedKwh - fanKwh;
      empty.fanByHourKwh[hour] = fanKwh;
      empty.displacedAcByHourKwh[hour] = displacedKwh;
      empty.netLoadDeltaByHourKwh[hour] = -net;
      empty.totalFanKwh += fanKwh;
      empty.totalDisplacedAcKwh += displacedKwh;
      empty.totalNetReductionKwh += Math.max(0, net);
      empty.activeHours += 1;
    }

    return empty;
  }

  function simulateRepresentativeDay(dayInput) {
    const loadShape = buildHourlyLoadShape(dayInput.peakShare);
    const solarShape = buildSolarHourlyShape(dayInput.monthIndex, dayInput.solarHourlyByMonth);
    const batteryCapacity = dayInput.powerwallCount * dayInput.usableKwhPerBattery;
    const maxDischargeKwhHour = batteryCapacity > 0 ? ((batteryCapacity * dayInput.cyclesPerDay) / 24) : 0;
    const maxChargeKwhHour = batteryCapacity > 0 ? ((batteryCapacity * dayInput.cyclesPerDay) / 24) : 0;
    const solarToHomeEfficiency = clamp(dayInput.solarToHomeEfficiency || 1, 0.8, 1);
    const minSocKwh = batteryCapacity * clamp(dayInput.minSocReservePct || 0, 0, 0.95);

    const hvacPlan = getHvacShiftPlan(dayInput, loadShape);
    const whfPlan = getWholeHouseFanPlan(dayInput);

    let socKwh = batteryCapacity * 0.5;
    const stats = {
      importPeakKwh: 0,
      importOffKwh: 0,
      exportPeakKwh: 0,
      exportOffKwh: 0,
      beforeImportPeakKwh: 0,
      beforeImportOffKwh: 0,
      directSolarToLoad: 0,
      batteryToLoad: 0,
      batteryToGridExportKwh: 0,
      batteryToLoadPeakKwh: 0,
      batteryToLoadPostPeakKwh: 0,
      batteryReserveHits: 0,
      minSocKwh,
      solarToBatteryInputKwh: 0,
      solarToBatteryStoredKwh: 0,
      evDaySolarServedKwh: 0,
      evDayShiftedToNightKwh: 0,
      evNightLoadAfterKwh: 0,
      hvacShiftCapacityKwh: hvacPlan.totalCapacityKwh,
      hvacShiftScheduledKwh: hvacPlan.totalScheduledKwh,
      hvacShiftExecutedKwh: hvacPlan.totalExecutedKwh,
      hvacShiftToPreWindowKwh: hvacPlan.totalShiftToPreKwh,
      hvacShiftToPostPeakKwh: hvacPlan.totalShiftToPostKwh,
      hvacPeakImportAvoidedKwh: hvacPlan.totalPeakImportAvoidedKwh,
      whfFanKwh: whfPlan.totalFanKwh,
      whfDisplacedAcKwh: whfPlan.totalDisplacedAcKwh,
      whfNetReductionKwh: whfPlan.totalNetReductionKwh,
      whfActiveHours: whfPlan.activeHours,
      clippedSolarKwh: 0,
      solarGenerationKwh: 0
    };

    for (let hour = 0; hour < 24; hour += 1) {
      const baseLoad = dayInput.dayHomeLoadKwh * loadShape[hour];
      const hvacShiftDelta = (hvacPlan.schedulePreByHour[hour] || 0) + (hvacPlan.schedulePostByHour[hour] || 0);
      const whfDelta = whfPlan.netLoadDeltaByHourKwh[hour] || 0;
      const hourLoad = Math.max(0, baseLoad + hvacShiftDelta + whfDelta);

      if (PEAK_HOURS.has(hour)) {
        stats.beforeImportPeakKwh += hourLoad;
      } else {
        stats.beforeImportOffKwh += hourLoad;
      }

      const hourlySolarRaw = dayInput.daySolarKwh * solarShape[hour];
      const maxSolarHour = dayInput.maxAcOutputKw;
      const hourlySolar = Math.min(hourlySolarRaw, maxSolarHour);
      stats.clippedSolarKwh += Math.max(0, hourlySolarRaw - hourlySolar);
      stats.solarGenerationKwh += hourlySolar;

      let loadRemaining = hourLoad;
      let solarRemaining = hourlySolar;

      const directSolarDelivered = Math.min(loadRemaining, solarRemaining * solarToHomeEfficiency);
      if (directSolarDelivered > 0) {
        const directSolarDc = directSolarDelivered / solarToHomeEfficiency;
        loadRemaining -= directSolarDelivered;
        solarRemaining -= directSolarDc;
        stats.directSolarToLoad += directSolarDelivered;
      }

      if (batteryCapacity > 0 && solarRemaining > 0) {
        const chargeRoom = Math.max(0, batteryCapacity - socKwh);
        if (chargeRoom > 0) {
          const chargeInput = Math.min(solarRemaining, maxChargeKwhHour, chargeRoom / dayInput.roundTripEfficiency);
          if (chargeInput > 0) {
            const storedEnergy = chargeInput * dayInput.roundTripEfficiency;
            socKwh += storedEnergy;
            solarRemaining -= chargeInput;
            stats.solarToBatteryInputKwh += chargeInput;
            stats.solarToBatteryStoredKwh += storedEnergy;
          }
        }
      }

      if (batteryCapacity > 0 && loadRemaining > 0) {
        const availableFromBattery = Math.max(0, socKwh - minSocKwh);
        if (availableFromBattery > 0) {
          const dischargeCandidate = Math.min(maxDischargeKwhHour, availableFromBattery, loadRemaining);
          const shouldDischarge =
            dayInput.dispatchMode === "self_consumption_always"
            || (dayInput.dispatchMode === "self_consumption_peak_then_postpeak" && (PEAK_HOURS.has(hour) || POST_PEAK_HOUR_SET.has(hour)))
            || (dayInput.dispatchMode === "self_consumption_peak_only" && PEAK_HOURS.has(hour));

          if (shouldDischarge && dischargeCandidate > 0) {
            socKwh -= dischargeCandidate;
            loadRemaining -= dischargeCandidate;
            stats.batteryToLoad += dischargeCandidate;
            if (PEAK_HOURS.has(hour)) stats.batteryToLoadPeakKwh += dischargeCandidate;
            if (POST_PEAK_HOUR_SET.has(hour)) stats.batteryToLoadPostPeakKwh += dischargeCandidate;
          }
        }
      }

      if (batteryCapacity > 0 && (socKwh - minSocKwh) <= 1e-6 && loadRemaining > 1e-6) {
        stats.batteryReserveHits += 1;
      }

      const solarExport = Math.max(0, solarRemaining * solarToHomeEfficiency);
      if (PEAK_HOURS.has(hour)) {
        stats.exportPeakKwh += solarExport;
      } else {
        stats.exportOffKwh += solarExport;
      }

      if (loadRemaining > 0) {
        if (PEAK_HOURS.has(hour)) {
          stats.importPeakKwh += loadRemaining;
        } else {
          stats.importOffKwh += loadRemaining;
        }
      }
    }

    return stats;
  }

  function getHaMonthDispatchConfig(ha, monthIndex) {
    if (!ha || !ha.enabled) {
      return {
        haSuccessRate: 0,
        haPreCoolStartHour: 12,
        haPreCoolEndHour: 16,
        haMaxShiftHoursPerDay: 0
      };
    }

    const safeMonth = clamp(Math.floor(monthIndex || 0), 0, 11);
    const successRateByMonth = Array.isArray(ha.successRateByMonth) ? ha.successRateByMonth : [];
    const autoPreWindowByMonth = Array.isArray(ha.autoPreWindowByMonth) ? ha.autoPreWindowByMonth : [];

    const defaultSuccess = clamp(Number(ha.successRate) || 0, 0, 1);
    const monthSuccess = Number(successRateByMonth[safeMonth]);
    const resolvedSuccess = Number.isFinite(monthSuccess) ? clamp(monthSuccess, 0, 1) : defaultSuccess;

    const autoWindow = autoPreWindowByMonth[safeMonth] || null;
    const manualWindow = {
      startHour: clamp(Math.floor(Number(ha.preCoolStartHour) || 0), 0, 23),
      endHour: clamp(Math.floor(Number(ha.preCoolEndHour) || 0), 0, 23)
    };
    const selectedWindow = ha.mode === "auto" && autoWindow ? autoWindow : manualWindow;
    const autoMaxShiftHours = Math.max(1, buildHourRange(selectedWindow.startHour, selectedWindow.endHour, 24).length);
    const maxShiftHoursPerDay = ha.mode === "auto"
      ? autoMaxShiftHours
      : clamp(Math.floor(Number(ha.maxShiftHoursPerDay) || 0), 1, 12);

    return {
      haSuccessRate: resolvedSuccess,
      haPreCoolStartHour: clamp(Math.floor(Number(selectedWindow.startHour) || 0), 0, 23),
      haPreCoolEndHour: clamp(Math.floor(Number(selectedWindow.endHour) || 0), 0, 23),
      haMaxShiftHoursPerDay: maxShiftHoursPerDay
    };
  }

  function getWhfMonthDispatchConfig(whf, monthIndex) {
    if (!whf || !whf.enabled) {
      return {
        whfActiveMonth: false,
        whfSuccessRate: 0,
        whfStartMinuteOfDay: 0,
        whfEndMinuteOfDay: 0
      };
    }

    const safeMonth = clamp(Math.floor(monthIndex || 0), 0, 11);
    const activeMonths = Array.isArray(whf.activeMonths) ? whf.activeMonths : [];
    const autoActiveMonths = Array.isArray(whf.autoActiveMonths) ? whf.autoActiveMonths : [];
    const successRateByMonth = Array.isArray(whf.successRateByMonth) ? whf.successRateByMonth : [];
    const autoWindowByMonth = Array.isArray(whf.autoWindowByMonth) ? whf.autoWindowByMonth : [];

    const manualActive = activeMonths.includes(safeMonth);
    const autoActive = autoActiveMonths.includes(safeMonth);
    const whfActiveMonth = whf.mode === "auto" ? autoActive : manualActive;

    const defaultSuccess = clamp(Number(whf.successRate) || 0, 0, 1);
    const monthSuccess = Number(successRateByMonth[safeMonth]);
    const whfSuccessRate = Number.isFinite(monthSuccess) ? clamp(monthSuccess, 0, 1) : defaultSuccess;

    const manualWindow = {
      startMinuteOfDay: clamp(Math.floor(Number(whf.startMinuteOfDay) || 0), 0, 1439),
      endMinuteOfDay: clamp(Math.floor(Number(whf.endMinuteOfDay) || 0), 0, 1439)
    };
    const autoWindow = autoWindowByMonth[safeMonth] || null;
    const selectedWindow = whf.mode === "auto" && autoWindow
      ? {
        startMinuteOfDay: clamp(Math.floor(Number(autoWindow.startMinuteOfDay) || manualWindow.startMinuteOfDay), 0, 1439),
        endMinuteOfDay: clamp(Math.floor(Number(autoWindow.endMinuteOfDay) || manualWindow.endMinuteOfDay), 0, 1439)
      }
      : manualWindow;

    return {
      whfActiveMonth,
      whfSuccessRate,
      whfStartMinuteOfDay: clamp(Math.floor(Number(selectedWindow.startMinuteOfDay) || 0), 0, 1439),
      whfEndMinuteOfDay: clamp(Math.floor(Number(selectedWindow.endMinuteOfDay) || 0), 0, 1439)
    };
  }

  function getMonthReservePct(batteryConfig, monthIndex) {
    const safeMonth = clamp(Math.floor(monthIndex || 0), 0, 11);
    const reserve = Array.isArray(batteryConfig.monthlyReservePct)
      ? Number(batteryConfig.monthlyReservePct[safeMonth])
      : Number.NaN;
    return Number.isFinite(reserve) ? clamp(reserve, 0, 0.95) : clamp(batteryConfig.minSocReservePct, 0, 0.95);
  }

  function resolveExportRatesForMonth(rates, monthIndex, rateScale) {
    const scale = Number.isFinite(rateScale) ? rateScale : 1;
    if (rates.exportRateMode === "nem3_override") {
      const nem3 = Number(rates.nem3ExportRate) || 0;
      return { offPeak: nem3 * scale, peak: nem3 * scale };
    }
    if (rates.exportRateMode === "monthly") {
      const off = Array.isArray(rates.exportMonthlyOffPeak) ? (Number(rates.exportMonthlyOffPeak[monthIndex]) || 0) : 0;
      const peak = Array.isArray(rates.exportMonthlyPeak) ? (Number(rates.exportMonthlyPeak[monthIndex]) || 0) : 0;
      return {
        offPeak: off * scale,
        peak: peak * scale
      };
    }
    return {
      offPeak: (Number(rates.exportOffPeak) || 0) * scale,
      peak: (Number(rates.exportPeak) || 0) * scale
    };
  }

  function computeMonthBills(monthInput) {
    const safeDays = Math.max(1, monthInput.days);
    const dayHomeLoadKwh = monthInput.homeLoadKwh / safeDays;
    const daySolarKwh = monthInput.solarKwh / safeDays;
    const dayEvKwh = (monthInput.evKwhMonth || 0) / safeDays;
    const evDayTargetKwh = dayEvKwh * monthInput.evDayChargingShare;
    const evNightTargetKwh = dayEvKwh * monthInput.evNightChargingShare;

    const dayResult = simulateRepresentativeDay({
      monthIndex: monthInput.monthIndex,
      dayHomeLoadKwh,
      daySolarKwh,
      peakShare: monthInput.peakShare,
      powerwallCount: monthInput.powerwallCount,
      usableKwhPerBattery: monthInput.usableKwhPerBattery,
      cyclesPerDay: monthInput.cyclesPerDay,
      solarToHomeEfficiency: monthInput.solarToHomeEfficiency,
      maxAcOutputKw: monthInput.maxAcOutputKw,
      roundTripEfficiency: monthInput.roundTripEfficiency,
      dispatchMode: monthInput.dispatchMode,
      minSocReservePct: monthInput.minSocReservePct,
      importOffPeakRate: monthInput.importOffPeak,
      importPeakRate: monthInput.importPeak,
      exportOffPeakRate: monthInput.exportOffPeak,
      exportPeakRate: monthInput.exportPeak,
      evEnabled: monthInput.evEnabled,
      evDayTargetKwh,
      evNightTargetKwh,
      haEnabled: monthInput.haEnabled,
      ha: monthInput.ha,
      haSuccessRate: monthInput.haSuccessRate,
      haPreCoolStartHour: monthInput.haPreCoolStartHour,
      haPreCoolEndHour: monthInput.haPreCoolEndHour,
      haMaxShiftHoursPerDay: monthInput.haMaxShiftHoursPerDay,
      haSummerSetpointF: monthInput.haSummerSetpointF,
      haWinterSetpointF: monthInput.haWinterSetpointF,
      haMaxPrecoolOffsetF: monthInput.haMaxPrecoolOffsetF,
      haMaxPreheatOffsetF: monthInput.haMaxPreheatOffsetF,
      whfEnabled: monthInput.whfEnabled,
      whfActiveMonth: monthInput.whfActiveMonth,
      whfFanWatts: monthInput.whfFanWatts,
      whfDisplacedAcWatts: monthInput.whfDisplacedAcWatts,
      whfSuccessRate: monthInput.whfSuccessRate,
      whfStartMinuteOfDay: monthInput.whfStartMinuteOfDay,
      whfEndMinuteOfDay: monthInput.whfEndMinuteOfDay,
      solarHourlyByMonth: monthInput.solarHourlyByMonth
    });

    const scale = safeDays;
    const beforeImportPeakKwh = dayResult.beforeImportPeakKwh * scale;
    const beforeImportOffKwh = dayResult.beforeImportOffKwh * scale;
    const importPeakKwh = dayResult.importPeakKwh * scale;
    const importOffKwh = dayResult.importOffKwh * scale;
    const exportPeakKwh = dayResult.exportPeakKwh * scale;
    const exportOffKwh = dayResult.exportOffKwh * scale;
    const exportKwh = exportPeakKwh + exportOffKwh;
    const importKwh = importPeakKwh + importOffKwh;
    const beforeImportKwh = beforeImportPeakKwh + beforeImportOffKwh;

    const exportCreditValue = (exportPeakKwh * monthInput.exportPeak) + (exportOffKwh * monthInput.exportOffPeak);

    const billBeforeEnergy = beforeImportPeakKwh * monthInput.importPeak + beforeImportOffKwh * monthInput.importOffPeak;
    const billBeforeNbc = beforeImportKwh * monthInput.nbcPerImportKwh;
    const billBefore = billBeforeEnergy + billBeforeNbc + monthInput.fixedMonthlyCharge;

    const billAfterEnergy = importPeakKwh * monthInput.importPeak + importOffKwh * monthInput.importOffPeak;
    const billAfterNbc = importKwh * monthInput.nbcPerImportKwh;
    const rawBillAfter = billAfterEnergy + billAfterNbc + monthInput.fixedMonthlyCharge - exportCreditValue;

    return {
      billBefore,
      rawBillAfter,
      billAfterEnergy,
      billAfterNbc,
      fixedCharge: monthInput.fixedMonthlyCharge,
      exportCreditValue,
      importKwh,
      importPeakKwh,
      importOffKwh,
      exportKwh,
      exportPeakKwh,
      exportOffKwh,
      beforeImportPeakKwh,
      beforeImportOffKwh,
      beforeImportKwh,
      directSolarToLoadKwh: dayResult.directSolarToLoad * scale,
      solarToBatteryInputKwh: dayResult.solarToBatteryInputKwh * scale,
      solarToBatteryStoredKwh: dayResult.solarToBatteryStoredKwh * scale,
      batteryToLoadKwh: dayResult.batteryToLoad * scale,
      batteryToGridExportKwh: dayResult.batteryToGridExportKwh * scale,
      batteryToLoadPeakKwh: dayResult.batteryToLoadPeakKwh * scale,
      batteryToLoadPostPeakKwh: dayResult.batteryToLoadPostPeakKwh * scale,
      batteryReserveHits: dayResult.batteryReserveHits * scale,
      minSocKwh: dayResult.minSocKwh,
      evDaySolarServedKwh: dayResult.evDaySolarServedKwh * scale,
      evDayShiftedToNightKwh: dayResult.evDayShiftedToNightKwh * scale,
      evNightLoadAfterKwh: dayResult.evNightLoadAfterKwh * scale,
      hvacShiftCapacityKwh: dayResult.hvacShiftCapacityKwh * scale,
      hvacShiftScheduledKwh: dayResult.hvacShiftScheduledKwh * scale,
      hvacShiftExecutedKwh: dayResult.hvacShiftExecutedKwh * scale,
      hvacShiftToPreWindowKwh: dayResult.hvacShiftToPreWindowKwh * scale,
      hvacShiftToPostPeakKwh: dayResult.hvacShiftToPostPeakKwh * scale,
      hvacPeakImportAvoidedKwh: dayResult.hvacPeakImportAvoidedKwh * scale,
      whfFanKwh: dayResult.whfFanKwh * scale,
      whfDisplacedAcKwh: dayResult.whfDisplacedAcKwh * scale,
      whfNetReductionKwh: dayResult.whfNetReductionKwh * scale,
      whfActiveHours: dayResult.whfActiveHours * scale,
      clippedSolarKwh: dayResult.clippedSolarKwh * scale,
      solarGenerationKwh: dayResult.solarGenerationKwh * scale
    };
  }

  function calculateAnnualEnergyAndBills(inputs, solarKw, powerwallCountOverride, scaleOptions) {
    const pw = Number.isFinite(powerwallCountOverride) ? powerwallCountOverride : inputs.sizing.powerwallCount;
    const solarScale = scaleOptions && Number.isFinite(scaleOptions.solarScale) ? Math.max(0, scaleOptions.solarScale) : 1;
    const batteryScale = scaleOptions && Number.isFinite(scaleOptions.batteryScale) ? Math.max(0, scaleOptions.batteryScale) : 1;
    const rateScale = scaleOptions && Number.isFinite(scaleOptions.rateScale) ? Math.max(0, scaleOptions.rateScale) : 1;

    let annualBefore = 0;
    let annualImportKwh = 0;
    let annualImportPeakKwh = 0;
    let annualImportOffKwh = 0;
    let annualExportKwh = 0;
    let annualExportPeakKwh = 0;
    let annualExportOffKwh = 0;
    let annualImportEnergyCostAfter = 0;
    let annualExportCreditValue = 0;
    let annualNbcAfter = 0;
    let annualFixedChargeTotal = 0;
    let annualBeforeImportPeakKwh = 0;
    let annualBeforeImportOffKwh = 0;
    let annualDirectSolarToLoadKwh = 0;
    let annualSolarToBatteryInputKwh = 0;
    let annualSolarToBatteryStoredKwh = 0;
    let annualBatteryToLoadKwh = 0;
    let annualBatteryToGridExportKwh = 0;
    let annualBatteryToLoadPeakKwh = 0;
    let annualBatteryToLoadPostPeakKwh = 0;
    let annualBatteryReserveHits = 0;
    let annualEvDaySolarServedKwh = 0;
    let annualEvDayShiftedToNightKwh = 0;
    let annualEvNightLoadAfterKwh = 0;
    let annualHvacShiftCapacityKwh = 0;
    let annualHvacShiftScheduledKwh = 0;
    let annualHvacShiftExecutedKwh = 0;
    let annualHvacPeakImportAvoidedKwh = 0;
    let annualHvacShiftToPreWindowKwh = 0;
    let annualHvacShiftToPostPeakKwh = 0;
    let annualSolarGenerationKwh = 0;
    let annualHomeLoadAdjustedKwh = 0;
    let annualMinSocKwh = Number.POSITIVE_INFINITY;
    let annualWhfFanKwh = 0;
    let annualWhfDisplacedAcKwh = 0;
    let annualWhfNetReductionKwh = 0;
    let annualWhfActiveHours = 0;
    let annualClippedSolarKwh = 0;

    const evKwhMonth = inputs.ev.enabled ? inputs.ev.kwhPerMonth : 0;
    const solarMonthlyProfile = isValidMonthlyProfile(inputs.production.solarMonthlyProfile) ? inputs.production.solarMonthlyProfile : SOLAR_PROFILE;
    const solarHourlyByMonth = isValidHourlyByMonth(inputs.production.solarHourlyByMonth) ? inputs.production.solarHourlyByMonth : null;
    const maxAcOutputKw = pw >= 1 ? pw * POWERWALL3_AC_KW : Number.POSITIVE_INFINITY;

    for (let month = 0; month < 12; month += 1) {
      const baseHomeLoadKwh = inputs.load.annualKwh * inputs.load.monthProfile[month];
      const homeLoadSeasonMultiplier = getSeasonLoadMultiplier(inputs.load, month);
      const homeLoadKwh = baseHomeLoadKwh * homeLoadSeasonMultiplier;
      const solarKwh = solarKw * inputs.production.annualYield * solarMonthlyProfile[month] * solarScale;
      const monthExportRates = resolveExportRatesForMonth(inputs.rates, month, rateScale);
      const monthReservePct = getMonthReservePct(inputs.battery, month);
      const haMonthConfig = getHaMonthDispatchConfig(inputs.ha, month);
      const whfMonthConfig = getWhfMonthDispatchConfig(inputs.whf, month);

      const monthResult = computeMonthBills({
        monthIndex: month,
        homeLoadKwh,
        solarKwh,
        peakShare: inputs.load.peakShare,
        importOffPeak: inputs.rates.importOffPeak * rateScale,
        importPeak: inputs.rates.importPeak * rateScale,
        fixedMonthlyCharge: inputs.rates.fixedMonthlyCharge * rateScale,
        nbcPerImportKwh: inputs.rates.nbcPerImportKwh * rateScale,
        exportOffPeak: monthExportRates.offPeak,
        exportPeak: monthExportRates.peak,
        powerwallCount: pw,
        usableKwhPerBattery: inputs.battery.usableKwhPerBattery * batteryScale,
        cyclesPerDay: inputs.battery.cyclesPerDay,
        solarToHomeEfficiency: inputs.production.solarToHomeEfficiency,
        maxAcOutputKw,
        roundTripEfficiency: inputs.battery.roundTripEfficiency,
        dispatchMode: inputs.battery.dispatchMode,
        minSocReservePct: monthReservePct,
        evEnabled: inputs.ev.enabled,
        evKwhMonth,
        evDayChargingShare: inputs.ev.dayChargingShare,
        evNightChargingShare: inputs.ev.nightChargingShare,
        haEnabled: inputs.ha.enabled,
        ha: inputs.ha,
        haSuccessRate: haMonthConfig.haSuccessRate,
        haPreCoolStartHour: haMonthConfig.haPreCoolStartHour,
        haPreCoolEndHour: haMonthConfig.haPreCoolEndHour,
        haMaxShiftHoursPerDay: haMonthConfig.haMaxShiftHoursPerDay,
        haSummerSetpointF: inputs.ha.summerSetpointF,
        haWinterSetpointF: inputs.ha.winterSetpointF,
        haMaxPrecoolOffsetF: inputs.ha.maxPrecoolOffsetF,
        haMaxPreheatOffsetF: inputs.ha.maxPreheatOffsetF,
        whfEnabled: inputs.whf.enabled,
        whfActiveMonth: whfMonthConfig.whfActiveMonth,
        whfFanWatts: inputs.whf.fanWatts,
        whfDisplacedAcWatts: inputs.whf.displacedAcWatts,
        whfSuccessRate: whfMonthConfig.whfSuccessRate,
        whfStartMinuteOfDay: whfMonthConfig.whfStartMinuteOfDay,
        whfEndMinuteOfDay: whfMonthConfig.whfEndMinuteOfDay,
        solarHourlyByMonth,
        days: DAYS_IN_MONTH[month]
      });

      annualBefore += monthResult.billBefore;
      annualImportEnergyCostAfter += monthResult.billAfterEnergy;
      annualExportCreditValue += monthResult.exportCreditValue;
      annualNbcAfter += monthResult.billAfterNbc;
      annualFixedChargeTotal += monthResult.fixedCharge;
      annualImportKwh += monthResult.importKwh;
      annualImportPeakKwh += monthResult.importPeakKwh;
      annualImportOffKwh += monthResult.importOffKwh;
      annualExportKwh += monthResult.exportKwh;
      annualExportPeakKwh += monthResult.exportPeakKwh;
      annualExportOffKwh += monthResult.exportOffKwh;
      annualBeforeImportPeakKwh += monthResult.beforeImportPeakKwh;
      annualBeforeImportOffKwh += monthResult.beforeImportOffKwh;
      annualDirectSolarToLoadKwh += monthResult.directSolarToLoadKwh;
      annualSolarToBatteryInputKwh += monthResult.solarToBatteryInputKwh;
      annualSolarToBatteryStoredKwh += monthResult.solarToBatteryStoredKwh;
      annualBatteryToLoadKwh += monthResult.batteryToLoadKwh;
      annualBatteryToGridExportKwh += monthResult.batteryToGridExportKwh;
      annualBatteryToLoadPeakKwh += monthResult.batteryToLoadPeakKwh;
      annualBatteryToLoadPostPeakKwh += monthResult.batteryToLoadPostPeakKwh;
      annualBatteryReserveHits += monthResult.batteryReserveHits;
      annualEvDaySolarServedKwh += monthResult.evDaySolarServedKwh;
      annualEvDayShiftedToNightKwh += monthResult.evDayShiftedToNightKwh;
      annualEvNightLoadAfterKwh += monthResult.evNightLoadAfterKwh;
      annualHvacShiftCapacityKwh += monthResult.hvacShiftCapacityKwh;
      annualHvacShiftScheduledKwh += monthResult.hvacShiftScheduledKwh;
      annualHvacShiftExecutedKwh += monthResult.hvacShiftExecutedKwh;
      annualHvacPeakImportAvoidedKwh += monthResult.hvacPeakImportAvoidedKwh;
      annualHvacShiftToPreWindowKwh += monthResult.hvacShiftToPreWindowKwh;
      annualHvacShiftToPostPeakKwh += monthResult.hvacShiftToPostPeakKwh;
      annualSolarGenerationKwh += monthResult.solarGenerationKwh;
      annualHomeLoadAdjustedKwh += homeLoadKwh;
      annualMinSocKwh = Math.min(annualMinSocKwh, monthResult.minSocKwh);
      annualWhfFanKwh += monthResult.whfFanKwh;
      annualWhfDisplacedAcKwh += monthResult.whfDisplacedAcKwh;
      annualWhfNetReductionKwh += monthResult.whfNetReductionKwh;
      annualWhfActiveHours += monthResult.whfActiveHours;
      annualClippedSolarKwh += monthResult.clippedSolarKwh;
    }

    const annualEnergyNetAfterTrueUp = Math.max(0, annualImportEnergyCostAfter - annualExportCreditValue);
    const annualVppCredit = inputs.vpp.enabled ? (pw * POWERWALL3_AC_KW * VPP_CREDIT_PER_KW_YEAR) : 0;
    const annualUtilityBillAfter = annualFixedChargeTotal + annualNbcAfter + annualEnergyNetAfterTrueUp;
    const annualVppRevenue = annualVppCredit;
    const annualNetEnergyEconomics = annualUtilityBillAfter - annualVppRevenue;
    const annualTotalLoadAfterEvKwh = annualHomeLoadAdjustedKwh + (inputs.ev.enabled ? evKwhMonth * 12 : 0);
    const annualSolarPotentialKwh = annualSolarGenerationKwh + annualClippedSolarKwh;
    const annualClippedSolarPct = annualSolarPotentialKwh > 0 ? (annualClippedSolarKwh / annualSolarPotentialKwh) : 0;

    return {
      annualBefore,
      annualAfterRaw: annualNetEnergyEconomics,
      annualSavings: annualBefore - annualNetEnergyEconomics,
      annualUtilityBillAfter,
      annualVppRevenue,
      annualNetEnergyEconomics,
      annualUtilitySavings: annualBefore - annualUtilityBillAfter,
      annualImportKwh,
      annualImportPeakKwh,
      annualImportOffKwh,
      annualExportKwh,
      annualExportPeakKwh,
      annualExportOffKwh,
      annualBeforeImportPeakKwh,
      annualBeforeImportOffKwh,
      annualDirectSolarToLoadKwh,
      annualSolarToBatteryInputKwh,
      annualSolarToBatteryStoredKwh,
      annualBatteryToLoadKwh,
      annualBatteryToGridExportKwh,
      annualBatteryToLoadPeakKwh,
      annualBatteryToLoadPostPeakKwh,
      annualBatteryReserveHits,
      annualMinSocKwh: Number.isFinite(annualMinSocKwh) ? annualMinSocKwh : 0,
      annualEvDaySolarServedKwh,
      annualEvDayShiftedToNightKwh,
      annualEvNightLoadAfterKwh,
      annualHvacShiftCapacityKwh,
      annualHvacShiftScheduledKwh,
      annualHvacShiftExecutedKwh,
      annualHvacPeakImportAvoidedKwh,
      annualHvacShiftToPreWindowKwh,
      annualHvacShiftToPostPeakKwh,
      annualSolarGenerationKwh,
      annualTotalLoadAfterEvKwh,
      annualHomeLoadAdjustedKwh,
      annualWhfFanKwh,
      annualWhfDisplacedAcKwh,
      annualWhfNetReductionKwh,
      annualWhfActiveHours,
      annualImportEnergyCostAfter,
      annualExportCreditValue,
      annualEnergyNetAfterTrueUp,
      annualNbcAfter,
      annualFixedChargeTotal,
      annualVppCredit,
      annualProgramRevenue: annualVppRevenue,
      annualClippedSolarKwh,
      annualClippedSolarPct,
      annualNetBenefit: annualUtilitySavings(annualBefore, annualUtilityBillAfter, annualVppRevenue)
    };
  }

  function annualUtilitySavings(annualBefore, annualUtilityBillAfter, annualVppRevenue) {
    return (annualBefore - annualUtilityBillAfter) + annualVppRevenue;
  }

  function buildSimulationInputs(rawInputs, climateSnapshot) {
    const hasValidClimateProfileSnapshot = climateSnapshot && isValidClimateProfile(climateSnapshot.profile);
    const climateProfile = hasValidClimateProfileSnapshot
      ? climateSnapshot.profile
      : getSyntheticClimateProfile(rawInputs.climate && rawInputs.climate.zipCode);
    const tempHourlyFByMonth = isValidTempHourlyByMonth(climateProfile.tempHourlyFByMonth)
      ? climateProfile.tempHourlyFByMonth
      : getSyntheticTempHourlyByMonthProfiles();
    const homeFlex = rawInputs.homeFlex || {};
    const haRaw = homeFlex.ha || {};
    const whfRaw = homeFlex.whf || {};

    const summerSetpointF = clamp(asFinite(haRaw.summerSetpointF, BASE_SUMMER_SETPOINT_F), 55, 90);
    const winterSetpointF = clamp(asFinite(haRaw.winterSetpointF, BASE_WINTER_SETPOINT_F), 55, 90);

    const haEnabled = !!haRaw.enabled;
    const haMode = haRaw.mode === "manual" ? "manual" : "auto";
    const haManualSuccess = clamp(asFinite(haRaw.successRatePct, 70) / 100, 0, 1);
    const haAutoProfile = deriveAutoHaProfile(tempHourlyFByMonth, summerSetpointF, winterSetpointF);
    const haSuccessRateByMonth = haEnabled
      ? (haMode === "auto" ? haAutoProfile.successRateByMonth : new Array(12).fill(haManualSuccess))
      : new Array(12).fill(0);
    const haAutoPreWindowByMonth = haEnabled
      ? (haMode === "auto"
        ? haAutoProfile.autoPreWindowByMonth
        : new Array(12).fill(0).map(() => ({
          startHour: clamp(Math.floor(asFinite(haRaw.preCoolStartHour, 12)), 0, 23),
          endHour: clamp(Math.floor(asFinite(haRaw.preCoolEndHour, 16)), 0, 23)
        })))
      : new Array(12).fill(0).map(() => ({ startHour: 12, endHour: 16 }));

    const whfEnabled = !!whfRaw.enabled;
    const whfMode = whfRaw.mode === "manual" ? "manual" : "auto";
    const whfManualSuccess = clamp(asFinite(whfRaw.successRatePct, 85) / 100, 0, 1);
    const whfManualStartMinute = (clamp(Math.floor(asFinite(whfRaw.startHour, 20)), 0, 23) * 60)
      + clamp(Math.floor(asFinite(whfRaw.startMinute, 30)), 0, 59);
    const whfManualEndMinute = (clamp(Math.floor(asFinite(whfRaw.endHour, 6)), 0, 23) * 60)
      + clamp(Math.floor(asFinite(whfRaw.endMinute, 0)), 0, 59);
    const whfActiveMonthsRaw = Array.isArray(whfRaw.activeMonths) ? whfRaw.activeMonths : [4, 5, 6, 7, 8];
    const whfActiveMonths = whfActiveMonthsRaw
      .map((month) => Math.floor(asFinite(month, -1)))
      .filter((month) => month >= 0 && month <= 11);
    const whfAutoProfile = deriveAutoWhfProfile(tempHourlyFByMonth, summerSetpointF);
    const whfSuccessRateByMonth = whfEnabled
      ? (whfMode === "auto" ? whfAutoProfile.successRateByMonth : new Array(12).fill(whfManualSuccess))
      : new Array(12).fill(0);
    const whfAutoWindowByMonth = whfEnabled
      ? (whfMode === "auto"
        ? whfAutoProfile.autoWindowByMonth
        : new Array(12).fill(0).map(() => ({
          startMinuteOfDay: whfManualStartMinute,
          endMinuteOfDay: whfManualEndMinute
        })))
      : new Array(12).fill(0).map(() => ({ startMinuteOfDay: 0, endMinuteOfDay: 0 }));
    const whfAutoActiveMonths = whfEnabled
      ? (whfMode === "auto" ? whfAutoProfile.autoActiveMonths : whfActiveMonths)
      : [];

    const exportRate = Math.max(0, asFinite(rawInputs.rates.exportRate, 0.04));

    return {
      sizing: {
        powerwallCount: 0
      },
      production: {
        annualYield: climateProfile.annualKwhPerKw,
        solarToHomeEfficiency: 0.975,
        solarMonthlyProfile: climateProfile.monthlyProfile,
        solarHourlyByMonth: climateProfile.hourlyByMonth,
        tempHourlyFByMonth,
        tempSource: climateProfile.tempSource
      },
      load: {
        annualKwh: Math.max(0, asFinite(rawInputs.home.annualLoadKwh, 24000)),
        peakShare: 0.4,
        monthProfile: LOAD_PROFILE,
        summerSetpointF,
        winterSetpointF
      },
      ev: {
        enabled: false,
        milesPerMonth: 0,
        kwhPerMile: 0.30,
        dayChargingShare: 0,
        nightChargingShare: 1,
        kwhPerMonth: 0,
        chargingRule: "solar_first_shift"
      },
      ha: {
        enabled: haEnabled,
        mode: haMode,
        successRateByMonth: haSuccessRateByMonth,
        autoPreWindowByMonth: haAutoPreWindowByMonth,
        tempUnits: "F",
        summerSetpointF,
        winterSetpointF,
        maxPrecoolOffsetF: haEnabled ? clamp(asFinite(haRaw.maxPrecoolOffsetF, 3), 0, 10) : 0,
        maxPreheatOffsetF: haEnabled ? clamp(asFinite(haRaw.maxPreheatOffsetF, 2), 0, 10) : 0,
        maxPeakRelaxOffsetF: haEnabled ? clamp(asFinite(haRaw.maxPeakRelaxOffsetF, 2), 0, 10) : 0,
        hvacSensitivityKwhPerDegHour: haEnabled ? Math.max(0, asFinite(haRaw.hvacSensitivityKwhPerDegHour, 0.6)) : 0.6,
        successRate: haEnabled ? haManualSuccess : 0,
        preCoolStartHour: haEnabled ? clamp(Math.floor(asFinite(haRaw.preCoolStartHour, 12)), 0, 23) : 12,
        preCoolEndHour: haEnabled ? clamp(Math.floor(asFinite(haRaw.preCoolEndHour, 16)), 0, 23) : 16,
        maxShiftHoursPerDay: haEnabled ? clamp(Math.floor(asFinite(haRaw.maxShiftHoursPerDay, 4)), 1, 12) : 0,
        maxShiftKwhPerDay: haEnabled ? Math.max(0, asFinite(haRaw.maxShiftKwhPerDay, 6)) : 0,
        horizon: "day_ahead_heuristic",
        seasonMap: {
          summerMonths: [4, 5, 6, 7, 8],
          winterMonths: [10, 11, 0, 1],
          shoulderMonths: [2, 3, 9]
        }
      },
      vpp: {
        enabled: !!rawInputs.battery.vppEnabled
      },
      whf: {
        enabled: whfEnabled,
        mode: whfMode,
        fanWatts: whfEnabled ? Math.max(0, asFinite(whfRaw.fanWatts, 200)) : 0,
        displacedAcWatts: whfEnabled ? Math.max(0, asFinite(whfRaw.displacedAcWatts, 3500)) : 0,
        startMinuteOfDay: whfEnabled ? whfManualStartMinute : 0,
        endMinuteOfDay: whfEnabled ? whfManualEndMinute : 0,
        activeMonths: whfEnabled ? whfActiveMonths : [],
        successRate: whfEnabled ? whfManualSuccess : 0,
        successRateByMonth: whfSuccessRateByMonth,
        autoWindowByMonth: whfAutoWindowByMonth,
        autoActiveMonths: whfAutoActiveMonths
      },
      rates: {
        tariffPreset: "custom",
        importOffPeak: Math.max(0, asFinite(rawInputs.rates.importOffPeak, 0.36)),
        importPeak: Math.max(0, asFinite(rawInputs.rates.importPeak, 0.58)),
        fixedMonthlyCharge: Math.max(0, asFinite(rawInputs.rates.fixedMonthlyCharge, 24.15)),
        nbcPerImportKwh: Math.max(0, asFinite(rawInputs.rates.nbcRate, 0.03)),
        exportRateMode: "nem3_override",
        nem3ExportRate: exportRate,
        exportOffPeak: exportRate,
        exportPeak: exportRate,
        exportMonthlyOffPeak: new Array(12).fill(exportRate),
        exportMonthlyPeak: new Array(12).fill(exportRate)
      },
      battery: {
        usableKwhPerBattery: BATTERY_USABLE_KWH,
        cyclesPerDay: 0.85,
        roundTripEfficiency: 0.9,
        dispatchMode: "self_consumption_peak_then_postpeak",
        reservePolicy: "auto_seasonal",
        minSocReservePct: 0.2,
        monthlyReservePct: DEFAULT_MONTHLY_RESERVE_PCT.map((pct) => pct / 100)
      },
      financing: {
        apr: Math.max(0, asFinite(rawInputs.financing.builderAprPct, asFinite(rawInputs.financing.aprPct, 6))) / 100,
        years: Math.max(1, Math.floor(asFinite(rawInputs.financing.loanYears, 15)))
      },
      analysis: {
        years: Math.max(1, Math.floor(asFinite(rawInputs.analysis.horizonYears, 15))),
        discountRate: Math.max(0, asFinite(rawInputs.analysis.discountRatePct, 6)) / 100,
        utilityEscalation: Math.max(0, asFinite(rawInputs.analysis.utilityEscalationPct, 3)) / 100,
        solarDegradation: Math.max(0, asFinite(rawInputs.analysis.solarDegradationPct, 0.5)) / 100,
        batteryDegradation: Math.max(0, asFinite(rawInputs.analysis.batteryDegradationPct, 2)) / 100
      },
      climate: {
        status: hasValidClimateProfileSnapshot ? climateSnapshot.status : "fallback_synthetic",
        locationLabel: climateSnapshot ? climateSnapshot.locationLabel : "",
        lastVerifiedAt: hasValidClimateProfileSnapshot ? climateSnapshot.lastVerifiedAt : null,
        fallbackReason: hasValidClimateProfileSnapshot ? climateSnapshot.fallbackReason : (climateSnapshot ? "invalid_profile" : "missing_data"),
        keyMode: climateSnapshot ? climateSnapshot.keyMode : "demo_key",
        pending: false,
        tempSource: climateProfile.tempSource
      }
    };
  }

  namespace.engineV261 = {
    constants: {
      BATTERY_USABLE_KWH,
      POWERWALL3_AC_KW,
      VPP_CREDIT_PER_KW_YEAR,
      DEFAULT_MONTHLY_RESERVE_PCT,
      LOAD_PROFILE,
      SOLAR_PROFILE
    },
    clamp,
    asFinite,
    normalizeProfile,
    buildSolarCandidates,
    buildClimateContext,
    getClimateProfile,
    getSyntheticClimateProfile,
    isValidClimateProfile,
    calculateAnnualEnergyAndBills,
    buildSimulationInputs
  };
})(window);
