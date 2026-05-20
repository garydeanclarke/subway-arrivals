const express = require('express');
const { transit_realtime } = require('gtfs-realtime-bindings');
const AdmZip = require('adm-zip');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const GTFS_STATIC_URL  = 'http://web.mta.info/developers/data/nyct/subway/google_transit.zip';
const LIRR_FEED_URL    = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/lirr%2Fgtfs-lirr';
const ALERTS_FEED_URL  = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts';

// LIRR stop IDs for Atlantic Terminal → Jamaica filter
const LIRR_ATLANTIC_STOP = '349';
const LIRR_JAMAICA_STOP  = '102';

// Atlantic Av-Barclays Ctr subway parent stop IDs — triggers LIRR display
const ATLANTIC_PARENT_STOPS = new Set(['235', 'D24', 'R31']);

const LINE_COLORS = {
  '1': '#EE352E', '2': '#EE352E', '3': '#EE352E',
  '4': '#00933C', '5': '#00933C', '6': '#00933C', '7': '#B933AD',
  'A': '#0039A6', 'C': '#0039A6', 'E': '#0039A6',
  'B': '#FF6319', 'D': '#FF6319', 'F': '#FF6319', 'M': '#FF6319',
  'G': '#6CBE45',
  'J': '#996633', 'Z': '#996633',
  'L': '#A7A9AC',
  'N': '#FCCC0A', 'Q': '#FCCC0A', 'R': '#FCCC0A', 'W': '#FCCC0A',
  'GS': '#808183', 'FS': '#808183', 'H': '#808183', 'SI': '#0039A6',
  'LIRR': '#004B87',
};

// Map a parent stop ID to the correct GTFS-RT feed URL
function feedUrlForStopId(stopId) {
  if (/^\d/.test(stopId))           return 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs';
  const p = stopId[0].toUpperCase();
  if ('ACH'.includes(p))            return 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace';
  if ('BDFM'.includes(p))           return 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm';
  if (p === 'G')                    return 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g';
  if ('JZ'.includes(p))             return 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz';
  if (p === 'L')                    return 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l';
  if ('NQRW'.includes(p))           return 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw';
  if (p === 'S')                    return 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-si';
  return null;
}

// Routes that could serve a stop, derived from stop ID prefix
function routesForStopIds(parentStopIds) {
  const routes = new Set();
  const prefixMap = {
    A: ['A','C','E'], C: ['A','C','E'], H: ['A','C','E'],
    B: ['B','D'],     D: ['B','D'],
    F: ['F','M'],     M: ['F','M'],
    G: ['G'],
    J: ['J','Z'],     Z: ['J','Z'],
    L: ['L'],
    N: ['N','Q','R','W'], Q: ['N','Q','R','W'],
    R: ['N','Q','R','W'], W: ['N','Q','R','W'],
    S: ['SI'],
  };
  for (const id of parentStopIds) {
    if (/^\d/.test(id)) ['1','2','3','4','5','6','7'].forEach(r => routes.add(r));
    else (prefixMap[id[0].toUpperCase()] || []).forEach(r => routes.add(r));
  }
  return routes;
}

// --- Alerts ---

const EFFECT_LABELS = {
  1: 'No Service', 2: 'Reduced Service', 3: 'Delays',
  4: 'Detour',     5: 'Extra Service',   6: 'Modified Service',
  7: 'Alert',      8: 'Alert',           9: 'Stop Moved',
  10: 'Info',      11: 'Accessibility',
};

const EFFECT_SEVERITY = {   // used by frontend for color-coding
  1: 'critical', 2: 'critical', 3: 'warning',
  4: 'warning',  6: 'warning',  9: 'warning',
  5: 'info',     10: 'info',    11: 'info',
};

function getEnglishText(ts) {
  if (!ts?.translation?.length) return '';
  const t = ts.translation.find(t => !t.language || t.language === 'en') || ts.translation[0];
  return t?.text || '';
}

