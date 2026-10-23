// Flight Weather Briefing - small proxy so the browser never calls other sites directly (avoids CORS).
const express = require('express');
const path = require('path');
const app = express();
const UA = 'FlightWxTrainingApp/1.0';
const AWC = 'https://aviationweather.gov/api/data/';
const cache = new Map();

async function getJson(url, ttlMs) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
  let v = null;
  if (r.status === 200) {
    const txt = (await r.text()).trim();
    v = txt ? JSON.parse(txt) : null;
  } else if (r.status !== 204) {
    throw new Error('Upstream HTTP ' + r.status);
  }
  cache.set(url, { t: Date.now(), v });
  return v;
}

// Airport coordinates, used only when an airport publishes no METAR/TAF (so a model forecast can be shown).
// 1st choice: NOAA AWC airport database. 2nd: OurAirports (public domain).
let oaPromise = null;
function loadOurAirports() {
  if (!oaPromise) {
    oaPromise = (async () => {
      const r = await fetch('https://davidmegginson.github.io/ourairports-data/airports.csv', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error('OurAirports HTTP ' + r.status);
      const map = new Map();
      for (const line of (await r.text()).split('\n').slice(1)) {
        const f = []; const re = /("([^"]*)"|[^,]*)(,|$)/g; let m;
        while (f.length < 6 && (m = re.exec(line)) && m[0] !== '') f.push(m[2] !== undefined ? m[2] : m[1]);
        if (f.length >= 6 && f[1]) map.set(f[1], { name: f[3], lat: +f[4], lon: +f[5] });
      }
      return map;
    })().catch(e => { oaPromise = null; throw e; });
  }
  return oaPromise;
}
async function airportInfo(icao) {
  try {
    const a = await getJson(`${AWC}airport?ids=${icao}&format=json`, 24 * 3600e3);
    const x = Array.isArray(a) ? a.find(y => y.icaoId === icao) : null;
    if (x && x.lat != null && x.lon != null) return { lat: +x.lat, lon: +x.lon, name: x.name || '' };
  } catch (e) { console.error('AWC airport lookup failed', e.message); }
  try { return (await loadOurAirports()).get(icao) || null; }
  catch (e) { console.error('OurAirports failed', e.message); return null; }
}

app.get('/api/wx', async (req, res) => {
  const icao = String(req.query.ids || '').toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(icao)) return res.status(400).json({ error: 'Enter a 4-character ICAO code.' });
  const [m, t] = await Promise.allSettled([
    getJson(`${AWC}metar?ids=${icao}&format=json&hours=24`, 5 * 60e3),
    getJson(`${AWC}taf?ids=${icao}&format=json`, 5 * 60e3),
  ]);
  if (m.status === 'rejected' && t.status === 'rejected') {
    console.error('AWC failed', icao, m.reason?.message, t.reason?.message);
    return res.status(502).json({ error: 'Weather source unavailable right now. Try again shortly.' });
  }
  const metars = (m.value || []).filter(x => x.icaoId === icao).sort((a, b) => b.obsTime - a.obsTime);
  const taf = (t.value || []).find(x => x.icaoId === icao) || null;
  let pos = metars[0] || taf, name = pos ? pos.name || '' : '';
  if (!pos || pos.lat == null) { pos = await airportInfo(icao); if (pos) name = name || pos.name; }
  let model = null;
  if (pos && pos.lat != null && pos.lon != null) {
    try {
      const j = await getJson('https://api.open-meteo.com/v1/forecast?latitude=' + pos.lat + '&longitude=' + pos.lon +
        '&hourly=temperature_2m,dew_point_2m,relative_humidity_2m,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,cloud_cover_low,visibility,precipitation,weather_code' +
        '&wind_speed_unit=kn&past_days=1&forecast_days=3&timezone=GMT', 30 * 60e3);
      if (j && j.hourly) model = j.hourly;
    } catch (e) { console.error('Open-Meteo failed', e.message); }
  }
  res.json({ icao, name, metars, taf, model, fetchedAtUtc: new Date().toISOString() });
});

app.use(express.static(path.join(__dirname, 'public')));
app.listen(process.env.PORT || 3000, () => console.log('Listening on ' + (process.env.PORT || 3000)));
