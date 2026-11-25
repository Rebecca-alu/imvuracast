process.env.OPENWEATHER_API_KEY = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  app, cleanPlaceName, cleanCoordinates, adviseDay, fieldDayScore, TTLCache, summariseDays,
} = require('./server');

const niceDay = { minTemp: 15, maxTemp: 25, totalRain: 5, rainChance: 20, maxWind: 3, avgHumidity: 60 };

test('a mild, lightly rainy, calm day is good for planting and spraying', () => {
  const result = adviseDay(niceDay);
  assert.equal(result.activities.planting.ok, true);
  assert.equal(result.activities.spraying.ok, true);
  assert.equal(result.activities.irrigation.ok, false);
});

test('a hot dry day needs irrigation and is not good for planting', () => {
  const result = adviseDay({ ...niceDay, maxTemp: 31, totalRain: 0, rainChance: 0 });
  assert.equal(result.activities.irrigation.ok, true);
  assert.equal(result.activities.planting.ok, false);
});

test('heavy rain and strong wind create warnings', () => {
  const result = adviseDay({ ...niceDay, totalRain: 30, maxWind: 12, rainChance: 95 });
  assert.equal(result.warnings.length, 2);
  assert.equal(result.activities.spraying.ok, false);
});

test('field day score always stays between 0 and 100', () => {
  assert.equal(fieldDayScore({ ...niceDay, rainChance: 0, totalRain: 0 }), 100);
  assert.equal(fieldDayScore({ ...niceDay, rainChance: 100, totalRain: 80, maxWind: 30, maxTemp: 45 }), 0);
});

test('accepts real place names and rejects dangerous ones', () => {
  assert.equal(cleanPlaceName('  Musanze ').value, 'Musanze');
  assert.equal(cleanPlaceName('São Paulo, BR').ok, true);
  assert.equal(cleanPlaceName('').ok, false);
  assert.equal(cleanPlaceName('a'.repeat(61)).ok, false);
  assert.equal(cleanPlaceName('<script>alert(1)</script>').ok, false);
  assert.equal(cleanPlaceName("Kigali'; DROP TABLE users;--").ok, false);
});

test('checks coordinates', () => {
  assert.deepEqual(cleanCoordinates('-1.944', '30.06191').value, { lat: -1.944, lon: 30.0619 });
  assert.equal(cleanCoordinates('100', '30').ok, false);
  assert.equal(cleanCoordinates('abc', '30').ok, false);
  assert.equal(cleanCoordinates('', '30').ok, false);
});

test('cache expires values and removes the oldest when full', async () => {
  const cache = new TTLCache(30, 2);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('c'), 3);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(cache.get('c'), undefined);
});

test('summariseDays groups 3-hour slots by local date', () => {
  const slot = (dt, temp, rain) => ({
    dt,
    main: { temp, temp_min: temp - 1, temp_max: temp + 1, humidity: 70 },
    weather: [{ main: 'Rain', description: 'light rain', icon: '10d' }],
    wind: { speed: 2 },
    pop: 0.5,
    rain: { '3h': rain },
  });
  const days = summariseDays([slot(1795514400, 20, 1), slot(1795525200, 24, 2), slot(1795600800, 22, 0)], 7200);
  assert.equal(days.length, 2);
  assert.equal(days[0].date, '2026-11-24');
  assert.equal(days[0].totalRain, 3);
  assert.equal(days[0].maxTemp, 25);
  assert.equal(typeof days[0].score, 'number');
});

test('server routes respond with clean JSON', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.ok(health.headers.get('x-served-by'));
  assert.equal((await fetch(`${base}/api/places?q=${encodeURIComponent('<b>')}`)).status, 400);
  assert.equal((await fetch(`${base}/api/forecast?lat=999&lon=1`)).status, 400);
  const noKey = await fetch(`${base}/api/places?q=Kigali`);
  assert.equal(noKey.status, 500);
  assert.match((await noKey.json()).error, /API key/);
  assert.equal((await fetch(`${base}/api/nothing-here`)).status, 404);
});