function extractAlerts(feedObj, routeIds, parentStopIds) {
  const now = Math.floor(Date.now() / 1000);
  const stopIdSet = new Set(parentStopIds);
  const alerts = [];

  for (const entity of feedObj.entity || []) {
    const alert = entity.alert;
    if (!alert) continue;

    // Must be currently active
    const periods = alert.activePeriod || [];
    const active = !periods.length || periods.some(p =>
      now >= (p.start || 0) && now <= (p.end || Infinity)
    );
    if (!active) continue;

    // Must affect one of our routes or stops
    const relevant = (alert.informedEntity || []).some(ie =>
      (ie.routeId && routeIds.has(ie.routeId)) ||
      (ie.stopId  && stopIdSet.has(ie.stopId.replace(/[NS]$/, '')))
    );
    if (!relevant) continue;

    const header = getEnglishText(alert.headerText);
    if (!header) continue;

    alerts.push({
      effect:      alert.effect || 7,
      effectLabel: EFFECT_LABELS[alert.effect] || 'Alert',
      severity:    EFFECT_SEVERITY[alert.effect] || 'warning',
      header,
      description: getEnglishText(alert.descriptionText),
    });
  }

  return alerts;
}

// --- Station database ---

function parseStopsTxt(csv) {
  const lines = csv.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim().replace(/^﻿/, ''));
  return lines.slice(1).map(line => {
    const vals = line.split(',');
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (vals[i] || '').trim(); });
    return obj;
  });
}

let stationsCache = null;
let stationsCachedAt = 0;
// stop_id (without N/S suffix) → stop_name, used to derive live destinations
let stopNameMap = new Map();
const STATIONS_TTL = 24 * 60 * 60 * 1000;

async function loadStations() {
  if (stationsCache && Date.now() - stationsCachedAt < STATIONS_TTL) return stationsCache;

  console.log('Fetching GTFS static data…');
  const res = await fetch(GTFS_STATIC_URL);
  if (!res.ok) throw new Error(`GTFS static HTTP ${res.status}`);

  const buf = Buffer.from(await res.arrayBuffer());
  const zip = new AdmZip(buf);

  const stopsEntry = zip.getEntry('stops.txt');
  if (!stopsEntry) throw new Error('stops.txt not found in GTFS zip');
  const stops = parseStopsTxt(stopsEntry.getData().toString('utf8'));

  // Build stop_id → name map (all stops, parent and child)
  stopNameMap = new Map(stops.map(s => [s.stop_id, s.stop_name]));

  // Group parent stations by name (location_type=1)
  const byName = {};
  for (const stop of stops) {
    if (stop.location_type !== '1') continue;
    if (!byName[stop.stop_name]) {
      byName[stop.stop_name] = {
        name: stop.stop_name,
        stopIds: [],
        lat: parseFloat(stop.stop_lat),
        lon: parseFloat(stop.stop_lon),
      };
    }
    byName[stop.stop_name].stopIds.push(stop.stop_id);
  }

  stationsCache = Object.values(byName).sort((a, b) => a.name.localeCompare(b.name));
  stationsCachedAt = Date.now();
  console.log(`Loaded ${stationsCache.length} stations, ${stopNameMap.size} stop names`);
  return stationsCache;
}

// Strip directional suffix (N/S) to get parent stop_id, then look up name
function stopIdToName(stopId) {
  if (!stopId) return null;
  // Try exact match first, then strip trailing N/S
  return stopNameMap.get(stopId)
    || stopNameMap.get(stopId.replace(/[NS]$/, ''))
    || null;
}

// --- GTFS-RT fetching & parsing ---

async function fetchAndParse(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const buf = await res.arrayBuffer();
  const msg = transit_realtime.FeedMessage.decode(new Uint8Array(buf));
  return transit_realtime.FeedMessage.toObject(msg, { longs: Number, defaults: true });
}

