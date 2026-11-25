(() => {
  'use strict'; const MAX_SAVED = 6, PLACE_PATTERN = /^[\p{L}\s,.'-]+$/u, HINT = 'Type a town or city, then choose the right one from the list.';
  const LABELS = { planting: 'Planting', spraying: 'Spraying', harvesting: 'Harvesting', irrigation: 'Irrigation' };
  const ui = Object.fromEntries(['searchForm', 'placeInput', 'searchBtn', 'formHint', 'placeResults', 'savedWrap', 'savedList', 'statusBox', 'results', 'placeTitle',
    'placeMeta', 'saveBtn', 'sortSelect', 'activitySelect', 'weatherSelect', 'chart', 'countText', 'dayGrid', 'unitToggle', 'serverBadge'].map((id) => [id, document.getElementById(id)]));
  const state = { forecast: null, place: null, unit: 'C', saved: [] };
  const load = (key, fallback) => { try { const raw = localStorage.getItem(`imvuracast:${key}`); return raw === null ? fallback : JSON.parse(raw); } catch { return fallback; } };
  const save = (key, value) => { try { localStorage.setItem(`imvuracast:${key}`, JSON.stringify(value)); } catch { return; } };
  const el = (tag, props = {}, children = []) => { const node = document.createElement(tag);
    Object.entries(props).forEach(([k, v]) => { if (k in node) node[k] = v; else node.setAttribute(k, v); });
    node.append(...children.map((c) => (c instanceof Node ? c : String(c)))); return node; };
  const toUnit = (c) => (state.unit === 'F' ? (c * 9) / 5 + 32 : c), fmtTemp = (c) => `${Math.round(toUnit(c))}°${state.unit}`;
  const fmtPlace = (p) => [p.name, p.state, p.country].filter(Boolean).join(', '), sameSpot = (a, b) => a.lat === b.lat && a.lon === b.lon;
  const fmtDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const scoreClass = (s) => (s >= 70 ? 'good' : s >= 40 ? 'okay' : 'poor');
  const hideStatus = () => { ui.statusBox.hidden = true; };
  function showStatus(message, type = 'info', retry = null) { ui.statusBox.className = `status ${type === 'error' ? 'error' : ''}`;
    ui.statusBox.replaceChildren(...(type === 'loading' ? [el('span', { className: 'spinner' })] : []), message);
    if (retry) ui.statusBox.append(el('button', { type: 'button', textContent: 'Try again', onclick: retry })); ui.statusBox.hidden = false; }
  async function apiGet(url) {
    if (!navigator.onLine) throw new Error('You seem to be offline. Check your internet connection.');
    const response = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { Accept: 'application/json' } }).catch((err) => {
      throw new Error(err.name === 'TimeoutError' ? 'The request took too long. Please try again.' : 'Could not reach the ImvuraCast server. Please try again.'); });
    const servedBy = response.headers.get('X-Served-By'); if (servedBy) ui.serverBadge.textContent = `server: ${servedBy.split(',')[0].trim()}`;
    const data = await response.json().catch(() => { throw new Error('The server sent an unexpected answer. Please try again.'); });
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`); return data;
  }
  async function searchPlaces(rawName) {
    const name = rawName.replace(/\s+/g, ' ').trim(), valid = name.length >= 2 && name.length <= 60 && PLACE_PATTERN.test(name);
    ui.formHint.textContent = valid ? HINT : 'Please type 2–60 letters (commas, dots, hyphens and apostrophes are fine).';
    ui.formHint.classList.toggle('error', !valid); if (!valid) return ui.placeInput.focus();
    Object.assign(ui.searchBtn, { disabled: true, textContent: 'Searching…' }); ui.placeResults.hidden = true; showStatus(`Looking for "${name}"…`, 'loading');
    try {
      const { places } = await apiGet(`/api/places?q=${encodeURIComponent(name)}`); hideStatus(); if (places.length === 1) return loadForecast(places[0]);
      ui.placeResults.replaceChildren(...places.map((p) => el('li', {}, [el('button', { type: 'button', textContent: `📍 ${fmtPlace(p)}  (${p.lat}, ${p.lon})`,
        onclick: () => { ui.placeResults.hidden = true; loadForecast(p); } })]))); ui.placeResults.hidden = false;
    } catch (err) { showStatus(err.message, 'error', () => searchPlaces(name)); } finally { Object.assign(ui.searchBtn, { disabled: false, textContent: 'Search' }); }
  }
  async function loadForecast(place) {
    state.place = place; showStatus(`Getting the 5-day forecast for ${fmtPlace(place)}…`, 'loading');
    try { const data = await apiGet(`/api/forecast?lat=${place.lat}&lon=${place.lon}`);
      if (!data.days || data.days.length === 0) throw new Error('No forecast days came back for this place.');
      state.forecast = data; save('lastPlace', place); hideStatus(); renderForecast(); } catch (err) { showStatus(err.message, 'error', () => loadForecast(place)); }
  }
  const SORTERS = { date: (a, b) => a.date.localeCompare(b.date), score: (a, b) => b.score - a.score, rainDesc: (a, b) => b.totalRain - a.totalRain,
    rainAsc: (a, b) => a.totalRain - b.totalRain, tempDesc: (a, b) => b.maxTemp - a.maxTemp, windAsc: (a, b) => a.maxWind - b.maxWind };
  const visibleDays = () => state.forecast.days.filter((d) => ui.activitySelect.value === 'all' || d.activities[ui.activitySelect.value].ok)
    .filter((d) => ui.weatherSelect.value === 'all' || (ui.weatherSelect.value === 'dry' ? d.totalRain < 1 : d.totalRain >= 1)).sort(SORTERS[ui.sortSelect.value] || SORTERS.date);
  function renderForecast() {
    const { place, fetchedAt, cached, days } = state.forecast, updated = new Date(fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    ui.placeTitle.textContent = fmtPlace(state.place || place); ui.placeMeta.textContent = `Sunrise ${place.sunrise} · Sunset ${place.sunset} (local time) · Updated ${updated}${cached ? ' (from cache)' : ''}`;
    updateSaveButton(); renderChart(days); renderCards(); ui.results.hidden = false;
  }
  function renderCards() { const days = visibleDays(); ui.countText.textContent = `Showing ${days.length} of ${state.forecast.days.length} days`;
    ui.dayGrid.replaceChildren(...(days.length ? days.map(buildDayCard) : [el('div', { className: 'empty' }, ['No days match these filters. Try "Any activity" or "All days".'])]));
  }
  function buildDayCard(day) {
    const hours = el('table', { className: 'hours', hidden: true }, [el('thead', {}, [el('tr', {}, ['Time', 'Temp', 'Rain', 'Chance', 'Wind'].map((h) => el('th', {}, [h])))]),
      el('tbody', {}, day.slots.map((s) => el('tr', {}, [s.time, fmtTemp(s.temp), `${s.rain} mm`, `${s.rainChance}%`, `${s.wind} m/s`].map((v) => el('td', {}, [v])))))]);
    const toggle = el('button', { type: 'button', className: 'toggle-hours', textContent: 'See 3-hour details',
      onclick: () => { hours.hidden = !hours.hidden; toggle.textContent = `${hours.hidden ? 'See' : 'Hide'} 3-hour details`; } });
    const stats = [['Temp', `${fmtTemp(day.minTemp)} – ${fmtTemp(day.maxTemp)}`], ['Rain', `${day.totalRain} mm (${day.rainChance}%)`], ['Wind', `${day.maxWind} m/s`],
      ['Humidity', `${day.avgHumidity}%`]].flatMap(([label, value]) => [el('dt', {}, [label]), el('dd', {}, [value])]);
    const advice = Object.entries(day.activities).map(([key, r]) => el('li', { className: r.ok ? 'yes' : '', title: r.reason }, [el('strong', {}, [`${r.ok ? '✅' : '➖'} ${LABELS[key]}`]), r.reason]));
    return el('article', { className: `day-card ${scoreClass(day.score)}` }, [el('div', { className: 'day-top' }, [el('h3', {}, [fmtDay(day.date)]),
      el('img', { src: `https://openweathermap.org/img/wn/${encodeURIComponent(day.icon)}@2x.png`, alt: day.description, loading: 'lazy' })]),
      el('p', { className: 'desc' }, [day.description]), el('span', { className: 'score' }, [`Field day score: ${day.score}/100`]), el('dl', { className: 'stats' }, stats),
      el('ul', { className: 'advice' }, advice), ...day.warnings.map((w) => el('p', { className: 'warning' }, [`⚠️ ${w}`])), toggle, hours]);
  }
  function renderChart(days) {
    const W = 640, H = 230, top = 24, plotH = H - top - 34, step = (W - 40) / days.length, maxRain = Math.max(10, ...days.map((d) => d.totalRain));
    const temps = days.map((d) => toUnit(d.maxTemp)), tMin = Math.min(...temps) - 3, tMax = Math.max(...temps) + 3;
    const svgEl = (tag, attrs, text) => { const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
      Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v)); if (text !== undefined) node.textContent = text; return node; };
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Daily rain and maximum temperature' });
    const points = days.map((d, i) => {
      const cx = 20 + step * i + step / 2, barH = (d.totalRain / maxRain) * plotH, barW = Math.min(46, step * 0.5), ty = top + plotH - ((temps[i] - tMin) / (tMax - tMin)) * plotH;
      svg.append(svgEl('rect', { class: 'bar', x: cx - barW / 2, y: top + plotH - barH, width: barW, height: Math.max(barH, 1), rx: 4 }),
        svgEl('text', { class: 'value', x: cx, y: top + plotH - barH - 4 }, `${d.totalRain} mm`), svgEl('text', { class: 'label', x: cx, y: H - 10 }, fmtDay(d.date)),
        svgEl('text', { class: 'value', x: cx + 18, y: ty - 8 }, `${Math.round(temps[i])}°`)); return [cx, ty]; });
    svg.append(svgEl('polyline', { class: 'line', points: points.map((p) => p.join(',')).join(' ') }), ...points.map(([x, y]) => svgEl('circle', { class: 'dot', cx: x, cy: y, r: 5 })));
    ui.chart.replaceChildren(svg); }
  const setSaved = (list) => { state.saved = list.slice(0, MAX_SAVED); save('savedPlaces', state.saved); renderSaved(); updateSaveButton(); };
  function renderSaved() {
    ui.savedWrap.hidden = state.saved.length === 0;
    ui.savedList.replaceChildren(...state.saved.map((p) => el('span', { className: 'chip' }, [el('button', { type: 'button', textContent: p.name, title: fmtPlace(p), onclick: () => loadForecast(p) }),
      el('button', { type: 'button', className: 'remove', textContent: '×', 'aria-label': `Remove ${p.name}`, onclick: () => setSaved(state.saved.filter((s) => !sameSpot(s, p))) })])));
  }
  function updateSaveButton() { ui.saveBtn.textContent = state.place && state.saved.some((s) => sameSpot(s, state.place)) ? '★ Saved' : '☆ Save place'; }
  function toggleSave() { if (!state.place) return; const { name, state: region, country, lat, lon } = state.place;
    setSaved(state.saved.some((s) => sameSpot(s, state.place)) ? state.saved.filter((s) => !sameSpot(s, state.place)) : [{ name, state: region, country, lat, lon }, ...state.saved]); }
  function applyUnit() { ui.unitToggle.textContent = `°${state.unit}`; ui.unitToggle.title = `Showing °${state.unit} – click to switch`; if (state.forecast) renderForecast(); }
  function init() {
    const saved = load('savedPlaces', []), last = load('lastPlace', null);
    state.unit = load('unit', 'C') === 'F' ? 'F' : 'C'; state.saved = Array.isArray(saved) ? saved.slice(0, MAX_SAVED) : [];
    ui.searchForm.addEventListener('submit', (e) => { e.preventDefault(); searchPlaces(ui.placeInput.value); });
    [ui.sortSelect, ui.activitySelect, ui.weatherSelect].forEach((s) => s.addEventListener('change', () => { if (state.forecast) renderCards(); }));
    ui.saveBtn.addEventListener('click', toggleSave); ui.unitToggle.addEventListener('click', () => { state.unit = state.unit === 'C' ? 'F' : 'C'; save('unit', state.unit); applyUnit(); });
    window.addEventListener('offline', () => showStatus('You are offline. Results will update when you reconnect.', 'error'));
    window.addEventListener('online', hideStatus); applyUnit(); renderSaved();
    apiGet('/api/health').catch(() => { ui.serverBadge.textContent = 'server: offline'; });
    if (last && typeof last.lat === 'number' && typeof last.lon === 'number') loadForecast(last);
  }
  init();
})();
