require('dotenv').config();
const os = require('os'), path = require('path'), express = require('express');
const API = 'https://api.openweathermap.org', PORT = Number(process.env.PORT) || 3000, HOST = process.env.HOST || '127.0.0.1';
const HOSTNAME = os.hostname().replace(/[^ -~]/g, '-'), startedAt = Date.now(), PLACE_PATTERN = /^[\p{L}\s,.'-]+$/u;
const RULES = { planting: { minRain: 2, maxRain: 15, minTemp: 15, maxTemp: 30 }, spraying: { maxRainChance: 30, maxWind: 5 },
  harvesting: { maxRainChance: 20, maxHumidity: 75 }, irrigation: { maxRain: 1, minTemp: 27 }, warnings: { heavyRain: 20, strongWind: 10, heat: 33, cold: 8 } };
class TTLCache {
  constructor(ttlMs = 10 * 60 * 1000, maxEntries = 200) { Object.assign(this, { ttlMs, maxEntries, store: new Map() }); }
  get(key) { const e = this.store.get(key); if (e && Date.now() > e.expiresAt) this.store.delete(key); return e && Date.now() <= e.expiresAt ? e.value : undefined; }
  set(key, value) { if (this.store.size >= this.maxEntries && !this.store.has(key)) this.store.delete(this.store.keys().next().value); this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs }); }
}
const cache = new TTLCache(); class AppError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fieldDayScore = (d) => Math.max(0, Math.min(100, Math.round(100 - Math.min(d.rainChance * 0.4, 40) - Math.min(d.totalRain * 1.5, 25) - Math.max(0, d.maxWind - 4) * 4 - Math.max(0, d.maxTemp - 30) * 3 - Math.max(0, 15 - d.maxTemp) * 3)));
function adviseDay(d) {
  const { planting: p, spraying: s, harvesting: h, irrigation: i, warnings: w } = RULES;
  const pick = (checks, okReason) => { const bad = checks.find(([hit]) => hit); return bad ? { ok: false, reason: bad[1] } : { ok: true, reason: okReason }; };
  const planting = pick([[d.totalRain < p.minRain, 'Too dry – seeds need moist soil.'], [d.totalRain > p.maxRain, 'Too much rain – seeds may wash away.'],
    [d.maxTemp < p.minTemp || d.maxTemp > p.maxTemp, 'Temperature is not ideal for germination.']], 'Moist soil and mild warmth – good for sowing.');
  const spraying = pick([[d.rainChance > s.maxRainChance, `Rain chance ${d.rainChance}% – spray may wash off.`], [d.maxWind > s.maxWind, 'Too windy – spray will drift.']], 'Dry and calm – spray will stay on the leaves.');
  const harvesting = pick([[d.rainChance > h.maxRainChance, 'Rain is likely – harvest may get wet.'], [d.avgHumidity > h.maxHumidity, 'Air is humid – drying will be slow.']], 'Dry air – good for harvesting and drying.');
  const irrigation = pick([[!(d.totalRain <= i.maxRain && d.maxTemp >= i.minTemp), 'No extra watering needed.']], 'Hot and dry – plan to water your crops.');
  const warnings = [[d.totalRain >= w.heavyRain, 'Heavy rain – watch for soil erosion and flooding.'], [d.maxWind >= w.strongWind, 'Strong wind – protect young plants and banana stems.'],
    [d.maxTemp >= w.heat, 'Very hot – animals and workers need shade and water.'], [d.minTemp <= w.cold, 'Cold night – sensitive seedlings may suffer.']].filter(([hit]) => hit).map(([, t]) => t);
  return { score: fieldDayScore(d), activities: { planting, spraying, harvesting, irrigation }, warnings };
}
async function callOpenWeather(route, params) {
  const key = process.env.OPENWEATHER_API_KEY; if (!key || key === 'your_api_key_here') throw new AppError(500, 'The server is missing its weather API key. Please contact the site owner.');
  const url = new URL(route, API); Object.entries({ ...params, appid: key }).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) }).catch((err) => { throw err.name === 'TimeoutError'
    ? new AppError(504, 'The weather service took too long to answer. Please try again.') : new AppError(503, 'Could not reach the weather service. Check your connection or try again later.'); });
  if (!res.ok) { console.error(`[OpenWeatherMap] ${res.status} for ${route}`);
    const known = { 401: [502, 'The weather service rejected our API key.'], 404: [404, 'No weather data found for that place.'], 429: [503, 'Too many weather requests right now. Please wait a minute.'] };
    throw new AppError(...(known[res.status] || [502, 'The weather service is having problems. Please try again later.'])); }
  return res.json().catch(() => { throw new AppError(502, 'The weather service sent an unreadable answer.'); });
}
async function fromCache(key, loader) {
  const hit = cache.get(key); if (hit) return { ...hit, cached: true };
  const value = await loader(); cache.set(key, value); return { ...value, cached: false };
}
const findPlaces = (name) => fromCache(`places:${name.toLowerCase()}`, async () => {
  const data = await callOpenWeather('/geo/1.0/direct', { q: name, limit: 5 }); if (!Array.isArray(data)) throw new AppError(502, 'Unexpected answer from the place search.');
  return { places: data.map((p) => ({ name: p.name, state: p.state || '', country: p.country || '', lat: Number(p.lat.toFixed(4)), lon: Number(p.lon.toFixed(4)) })) };
});
const localTime = (unix, tz, from, to) => new Date((unix + tz) * 1000).toISOString().slice(from, to), round1 = (n) => Math.round(n * 10) / 10;
const rainOf = (s) => (s.rain && s.rain['3h']) || 0, sum = (slots, get) => slots.reduce((a, s) => a + get(s), 0);
const mostCommon = (items) => items.sort((a, b) => items.filter((x) => x === b).length - items.filter((x) => x === a).length)[0];
function summariseDays(list, tz) {
  const groups = {}; list.forEach((slot) => { (groups[localTime(slot.dt, tz, 0, 10)] ||= []).push(slot); });
  return Object.entries(groups).map(([date, slots]) => {
    const day = { date, minTemp: round1(Math.min(...slots.map((s) => s.main.temp_min))), maxTemp: round1(Math.max(...slots.map((s) => s.main.temp_max))),
      avgTemp: round1(sum(slots, (s) => s.main.temp) / slots.length), avgHumidity: Math.round(sum(slots, (s) => s.main.humidity) / slots.length),
      totalRain: round1(sum(slots, rainOf)), rainChance: Math.round(Math.max(...slots.map((s) => s.pop || 0)) * 100), maxWind: round1(Math.max(...slots.map((s) => s.wind.speed))),
      condition: mostCommon(slots.map((s) => s.weather[0].main)), description: mostCommon(slots.map((s) => s.weather[0].description)),
      icon: mostCommon(slots.map((s) => s.weather[0].icon.replace('n', 'd'))),
      slots: slots.map((s) => ({ time: localTime(s.dt, tz, 11, 16), temp: round1(s.main.temp), rain: round1(rainOf(s)), rainChance: Math.round((s.pop || 0) * 100),
        wind: round1(s.wind.speed), description: s.weather[0].description, icon: s.weather[0].icon })) };
    return { ...day, ...adviseDay(day) };
  });
}
const getForecast = (lat, lon) => fromCache(`forecast:${lat},${lon}`, async () => {
  const data = await callOpenWeather('/data/2.5/forecast', { lat, lon, units: 'metric' });
  if (!data || !Array.isArray(data.list) || !data.city) throw new AppError(502, 'Unexpected answer from the forecast service.');
  const { name, country, timezone: tz = 0, sunrise, sunset } = data.city;
  return { place: { name, country, lat, lon, sunrise: localTime(sunrise, tz, 11, 16), sunset: localTime(sunset, tz, 11, 16) }, fetchedAt: new Date().toISOString(), days: summariseDays(data.list, tz) };
});
function cleanPlaceName(raw) {
  if (typeof raw !== 'string') return { ok: false, message: 'Please type a town or city name.' }; const value = raw.replace(/\s+/g, ' ').trim();
  if (value.length < 2 || value.length > 60) return { ok: false, message: `The place name is too ${value.length < 2 ? 'short (at least 2 letters)' : 'long (max 60 characters)'}.` };
  return PLACE_PATTERN.test(value) ? { ok: true, value } : { ok: false, message: 'Use letters only (commas, dots, hyphens and apostrophes are allowed).' };
}
function cleanCoordinates(latRaw, lonRaw) {
  if ([latRaw, lonRaw].some((v) => v === undefined || v === '')) return { ok: false, message: 'Latitude and longitude are both required.' };
  const [lat, lon] = [Number(latRaw), Number(lonRaw)]; if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { ok: false, message: 'Latitude and longitude must be numbers.' };
  return Math.abs(lat) > 90 || Math.abs(lon) > 180 ? { ok: false, message: 'Coordinates are out of range.' } : { ok: true, value: { lat: Number(lat.toFixed(4)), lon: Number(lon.toFixed(4)) } };
}
function rateLimiter(windowMs = 60 * 1000, max = 60) {
  const hits = new Map(); setInterval(() => hits.forEach((r, ip) => { if (Date.now() > r.resetAt) hits.delete(ip); }), windowMs).unref();
  return (req, res, next) => {
    const now = Date.now(), record = hits.get(req.ip);
    if (!record || now > record.resetAt) { hits.set(req.ip, { count: 1, resetAt: now + windowMs }); return next(); }
    if (++record.count <= max) return next();
    const wait = Math.ceil((record.resetAt - now) / 1000); return res.set('Retry-After', String(wait)).status(429).json({ error: `You are searching too fast. Please wait ${wait} seconds.` });
  };
}
const app = express(), route = (check, run) => async (req, res, next) => {
  const result = check(req.query); if (!result.ok) return res.status(400).json({ error: result.message });
  try { return await run(result.value, res); } catch (err) { return next(err); }
};
app.set('trust proxy', true).disable('x-powered-by');
app.use((req, res, next) => { res.set({ 'X-Served-By': HOSTNAME, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' https://openweathermap.org data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'" }); next(); });
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.get('/api/health', (req, res) => res.json({ status: 'ok', server: HOSTNAME, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) }));
app.use('/api', rateLimiter());
app.get('/api/places', route((q) => cleanPlaceName(q.q), async (name, res) => {
  const { places, cached } = await findPlaces(name);
  return places.length ? res.json({ places, cached }) : res.status(404).json({ error: `We could not find "${name}". Check the spelling or try a bigger town nearby.` });
}));
app.get('/api/forecast', route((q) => cleanCoordinates(q.lat, q.lon), async ({ lat, lon }, res) => res.json(await getForecast(lat, lon))));
app.use('/api', (req, res) => res.status(404).json({ error: 'That API route does not exist.' }));
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((err, req, res, next) => { if (!(err instanceof AppError)) console.error('[Unexpected error]', err);
  return err instanceof AppError ? res.status(err.status).json({ error: err.message }) : res.status(500).json({ error: 'Something went wrong on our side. Please try again.' }); });
if (require.main === module && !process.env.OPENWEATHER_API_KEY) console.warn('WARNING: OPENWEATHER_API_KEY is not set. Copy .env.example to .env and add your key.');
if (require.main === module) app.listen(PORT, HOST, () => console.log(`ImvuraCast running on http://${HOST}:${PORT} (server: ${HOSTNAME})`));
module.exports = { app, cleanPlaceName, cleanCoordinates, findPlaces, getForecast, summariseDays, adviseDay, fieldDayScore, TTLCache, AppError };
