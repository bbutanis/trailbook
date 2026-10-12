'use strict';
const $ = id => document.getElementById(id);
const DAY_COLORS = ['#e4572e', '#2e86ab', '#7b2cbf', '#2a9d3f', '#d4a017', '#c2185b', '#00897b', '#5d4037'];

// ---------- storage (IndexedDB) ----------
const dbp = new Promise((res, rej) => {
  const r = indexedDB.open('trailbook', 1);
  r.onupgradeneeded = () => {
    const d = r.result;
    d.createObjectStore('trips', { keyPath: 'id' });
    d.createObjectStore('points', { keyPath: 'id', autoIncrement: true }).createIndex('trip', 'tripId');
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
function run(store, mode, fn) {
  return dbp.then(d => new Promise((res, rej) => {
    const t = d.transaction(store, mode), s = t.objectStore(store);
    let out; const req = fn(s);
    if (req && 'onsuccess' in req) req.onsuccess = () => { out = req.result; };
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
  }));
}
const getTrips = () => run('trips', 'readonly', s => s.getAll());
const putTrip = trip => run('trips', 'readwrite', s => s.put(trip));
const getPoints = tripId => run('points', 'readonly', s => s.index('trip').getAll(tripId));
const addPoints = pts => run('points', 'readwrite', s => { pts.forEach(p => s.add(p)); });
function deleteTrip(tripId) {
  return dbp.then(d => new Promise((res, rej) => {
    const t = d.transaction(['trips', 'points'], 'readwrite');
    t.objectStore('trips').delete(tripId);
    const cur = t.objectStore('points').index('trip').openKeyCursor(IDBKeyRange.only(tripId));
    cur.onsuccess = () => { const c = cur.result; if (c) { t.objectStore('points').delete(c.primaryKey); c.continue(); } };
    t.oncomplete = res; t.onerror = () => rej(t.error);
  }));
}

// ---------- state ----------
const state = { trips: [], tripId: null, points: [], hidden: new Set(), recording: false, watchId: null, wake: null, lastLive: null };
const pref = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
const trip = () => state.trips.find(t => t.id === state.tripId);

// ---------- dates ----------
const pad = n => String(n).padStart(2, '0');
const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const startOf = ymd => new Date(ymd + 'T00:00:00').getTime();
const endOf = ymd => new Date(ymd + 'T23:59:59.999').getTime();
const fmtDay = ymd => new Date(ymd + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const fmtRange = (a, b) => a === b ? fmtDay(a) : `${fmtDay(a)} – ${fmtDay(b)}`;
const today = () => dayKey(Date.now());

// ---------- map ----------
const map = L.map('map', { zoomControl: false, attributionControl: true }).setView([54.6872, 25.2797], 13);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);
L.control.zoom({ position: 'topright' }).addTo(map);
const layer = L.layerGroup().addTo(map);
let liveMarker = null;

function render(fit) {
  const t = trip();
  layer.clearLayers();
  if (!t) return;
  $('dates').textContent = fmtRange(t.start, t.end);

  const track = state.points.filter(p => p.kind !== 'visit').sort((a, b) => a.t - b.t);
  const visits = state.points.filter(p => p.kind === 'visit');
  const byDay = new Map();
  for (const p of track) { const k = dayKey(p.t); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(p); }
  for (const v of visits) { const k = dayKey(v.t); if (!byDay.has(k)) byDay.set(k, []); }
  const days = [...byDay.keys()].sort();

  let total = 0; const bounds = [];
  const chips = $('days'); chips.textContent = '';
  days.forEach((k, i) => {
    const color = DAY_COLORS[i % DAY_COLORS.length];
    const segs = TB.segment(byDay.get(k));
    const km = segs.reduce((s, g) => s + TB.segLength(g), 0) / 1000;
    total += km;
    const off = state.hidden.has(k);
    if (!off) {
      for (const g of segs) {
        const ll = g.map(p => [p.lat, p.lng]);
        L.polyline(ll, { color, weight: 18, opacity: .16, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(layer);
        L.polyline(ll, { color, weight: 3.5, opacity: .95, lineCap: 'round', lineJoin: 'round' })
          .bindTooltip(`${fmtDay(k)} · ${km.toFixed(1)} km`, { sticky: true }).addTo(layer);
        bounds.push(...ll);
      }
      for (const v of visits.filter(v => dayKey(v.t) === k)) {
        const mins = Math.round((v.end - v.t) / 60000);
        const time = new Date(v.t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        L.circleMarker([v.lat, v.lng], { radius: 6, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 })
          .bindPopup(`<b>${v.name ? v.name.replace(/</g, '&lt;') : 'Stop'}</b><br>${time}${mins > 0 ? ` · ${mins} min` : ''}`).addTo(layer);
        bounds.push([v.lat, v.lng]);
      }
    }
    const b = document.createElement('button');
    b.className = 'day' + (off ? ' off' : ''); b.style.setProperty('--c', color);
    b.setAttribute('aria-pressed', String(!off));
    b.innerHTML = `<i></i>${fmtDay(k)} <small>${km.toFixed(1)} km</small>`;
    b.onclick = () => {
      if (off) state.hidden.delete(k);
      else if (state.hidden.size === 0 && days.length > 1) { days.forEach(d => d !== k && state.hidden.add(d)); } // solo this day
      else state.hidden.add(k);
      render(true);
    };
    chips.appendChild(b);
  });

  $('sKm').textContent = total.toFixed(1);
  $('sDays').textContent = days.length;
  $('sStops').textContent = visits.length;
  $('empty').hidden = days.length > 0;
  chips.hidden = days.length === 0;
  if (fit && bounds.length) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });
}

function renderTripSelect() {
  const sel = $('tripSelect'); sel.textContent = '';
  for (const t of [...state.trips].sort((a, b) => b.start.localeCompare(a.start))) {
    const o = document.createElement('option'); o.value = t.id; o.textContent = t.name; sel.appendChild(o);
  }
  sel.value = state.tripId;
}

async function selectTrip(id) {
  state.tripId = id; state.hidden.clear(); pref.set('tripId', id);
  state.points = await getPoints(id);
  renderTripSelect(); render(true);
}

// ---------- toast ----------
let toastTimer;
function toast(msg, ms = 3500) {
  const el = $('toast'); el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ---------- trip dialog ----------
let editing = null, deleteArmed = false;
function openTripDialog(t) {
  editing = t; deleteArmed = false;
  $('tripDialogTitle').textContent = t ? 'Edit trip' : 'New trip';
  $('fName').value = t ? t.name : '';
  $('fStart').value = t ? t.start : today();
  $('fEnd').value = t ? t.end : today();
  $('deleteBtn').hidden = !t || state.trips.length < 2;
  $('deleteBtn').textContent = 'Delete trip';
  $('tripDialog').showModal();
}
$('editBtn').onclick = () => openTripDialog(trip());
$('newBtn').onclick = () => openTripDialog(null);
$('cancelBtn').onclick = () => $('tripDialog').close();
$('tripForm').onsubmit = async e => {
  e.preventDefault();
  let start = $('fStart').value, end = $('fEnd').value;
  if (end < start) [start, end] = [end, start];
  const t = editing ? { ...editing, name: $('fName').value.trim(), start, end }
    : { id: 'trip-' + Date.now(), name: $('fName').value.trim(), start, end };
  await putTrip(t);
  state.trips = await getTrips();
  $('tripDialog').close();
  await selectTrip(t.id);
};
$('deleteBtn').onclick = async () => {
  if (!deleteArmed) { deleteArmed = true; $('deleteBtn').textContent = 'Tap again to delete'; return; }
  const name = editing.name;
  await deleteTrip(editing.id);
  state.trips = await getTrips();
  $('tripDialog').close();
  await selectTrip(state.trips[0].id);
  toast(`Deleted “${name}”.`);
};
$('tripSelect').onchange = e => selectTrip(e.target.value);

// ---------- import ----------
$('importBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = async e => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  const t = trip();
  toast('Reading ' + file.name + '…', 60000);
  let parsed;
  try { parsed = TB.parseFile(file.name, await file.text()); }
  catch { toast('That file isn’t a Timeline JSON or GPX file. Export Timeline from Settings → Location → Timeline.'); return; }

  const lo = startOf(t.start), hi = endOf(t.end);
  const inRange = p => p.t >= lo && p.t <= hi;
  const seen = new Set(state.points.map(p => `${p.kind}|${p.t}|${p.lat.toFixed(5)}|${p.lng.toFixed(5)}`));
  const fresh = [];
  const take = (p, kind, extra) => {
    if (!inRange(p)) return;
    const key = `${kind}|${p.t}|${p.lat.toFixed(5)}|${p.lng.toFixed(5)}`;
    if (seen.has(key)) return; seen.add(key);
    fresh.push({ tripId: t.id, kind, lat: p.lat, lng: p.lng, t: p.t, src: 'import', ...extra });
  };
  parsed.track.forEach(p => take(p, 'track'));
  parsed.visits.forEach(v => take(v, 'visit', { end: v.end, name: v.name }));

  if (!fresh.length) {
    const all = parsed.track.concat(parsed.visits);
    if (!all.length) { toast('No location points found in that file.'); return; }
    const ts = all.map(p => p.t);
    const a = dayKey(Math.min(...ts)), b = dayKey(Math.max(...ts));
    const already = all.some(inRange);
    toast(already ? 'Everything in that file is already on this trip.'
      : `Nothing between ${fmtRange(t.start, t.end)}. The file covers ${fmtRange(a, b)}. Edit the trip dates and import again.`, 7000);
    return;
  }
  await addPoints(fresh);
  state.points = await getPoints(t.id);
  render(true);
  toast(`Added ${fresh.length.toLocaleString()} points to ${t.name}.`);
};

// ---------- export ----------
$('exportBtn').onclick = () => {
  const t = trip();
  const track = state.points.filter(p => p.kind !== 'visit').sort((a, b) => a.t - b.t);
  const visits = state.points.filter(p => p.kind === 'visit');
  if (!track.length && !visits.length) { toast('Nothing to export yet.'); return; }
  const blob = new Blob([TB.toGPX(t.name, track, visits)], { type: 'application/gpx+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${t.name.replace(/[^\w-]+/g, '_')}_${t.start}.gpx`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

// ---------- live recording ----------
const recBtn = $('recBtn');
function setRecUI() {
  recBtn.className = state.recording ? 'rec' : 'primary';
  recBtn.innerHTML = `<span class="rec-dot"></span>${state.recording ? 'Stop' : 'Record'}`;
  $('status').hidden = !state.recording;
}
async function keepAwake() {
  try { state.wake = await navigator.wakeLock?.request('screen'); } catch { state.wake = null; }
}
document.addEventListener('visibilitychange', () => { if (state.recording && document.visibilityState === 'visible') keepAwake(); });

async function onPosition(pos) {
  const { latitude: lat, longitude: lng, accuracy } = pos.coords;
  const p = { lat, lng, t: pos.timestamp || Date.now() };
  if (!liveMarker) liveMarker = L.circleMarker([lat, lng], { radius: 8, color: '#fff', weight: 3, fillColor: '#1a73e8', fillOpacity: 1 }).addTo(map);
  liveMarker.setLatLng([lat, lng]);
  $('status').textContent = `Recording · ±${Math.round(accuracy)} m · keep the screen on`;
  if (accuracy > 50) return;
  const last = state.lastLive;
  if (last && TB.haversine(last, p) < 8) return;
  state.lastLive = p;

  const t = trip();
  const k = dayKey(p.t);
  if (k > t.end || k < t.start) {
    t.end = k > t.end ? k : t.end; t.start = k < t.start ? k : t.start;
    await putTrip(t);
  }
  const rec = { tripId: t.id, kind: 'track', lat, lng, t: p.t, src: 'live' };
  await addPoints([rec]);
  state.points.push(rec);
  render(false);
}

recBtn.onclick = async () => {
  if (state.recording) {
    navigator.geolocation.clearWatch(state.watchId);
    state.recording = false; state.lastLive = null;
    try { await state.wake?.release(); } catch {}
    if (liveMarker) { map.removeLayer(liveMarker); liveMarker = null; }
    setRecUI(); toast('Recording stopped.');
    return;
  }
  if (!('geolocation' in navigator)) { toast('This browser can’t share your location.'); return; }
  state.recording = true; setRecUI();
  $('status').textContent = 'Waiting for GPS…';
  keepAwake();
  state.watchId = navigator.geolocation.watchPosition(onPosition, err => {
    state.recording = false; setRecUI();
    toast(err.code === 1 ? 'Location is blocked. Allow location for this site in Chrome’s site settings.' : 'Couldn’t get a GPS fix. Try again outdoors.', 6000);
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
};

// ---------- boot ----------
(async function boot() {
  state.trips = await getTrips();
  if (!state.trips.length) {
    const first = { id: 'trip-vilnius', name: 'Vilnius', start: '2026-10-10', end: '2026-10-12' };
    await putTrip(first); state.trips = [first];
  }
  const saved = pref.get('tripId');
  await selectTrip(state.trips.some(t => t.id === saved) ? saved : state.trips[0].id);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