function extractSubwayArrivals(feedObj, parentStopIds) {
  const now = Math.floor(Date.now() / 1000);
  const targetN = new Set(parentStopIds.map(id => id + 'N'));
  const targetS = new Set(parentStopIds.map(id => id + 'S'));
  const arrivals = [];

  for (const entity of feedObj.entity || []) {
    const tu = entity.tripUpdate;
    if (!tu) continue;

    const stus = tu.stopTimeUpdate || [];
    const routeId = tu.trip?.routeId || '?';

    // Destination = name of the last stop in this trip's live sequence
    const lastStopId = stus.length ? stus[stus.length - 1].stopId : null;
    const destination = stopIdToName(lastStopId);

    for (const stu of stus) {
      const isN = targetN.has(stu.stopId);
      const isS = targetS.has(stu.stopId);
      if (!isN && !isS) continue;

      const timeSec = stu.arrival?.time || stu.departure?.time;
      if (!timeSec) continue;

      const minutes = Math.round((timeSec - now) / 60);
      if (minutes < 0 || minutes > 90) continue;

      // Fall back to cardinal direction if stop name lookup fails
      const headsign = destination || (isN ? 'Northbound' : 'Southbound');

      arrivals.push({
        line: routeId,
        color: LINE_COLORS[routeId] || '#808183',
        headsign,
        minutes,
      });
      break; // one entry per trip at this station
    }
  }

  return arrivals;
}

// Only departures from Atlantic Terminal (349) that subsequently stop at Jamaica (102)
function extractLIRRJamaicaArrivals(feedObj) {
  const now = Math.floor(Date.now() / 1000);
  const arrivals = [];

  for (const entity of feedObj.entity || []) {
    const tu = entity.tripUpdate;
    const stus = tu?.stopTimeUpdate;
    if (!stus?.length) continue;

    const atIdx = stus.findIndex(s => s.stopId === LIRR_ATLANTIC_STOP);
    if (atIdx === -1) continue;

    const hasJamaica = stus.slice(atIdx + 1).some(s => s.stopId === LIRR_JAMAICA_STOP);
    if (!hasJamaica) continue;

    const timeSec = stus[atIdx].departure?.time || stus[atIdx].arrival?.time;
    if (!timeSec) continue;

    const minutes = Math.round((timeSec - now) / 60);
    if (minutes < 0 || minutes > 90) continue;

    arrivals.push({ line: 'LIRR', color: LINE_COLORS.LIRR, headsign: 'To Jamaica', minutes });
  }

  return arrivals;
}

// --- HTTP routes ---

const arrivalCache = new Map();
const ARRIVAL_TTL = 15_000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/stations', async (_req, res) => {
  try {
    res.json(await loadStations());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/arrivals', async (req, res) => {
  const parentStopIds = (req.query.stopIds || '235,D24,R31')
    .split(',').map(s => s.trim()).filter(Boolean);

  const cacheKey = [...parentStopIds].sort().join(',');
  const hit = arrivalCache.get(cacheKey);
  if (hit && Date.now() - hit.at < ARRIVAL_TTL) return res.json(hit.data);

  const feedUrls = [...new Set(parentStopIds.map(feedUrlForStopId).filter(Boolean))];
  const isAtlantic = parentStopIds.some(id => ATLANTIC_PARENT_STOPS.has(id));
  const routeIds = routesForStopIds(parentStopIds);

  const arrivalTasks = feedUrls.map(url =>
    fetchAndParse(url).then(feed => extractSubwayArrivals(feed, parentStopIds))
  );
  if (isAtlantic) {
    arrivalTasks.push(fetchAndParse(LIRR_FEED_URL).then(feed => extractLIRRJamaicaArrivals(feed)));
  }

  // Fetch alerts in parallel with arrivals; never let it block the response
  const [results, alerts] = await Promise.all([
    Promise.allSettled(arrivalTasks),
    fetchAndParse(ALERTS_FEED_URL)
      .then(feed => extractAlerts(feed, routeIds, parentStopIds))
      .catch(() => []),
  ]);

  const errors = results.filter(r => r.status === 'rejected').map(r => r.reason.message);
  if (errors.length) console.warn('Feed errors:', errors.join(' | '));

  const arrivals = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .sort((a, b) => a.minutes - b.minutes);

  const data = { updated: Date.now(), arrivals, alerts, feedErrors: errors };
  arrivalCache.set(cacheKey, { at: Date.now(), data });
  res.json(data);
});

loadStations().catch(err => console.warn('Station preload failed:', err.message));
app.listen(PORT, () => console.log(`http://localhost:${PORT}`));
