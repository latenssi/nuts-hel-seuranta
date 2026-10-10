// Map, UI, data fetching and TV mode. Pure logic lives in format.js, geo.js and race.js (tested in test/).
// Leaflet is loaded as a classic script before this module and used through the global L.
import { pad, clock, dur, km, splitName, escapeHtml, parseClock } from "./format.js";
import { hav, trackFrom, along, sliceBetween } from "./geo.js";
import { eventTime, position, passedAt, finishInfo, collectRows, nutsEvents, defaultEvent } from "./race.js";

// Runners are chosen by search, or by ?pid=<RaceResult id>,... / ?bib=<number>,... in the link.
const qs = new URLSearchParams(location.search);
const list = p => (qs.get(p) || "").split(",").map(x => x.trim()).filter(Boolean);
const pids = list("pid"), bibs = list("bib");
// Links from before the event picker carry no event; they were all NUTS HEL 2026.
let EVENT = qs.get("event") || (pids.length || bibs.length ? "371720" : null);
// Replay of a past race: ?replay=HH:MM[:SS]&speed=N runs an event clock from that time of day, using actual split times.
const REPLAY = parseClock(qs.get("replay"));
const SPEED = +qs.get("speed") || 1, replayT0 = Date.now();
const TV = qs.get("tv") === "1";
const ZOOM = +qs.get("zoom") || null; // follow zoom level from the link, e.g. &zoom=15
document.documentElement.classList.toggle("tv", TV);
const replayClock = () => REPLAY + (Date.now() - replayT0) / 1000 * SPEED;
let server = "https://my2.raceresult.com";

const $ = id => document.getElementById(id);

// ---------- map ----------
const map = L.map("map", {
  zoomControl: true, preferCanvas: false,
  // Lines are clipped to the view plus this margin and only re-cut after a move; TV glides far, so draw a wide margin.
  renderer: L.svg({ padding: TV ? 1 : 0.1 }),
  // TV mode is hands-off: no dragging or zooming that would stop following.
  ...(TV && { dragging: false, touchZoom: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false })
}).setView([60.1904, 24.9313], 14);
const followZoom = () => ZOOM || Math.max(map.getZoom(), 16);
// TV: a calm camera. The map stays still while the marker moves; when the runner nears the edge of the
// area not covered by the card, the map glides so the runner sits behind centre with the route ahead in view.
const TV_ZOOM = ZOOM || 17;
let tvShown = null, tvBusy = false;
const tvMove = fn => { tvBusy = true; map.once("moveend", () => { tvBusy = false; }); fn(); };
function tvFollow(r, pos, track, gpxM) {
  const card = document.querySelector(".card").getBoundingClientRect(), size = map.getSize();
  const x0 = card.right, w = size.x - x0;
  const mPerPx = 40075016.686 * Math.cos(pos[0] * Math.PI / 180) / 2 ** (TV_ZOOM + 8);
  const ahead = along(track, gpxM + w * 0.25 * mPerPx).latlng;
  // Centre of the free area on the look-ahead point.
  const center = map.unproject(map.project(ahead, TV_ZOOM).subtract([x0 / 2, 0]), TV_ZOOM);
  if (tvBusy) return; // wait for the current glide or flight to finish
  if (tvShown !== r.pid) {
    const first = tvShown === null;
    tvShown = r.pid;
    if (first) map.setView(center, TV_ZOOM, { animate: false });
    // Glide at the same zoom (a near runner) or jump (a far one). flyTo changes zoom mid-move, and lines being
    // redrawn 4×/s during it get projected at the wrong scale and wander across the map.
    else tvMove(() => map.setView(center, TV_ZOOM, { pan: { duration: 1.5 } }));
    return;
  }
  const p = map.latLngToContainerPoint(pos);
  if (p.x < x0 + w * 0.2 || p.x > size.x - w * 0.2 || p.y < size.y * 0.2 || p.y > size.y * 0.8)
    tvMove(() => map.setView(center, TV_ZOOM, { animate: true, pan: { duration: 1.5 } }));
}
const helOrto = L.tileLayer.wms("https://kartta.hel.fi/ws/geoserver/avoindata/wms", {
  layers: "avoindata:Ortoilmakuva", format: "image/jpeg", maxZoom: 20, maxNativeZoom: 19,
  attribution: 'Ilmakuva © <a href="https://kartta.hel.fi">Helsingin kaupunki</a>, <a href="https://creativecommons.org/licenses/by/4.0/deed.fi">CC BY 4.0</a>'
});
// HSY covers the whole capital region (Espoo, Vantaa too), open data CC BY 4.0, no API key.
const HSY = "https://kartta.hsy.fi/geoserver/wms";
const hsyCredit = '© <a href="https://www.hsy.fi/avoindata">HSY</a>, <a href="https://creativecommons.org/licenses/by/4.0/deed.fi">CC BY 4.0</a>';
const hsyOrto = L.tileLayer.wms(HSY, {
  layers: "taustakartat_ja_aluejaot:Ortoilmakuva_2023", format: "image/jpeg", maxZoom: 20, maxNativeZoom: 19,
  attribution: "Ilmakuva " + hsyCredit
});
const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 20, maxNativeZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'
});
const labels = L.tileLayer.wms(HSY, {
  layers: "taustakartat_ja_aluejaot:seutukartta_tiesto,taustakartat_ja_aluejaot:seutukartta_nimisto",
  format: "image/png", transparent: true, maxZoom: 20, maxNativeZoom: 19, opacity: 0.8,
  attribution: "Tiet ja nimet " + hsyCredit
});
const narrow = matchMedia("(max-width: 600px)").matches;
helOrto.addTo(map);
// Helsinki and HSY aerial imagery only cover the capital region; elsewhere (e.g. NUTS Pyhä) start on OSM.
const HEL_AREA = L.latLngBounds([60.0, 24.76], [60.33, 25.29]), HSY_AREA = L.latLngBounds([59.95, 24.5], [60.42, 25.3]);
function pickBase(b) {
  const base = HEL_AREA.contains(b) ? helOrto : HSY_AREA.contains(b) ? hsyOrto : osm;
  if (map.hasLayer(base)) return;
  for (const l of [helOrto, hsyOrto, osm]) map.removeLayer(l);
  base.addTo(map);
}
const layersCtl = L.control.layers(
  { "Helsingin ilmakuva": helOrto, "Ilmakuva (koko pk-seutu)": hsyOrto, "Kartta (OSM)": osm },
  { "Tiet ja nimet": labels },
  { position: "topright", collapsed: narrow }
).addTo(map);
// On phones the open list covers its own toggle: close it after a choice or a tap on the map.
if (narrow) map.on("baselayerchange overlayadd overlayremove click", () => layersCtl.collapse());
L.control.scale({ imperial: false }).addTo(map);
// Data credits must stay visible: on phones the card covers the bottom edge, so show them in the card.
map.attributionControl.setPrefix('Epävirallinen, ei NUTS:n eikä RaceResultin palvelu · <a href="https://leafletjs.com">Leaflet</a>');
if (narrow) document.querySelector(".card").append(map.attributionControl.getContainer());

// ---------- state ----------
// Each runner: { pid, color, state, clockOffset, lastFetchOk, error, cid, route, marker, done, timer, stopped, ui }
// state: { splits:[{name,distance}], times:[], exists:"", label, tooltip, totalLength }
// Runners may be on different contests (routes); routes are loaded once per contest and shared.
const runners = new Map();
const routes = new Map(); // contest id -> Promise<{ track, line, splits }>
const COLORS = ["#ff3d7f", "#3dc8ff", "#8fe03a", "#b77bff", "#ff9f1c", "#ffffff"];
let focusPid = null;
let follow = true, fittedOnce = false;
const DEFAULT_NOTE = "Sijainti on ajanottoon perustuva arvio, ei GPS.";




// Rows from SplitsAndLegs: TOD "1:10:51:56" (day:clock), Chip = from start line.
function renderSplitTable(tbody, sp) {
  const cur = sp.map(s => s.Exists).lastIndexOf(true);
  tbody.replaceChildren(...sp.map((s, i) => {
    const tr = document.createElement("tr");
    tr.className = !s.Exists ? "pred" : i === cur ? "cur" : "";
    for (const v of [
      splitName(s.Name),
      (s.TOD || "").replace(/^\d+:(?=\d+:\d+:\d+$)/, ""),
      s.IsStart ? "" : s.Chip || s.Gun || "",
      (s.Speed || "").replace(" min/km", ""),
      s.RO > 0 ? s.RO : ""
    ]) { const td = document.createElement("td"); td.textContent = v; tr.append(td); }
    return tr;
  }));
}

function drawRunner(r) {
  if (!r.route || !r.state) return;
  const v = eventNow(r);
  const p = position(r.state, v);
  const { splits, times, exists } = r.state;
  const lastIdx = exists.lastIndexOf("1");
  const ui = r.ui;

  if (p.status === "hidden" || p.status === "notstarted") {
    ui.est.textContent = p.status === "notstarted" ? "Ei vielä lähtenyt" : "Ei tietoa";
    if (r.marker) { map.removeLayer(r.marker); r.marker = null; }
    return;
  }
  const track = r.route.track;
  const gpxM = p.dist * track.length / r.state.totalLength;
  const pos = along(track, gpxM).latlng;

  if (!r.marker) {
    r.marker = L.marker(pos, {
      icon: L.divIcon({ className: "", html: `<span class="bib" style="background:${r.color};color:${r.color === "#ffffff" ? "#222" : "#fff"}">${escapeHtml(r.state.label)}</span>`, iconSize: [0, 0] }),
      zIndexOffset: r.pid === focusPid ? 2000 : 1000, keyboard: false
    }).addTo(map);
  } else r.marker.setLatLng(pos);
  r.progress = p.dist;
  paintDone(r, track, gpxM);

  if (follow && r.pid === focusPid) {
    // First known position of the chosen runner: zoom in like the "Seuraa" button; afterwards just keep it in view.
    if (TV) tvFollow(r, pos, track, gpxM);
    else if (!r.zoomed) { r.zoomed = true; map.setView(pos, followZoom()); }
    else if (!map.getBounds().pad(-0.2).contains(pos)) map.panTo(pos, { animate: true });
  }

  const pct = Math.min(100, p.dist / r.state.totalLength * 100);
  ui.prog.style.width = pct.toFixed(1) + "%";
  // Finished: sink to the bottom of the list so runners still out there stay on top.
  if (p.status === "finished" && !r.sunk) { r.sunk = true; $("runners").append(ui.li); }
  const statusTxt = { moving: "", late: " (arvio, väliaika viipyy)", waiting: " (odottaa väliaikaa)", finished: " (maalissa)" }[p.status];
  ui.est.textContent = p.status === "finished" // final time from the start mat to the finish
    ? `Maalissa: ${km(r.state.totalLength)} ajassa ${dur(times[times.length - 1] - times[0])}`
    : `${km(p.dist)} / ${km(r.state.totalLength)}${statusTxt}`;
  if (lastIdx >= 0) ui.last.textContent = `${splitName(splits[lastIdx].name)} klo ${clock(times[lastIdx])}`;
  // Average pace from the start to the last split passed (whole course once finished).
  if (lastIdx > 0 && splits[lastIdx].distance > 0) {
    const s = Math.round((times[lastIdx] - times[0]) / splits[lastIdx].distance * 1000);
    ui.avg.textContent = `${Math.floor(s / 60)}:${pad(s % 60)} min/km` +
      (lastIdx === splits.length - 1 ? " (koko matka)" : ` (${km(splits[lastIdx].distance)} asti)`);
  }
  const nextIdx = exists.indexOf("0");
  if (nextIdx !== -1) {
    const eta = times[nextIdx] - v;
    ui.next.textContent = `${splitName(splits[nextIdx].name)} (${km(splits[nextIdx].distance)}) ennuste ${clock(times[nextIdx])}` +
      (eta > 0 ? `, ${dur(eta)} päästä` : ", myöhässä ennusteesta");
  } else ui.next.textContent = "–";
}

const eventNow = r => REPLAY === null ? Date.now() / 1000 - r.clockOffset : r.day * 86400 + replayClock();
// In replay, a split counts as passed only once the replay clock reaches its actual time.
function replayMask(r) {
  if (!r.state) return;
  const v = eventNow(r);
  const ex = r.state.times.map(t => t > 0 && t <= v ? "1" : "0").join("");
  if (ex !== r.state.exists) { r.state.exists = ex; drawSplits(r.cid); }
}

let lastNote;
// The covered route is drawn in 200 m pieces, each stamped with when its runner passed it, and pieces are stacked by
// that time. Wherever routes overlap (also 14 km over 25 km at different kilometres), whoever passed last is on top.
const PIECE = 200;
let restack = false;
function paintDone(r, track, gpxM) {
  r.done ||= L.layerGroup().addTo(map);
  r.pieces ||= [];
  const full = Math.floor(gpxM / PIECE), ratio = track.length / r.state.totalLength;
  while (r.pieces.length > full + 1) r.done.removeLayer(r.pieces.pop()); // position corrected backwards
  for (let i = Math.max(0, r.pieces.length - 1); i <= full; i++) {
    const latlngs = sliceBetween(track, i * PIECE, Math.min((i + 1) * PIECE, gpxM));
    const t = i < full ? passedAt(r.state, (i + 1) * PIECE / ratio) : Infinity; // in progress: newest of all
    if (r.pieces[i]) r.pieces[i].setLatLngs(latlngs);
    else { r.pieces[i] = L.polyline(latlngs, { color: r.color, weight: 6, opacity: .95 }).addTo(r.done); restack = true; }
    if (r.pieces[i].t !== t) { r.pieces[i].t = t; restack = true; }
  }
}
function restackPieces() {
  if (!restack) return;
  restack = false;
  const all = [...runners.values()].flatMap(r => (r.pieces || []).map(p => [p, r.progress]));
  all.sort((a, b) => a[0].t - b[0].t || b[1] - a[1]); // ties (pieces in progress): trailing runner on top
  for (const [p] of all) p.bringToFront();
}

function draw() {
  let msg = null;
  for (const r of runners.values()) {
    if (REPLAY !== null) replayMask(r);
    drawRunner(r);
    const who = r.state?.label || r.pid;
    if (r.error) msg ||= `Tietojen haku epäonnistui (${who}): ${r.error}. Yritetään uudelleen.`;
    else if (r.live && !r.paused && Date.now() - r.lastFetchOk > 60000) msg ||= `Tietoja (${who}) ei ole saatu yli minuuttiin. Tarkista verkkoyhteys.`;
  }
  restackPieces();
  const text = msg || (REPLAY === null ? DEFAULT_NOTE : `Toisto ${SPEED}× · klo ${clock(replayClock())}`);
  if (text === lastNote) return;
  lastNote = text;
  $("note").classList.toggle("err", !!msg);
  $("note").classList.toggle("dflt", !msg && REPLAY === null);
  $("note").textContent = text;
}

// Out-and-back course: outbound and return splits share a spot, so merge splits within 120 m.
function redrawAllSplits() { for (const cid of new Set([...runners.values()].map(r => r.cid))) if (cid) drawSplits(cid); }
function drawSplits(cid) {
  const on = [...runners.values()].filter(r => r.cid === cid && r.route && r.state);
  if (!on.length) return;
  const { track, splits: layer } = on[0].route;
  const splits = on[0].state.splits;
  layer.clearLayers();
  const groups = [];
  splits.forEach((s, i) => {
    const pos = along(track, s.distance * track.length / on[0].state.totalLength).latlng;
    const passedBy = on.filter(r => r.state.exists[i] === "1");
    const passed = passedBy.length > 0;
    const name = escapeHtml(splitName(s.name));
    // Split times only when following one runner; with several the labels would crowd the map.
    const line = runners.size === 1 && passed ? `${name} ✓ ${clock(on[0].state.times[i])}` : name;
    const g = groups.find(g => hav(g.pos, pos) < 120);
    if (g) { g.lines.push(line); g.passed ||= passed; g.finish ||= i === splits.length - 1; }
    else groups.push({ pos, lines: [line], passed, finish: i === splits.length - 1 });
  });
  for (const g of groups) {
    L.circleMarker(g.pos, {
      radius: g.finish ? 7 : 5, color: "#fff", weight: 2,
      fillColor: g.passed ? getVar("--done") : "#222", fillOpacity: 1
    }).bindTooltip(g.lines.join("<br>"), {
      permanent: true, direction: "top", offset: [0, -6], className: "split-label"
    }).addTo(layer);
  }
}

function getVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

// ---------- data ----------
let liveInterval = 10, eventName = "NUTS HEL", cfgPromise = null;
// Per-event settings differ (list name, details page, server): read them like RaceResult's own page does.
function getConfig() {
  return cfgPromise ||= (async () => {
    const r = await fetch(`https://my.raceresult.com/${EVENT}/live/config?lang=fi`, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const c = await r.json();
    const list = (c.TabConfig?.Lists || []).find(l => !l.Mode);
    if (c.server) server = "https://" + c.server;
    if (c.eventname) { eventName = c.eventname; setTitle(); }
    return { key: c.key, list: list?.Name || "Online|Live", details: list?.Details || c.TabConfig?.StandardDetails || "details" };
  })().catch(e => { cfgPromise = null; throw e; });
}
function gpxPoints(gpxText) {
  const doc = new DOMParser().parseFromString(gpxText, "text/xml");
  let nodes = doc.getElementsByTagName("rtept");
  if (!nodes.length) nodes = doc.getElementsByTagName("trkpt");
  return [...nodes].map(n => [parseFloat(n.getAttribute("lat")), parseFloat(n.getAttribute("lon"))]);
}
function loadRoute(cid) {
  if (!routes.has(cid)) {
    routes.set(cid, (async () => {
      const g = await fetch(`${server}/${EVENT}/${(await getConfig()).details}/gpx/${cid}`, { signal: AbortSignal.timeout(30000) });
      if (!g.ok) throw new Error("Reitin haku epäonnistui (HTTP " + g.status + ")");
      const track = trackFrom(gpxPoints(await g.text()));
      const line = L.polyline(track.pts, { color: getVar("--route"), weight: 4, opacity: .9 }).addTo(map);
      line.bringToBack();
      return { track, line, splits: L.layerGroup().addTo(map) };
    })().catch(e => { routes.delete(cid); throw e; }));
  }
  return routes.get(cid);
}
// Drop routes no tracked runner is on.
function pruneRoutes() {
  for (const [cid, p] of routes) {
    if ([...runners.values()].some(r => r.cid === cid)) continue;
    routes.delete(cid);
    p.then(rt => { map.removeLayer(rt.line); map.removeLayer(rt.splits); }, () => {});
  }
}

async function fetchView(r) {
  const cfg = await getConfig();
  // The MID shortcut can answer "unchanged" even after a new split time has arrived (seen live), so ask for the
  // full view every third poll, and every poll while a split time is expected (its predicted time has passed).
  const expecting = r.state && ["late", "waiting"].includes(position(r.state, eventNow(r)).status);
  const mid = !expecting && ++r.polls % 3 ? r.mid : 0;
  const url = `${server}/${EVENT}/${cfg.details}/view?lang=fi&mid=${mid}&standalone=false&pid=${encodeURIComponent(r.pid)}`;
  // A request that never settles would stall this runner's loop for good (e.g. phone switching networks).
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const j = await res.json();
  if (r.stopped) return;
  if (j.Server) server = "https://" + j.Server;
  if (j.LiveUpdateInterval) liveInterval = Math.max(5, j.LiveUpdateInterval);
  if (j.LiveUpdate === false) r.live = false; // server asks clients to stop polling
  // Like RaceResult's own page: send the last MID, and an unchanged view comes back as a tiny {status:304}.
  if (j.status === 304) { r.lastFetchOk = Date.now(); r.error = null; return; }

  const markers = j.Data?.MapDetails?.Markers || {};
  let found = null;
  for (const [cid, mk] of Object.entries(markers)) {
    const row = mk.Participants?.Data?.[r.pid];
    if (row) { found = { cid, mk, row }; break; }
  }
  const heading = j.Elements?.find(e => e.Type === "box")?.Children?.find(c => c.Type === "field")?.Config?.Field;
  if (!found) { // the organiser has no map (GPX + split positions) for this distance or event: nothing to track
    r.ui.name.textContent = heading || `PID ${r.pid}`;
    r.ui.label.textContent = /Bib (\d+)/.exec(heading || "")?.[1] || r.pid;
    r.ui.est.textContent = Object.keys(j.Data?.MapDetails || {}).length ? "Tälle matkalle ei ole karttaseurantaa." : "Tapahtumassa ei ole karttaseurantaa.";
    r.live = false; r.error = null; r.lastFetchOk = Date.now();
    return;
  }
  const cols = found.mk.Participants.Columns;
  const col = name => found.row[cols.indexOf(name)];
  const splits = found.mk.Splits.map(s => ({ name: s.Name, distance: s.Distance }));
  const times = col("SplitsTime");
  const exists = col("SplitsExists") || "";
  const totalLength = splits[splits.length - 1].distance;

  r.ui.label.textContent = col("Labels") || r.pid;
  r.ui.name.textContent = col("Tooltips") || heading || `PID ${r.pid}`;
  r.ui.sub.textContent = heading || `${eventName} · ${r.pid}`;

  // Pace from the live splits data.
  const sp = j.Data?.SplitsAndLegs?.Splits || [];
  const lastActual = [...sp].reverse().find(s => s.Exists && s.Speed);
  const predicted = sp.find(s => !s.Exists && s.Speed);
  r.ui.pace.textContent = [lastActual && `${lastActual.Speed} viim. osuus`, predicted && `ennuste ${predicted.Speed}`].filter(Boolean).join(", ") || "–";
  renderSplitTable(r.ui.splits, sp.filter(s => !s.Internal));

  const changed = !r.state || r.state.exists !== exists || String(r.state.times) !== String(times);
  r.state = { splits, times, exists, label: col("Labels") || r.pid, tooltip: col("Tooltips"), totalLength };
  r.clockOffset = Date.now() / 1000 - eventTime(j.Time, times, exists);
  if (exists.endsWith("1")) r.live = false; // finish time is in: nothing more to fetch
  r.day = Math.floor(times[0] / 86400);
  r.lastFetchOk = Date.now();
  r.error = null;
  setTitle();

  if (r.cid !== found.cid) {
    const oldCid = r.cid;
    r.cid = found.cid; r.route = null;
    if (r.done) { map.removeLayer(r.done); r.done = null; r.pieces = null; }
    try { r.route = await loadRoute(r.cid); } catch (e) { r.cid = null; throw e; }
    if (r.stopped) return;
    pruneRoutes();
    if (oldCid) drawSplits(oldCid);
    if (!fittedOnce) { pickBase(r.route.line.getBounds()); map.fitBounds(r.route.line.getBounds(), { padding: [30, 30], animate: false }); fittedOnce = true; }
    drawSplits(r.cid);
  } else if (changed) drawSplits(r.cid);
  r.mid = j.MID || 0; // only after a full, successful update
  draw();
}

// No polling while the tab is hidden; visibilitychange resumes it.
async function loop(r) {
  r.timer = 0;
  if (document.hidden && !TV) { r.paused = true; return; } // a cast tab in TV mode may sit in the background
  try { await fetchView(r); }
  catch (e) {
    if (r.stopped) return;
    r.error = e.message;
    draw();
  }
  if (!r.stopped && r.live) r.timer = setTimeout(() => loop(r), liveInterval * 1000);
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  for (const r of runners.values()) if (r.paused) { r.paused = false; r.lastFetchOk = Date.now(); loop(r); }
});

function setUrl() {
  try {
    const u = new URL(location.href);
    u.searchParams.delete("bib");
    if (EVENT) u.searchParams.set("event", EVENT);
    if (runners.size) u.searchParams.set("pid", [...runners.keys()].join(",")); else u.searchParams.delete("pid");
    history.replaceState(null, "", u);
  } catch (e) { /* file:// pages may refuse URL changes */ }
}
function setTitle() {
  const rs = [...runners.values()];
  document.title = rs.length === 1 && rs[0].state
    ? `${rs[0].state.label} ${rs[0].state.tooltip || ""} · ${eventName}`.trim()
    : rs.length > 1 ? `${rs.length} juoksijaa · ${eventName}` : `${eventName} Satelliittiseuranta`;
}

// Details of the focused runner; collapsed by default on phones to keep the map visible.
let detailsOpen = !matchMedia("(max-width: 600px)").matches;
function setFocus(pid) {
  focusPid = pid;
  for (const r of runners.values()) {
    const on = r.pid === pid;
    r.ui.li.setAttribute("aria-current", String(on));
    r.ui.more.hidden = !(on && detailsOpen);
    const btn = r.ui.li.querySelector(".r-focus");
    if (on) btn.setAttribute("aria-expanded", String(detailsOpen)); else btn.removeAttribute("aria-expanded");
    r.marker?.setZIndexOffset(on ? 2000 : 1000);
  }
}
function setFollow(on) { follow = on; $("follow").setAttribute("aria-pressed", String(on)); }

function addRunner(pid) {
  pid = String(pid);
  if (!runners.has(pid)) {
    const used = [...runners.values()].map(r => r.color);
    const color = COLORS.find(c => !used.includes(c)) || COLORS[runners.size % COLORS.length];
    const li = document.createElement("li");
    li.className = "runner";
    li.style.setProperty("--c", color);
    li.innerHTML = `<div class="r-head">
        <button class="r-focus" type="button"><span class="pill"></span><span class="r-name">Ladataan…</span></button>
        <button class="r-remove" type="button" aria-label="Lopeta seuranta">×</button>
      </div>
      <div class="sub"></div>
      <div class="r-est">–</div>
      <div class="bar"><div></div></div>
      <div class="r-more" hidden>
      <dl class="grid">
        <dt>Viimeksi</dt><dd>–</dd>
        <dt>Seuraava</dt><dd>–</dd>
        <dt>Vauhti</dt><dd>–</dd>
        <dt>Keskivauhti</dt><dd>–</dd>
      </dl>
      <details class="splits"><summary>Väliajat</summary><div class="tbl"><table>
        <thead><tr><th>Piste</th><th>Klo</th><th>Aika</th><th>min/km</th><th>Sija</th></tr></thead>
        <tbody></tbody>
      </table></div><div class="note">Kursiivilla ennuste.</div></details>
      </div>`;
    if (color === "#ffffff") li.querySelector(".pill").style.color = "#222";
    const dd = li.querySelectorAll("dd");
    const r = {
      pid, color, state: null, clockOffset: 0, lastFetchOk: Date.now(), error: null,
      cid: null, route: null, marker: null, done: null, timer: 0, stopped: false, mid: 0, polls: 0, live: true, paused: false,
      ui: {
        li, label: li.querySelector(".pill"), name: li.querySelector(".r-name"), sub: li.querySelector(".sub"),
        est: li.querySelector(".r-est"), prog: li.querySelector(".bar > div"), more: li.querySelector(".r-more"), splits: li.querySelector("tbody"),
        last: dd[0], next: dd[1], pace: dd[2], avg: dd[3]
      }
    };
    r.ui.label.textContent = pid;
    li.querySelector(".r-focus").addEventListener("click", () => {
      if (focusPid === pid) detailsOpen = !detailsOpen;
      setFocus(pid); setFollow(true);
      if (r.marker) map.setView(r.marker.getLatLng(), followZoom());
    });
    li.querySelector(".r-remove").addEventListener("click", () => removeRunner(pid));
    $("runners").append(li);
    runners.set(pid, r);
    redrawAllSplits(); // labels depend on how many runners are followed
    loop(r);
  }
  setFocus(pid); setFollow(true);
  setUrl(); setTitle();
  showView();
}

function removeRunner(pid) {
  const r = runners.get(pid);
  if (!r) return;
  r.stopped = true;
  clearTimeout(r.timer);
  for (const k of ["marker", "done"]) if (r[k]) map.removeLayer(r[k]);
  r.ui.li.remove();
  runners.delete(pid);
  pruneRoutes();
  redrawAllSplits();
  setUrl(); setTitle();
  if (!runners.size) { fittedOnce = false; showPicker(); return; }
  if (focusPid === pid) setFocus(runners.keys().next().value);
  draw();
}

function showView() { $("pick").hidden = true; $("view").hidden = false; }
function showPicker(focus) {
  $("view").hidden = true; $("pick").hidden = false;
  $("back").hidden = !runners.size;
  if (focus === true) $("q").focus();
}

// ---------- runner search (RaceResult live list) ----------
let searchSeq = 0, searchTimer = 0;
async function search(term) {
  const seq = ++searchSeq;
  await eventsReady;
  const cfg = await getConfig();
  const url = `${server}/${EVENT}/live/list?key=${cfg.key}&listname=${encodeURIComponent(cfg.list)}&page=live&contest=0&r=search&l=30&term=${encodeURIComponent(term)}`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const rows = collectRows((await r.json()).data);
  if (seq !== searchSeq) return null;
  return rows;
}
function renderResults(rows, term) {
  const ul = $("results");
  ul.replaceChildren();
  if (!rows.length) { $("pickNote").textContent = `Ei osumia haulla "${term}". Haku löytää vain matkaan lähteneet.`; return; }
  $("pickNote").textContent = rows.length >= 30 ? "Näytetään 30 ensimmäistä. Tarkenna hakua." : "Valitse juoksija.";
  for (const row of rows) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    const bib = document.createElement("span"); bib.className = "r-bib"; bib.textContent = row.bib;
    const nm = document.createElement("span"); nm.textContent = row.name;
    const meta = document.createElement("span"); meta.className = "r-meta";
    meta.textContent = [splitName(row.contest), row.last].filter(Boolean).join(" · ");
    b.append(bib, nm, meta);
    b.addEventListener("click", () => addRunner(row.pid));
    li.append(b);
    ul.append(li);
  }
}
$("q").addEventListener("input", () => {
  clearTimeout(searchTimer);
  const term = $("q").value.trim();
  if (term.length < (/^\d+$/.test(term) ? 1 : 2)) { $("results").replaceChildren(); $("pickNote").textContent = pickHint; return; }
  searchTimer = setTimeout(async () => {
    $("pickNote").textContent = "Haetaan…";
    try { const rows = await search(term); if (rows) renderResults(rows, term); }
    catch (e) { $("pickNote").textContent = "Haku epäonnistui: " + e.message; }
  }, 300);
});

// ?bib=<number>,... in a link: look up each RaceResult id by exact bib match.
async function startFromBibs(bibs) {
  showPicker();
  for (const bib of bibs) {
    $("q").value = bib;
    $("pickNote").textContent = "Haetaan…";
    try {
      const rows = await search(bib);
      const hit = rows?.find(r => String(r.bib) === String(bib));
      if (hit) addRunner(hit.pid); else if (rows) { showPicker(); renderResults(rows, bib); }
    } catch (e) { $("pickNote").textContent = "Haku epäonnistui: " + e.message; }
  }
}

$("follow").addEventListener("click", () => {
  setFollow(!follow);
  const m = runners.get(focusPid)?.marker;
  if (follow && m) map.setView(m.getLatLng(), followZoom());
});
$("fit").addEventListener("click", () => {
  setFollow(false);
  const lines = [...runners.values()].filter(r => r.route).map(r => r.route.line.getBounds());
  if (lines.length) map.fitBounds(lines.reduce((b, l) => b.extend(l)), { padding: [30, 30] });
});
map.on("dragstart", () => setFollow(false));
$("add").addEventListener("click", () => showPicker(true));
$("back").addEventListener("click", showView);
function setTv(on) {
  const u = new URL(location.href);
  if (on) u.searchParams.set("tv", "1"); else u.searchParams.delete("tv");
  location.href = u;
}
$("tv").addEventListener("click", () => setTv(true));
if (TV) {
  // Esc may never reach the page in browser fullscreen, so a mouse move or touch also reveals an exit button.
  window.addEventListener("keydown", e => { if (e.key === "Escape") setTv(false); }, true);
  $("tvExit").addEventListener("click", () => setTv(false));
  let exitTimer = 0;
  for (const t of ["mousemove", "pointerdown"]) document.addEventListener(t, () => {
    $("tvExit").hidden = false;
    clearTimeout(exitTimer);
    exitTimer = setTimeout(() => { $("tvExit").hidden = true; }, 3000);
  });
  try { navigator.wakeLock?.request("screen").catch(() => {}); } catch (e) { /* no wake lock: the screen may sleep */ }
  // Show each runner in turn, every 15 s. A runner near the finish (see finishInfo) takes over the screen;
  // the closest one wins if there are several.
  let rotateAt = Date.now() + 15000;
  setInterval(() => {
    const shown = [...runners.values()].filter(r => r.marker && r.state);
    const finishing = shown.map(r => ({ r, ...finishInfo(r.state, eventNow(r)) }));
    for (const f of finishing) f.r.ui.li.classList.toggle("finishing", f.hot);
    const hot = finishing.filter(f => f.hot).sort((a, b) => Math.abs(a.t) - Math.abs(b.t))[0];
    if (hot) {
      if (focusPid !== hot.r.pid) { setFocus(hot.r.pid); setFollow(true); }
      rotateAt = Date.now() + 15000;
      return;
    }
    // Finished runners drop out of the rotation (unless everyone has finished).
    const out = shown.filter(r => r.state.exists[r.state.exists.length - 1] !== "1");
    const turn = out.length ? out : shown;
    if (Date.now() < rotateAt && turn.some(r => r.pid === focusPid)) return;
    rotateAt = Date.now() + 15000;
    if (turn.length < 2 && turn[0]?.pid === focusPid) return;
    const next = turn[(turn.findIndex(r => r.pid === focusPid) + 1) % turn.length];
    setFocus(next.pid); setFollow(true);
  }, 1000);
}
$("share").addEventListener("click", async () => {
  const link = location.href;
  try { await navigator.clipboard.writeText(link); $("share").textContent = "Kopioitu"; }
  catch (e) { $("note").classList.remove("dflt"); $("note").textContent = "Kopioi linkki osoiteriviltä: " + link; }
  setTimeout(() => { $("share").textContent = "Jaa linkki"; }, 2500);
});

// ---------- event picker (RaceResult's own event search) ----------
let pickHint = "Haku löytää matkaan lähteneet juoksijat.";
async function loadEvents() {
  const r = await fetch("https://my.raceresult.com/RREvents/list?filter=NUTS&country=FI&modes=last,next&limit=200&lang=fi");
  if (!r.ok) throw new Error("HTTP " + r.status);
  return nutsEvents(await r.json());
}
function fillEvents(evs) {
  if (!evs.some(e => String(e.id) === EVENT)) evs = [{ id: EVENT, name: eventName, dateFrom: "" }, ...evs];
  const today = new Date().toISOString().slice(0, 10), groups = new Map();
  for (const e of evs) {
    const y = e.dateFrom.slice(0, 4) || "Muu";
    if (!groups.has(y)) groups.set(y, Object.assign(document.createElement("optgroup"), { label: y }));
    const d = e.dateFrom ? ` · ${+e.dateFrom.slice(8, 10)}.${+e.dateFrom.slice(5, 7)}.${y}` : "";
    groups.get(y).append(new Option(e.name.trim() + d + (e.dateFrom > today ? " (tuleva)" : ""), e.id));
  }
  $("event").replaceChildren(...groups.values());
  $("event").value = EVENT;
}
// One probe per event so the picker can tell up front when the organiser has no map tracking.
async function checkMap() {
  const ev = EVENT;
  pickHint = "Haku löytää matkaan lähteneet juoksijat.";
  $("pickNote").textContent = pickHint;
  try {
    const cfg = await getConfig();
    const r = await fetch(`${server}/${ev}/live/list?key=${cfg.key}&listname=${encodeURIComponent(cfg.list)}&page=live&contest=0&r=search&l=1&term=a`);
    const row = r.ok && collectRows((await r.json()).data)[0];
    if (!row) return;
    const v = await (await fetch(`${server}/${ev}/${cfg.details}/view?lang=fi&mid=0&standalone=false&pid=${row.pid}`)).json();
    if (ev !== EVENT || Object.keys(v.Data?.MapDetails || {}).length) return;
    pickHint = "Tässä tapahtumassa ei ole karttaseurantaa: juoksijat löytyvät, mutta sijaintia ei voi näyttää.";
    if (!$("results").children.length) $("pickNote").textContent = pickHint;
  } catch (e) { /* only a hint; search reports real errors */ }
}
function setEvent(id) {
  for (const pid of [...runners.keys()]) removeRunner(pid);
  EVENT = String(id); cfgPromise = null; fittedOnce = false;
  $("q").value = ""; $("results").replaceChildren();
  setUrl(); setTitle();
  checkMap();
}
$("event").addEventListener("change", () => {
  if (runners.size && !confirm("Tapahtuman vaihto lopettaa nykyisten juoksijoiden seurannan. Jatketaanko?")) { $("event").value = EVENT; return; }
  setEvent($("event").value);
});
// Default event: the latest NUTS event that has already started.
const eventsReady = loadEvents().catch(() => []).then(evs => {
  const today = new Date().toISOString().slice(0, 10);
  EVENT ||= String(defaultEvent(evs, today)?.id || "371720");
  fillEvents(evs);
  if (!runners.size) checkMap(); else getConfig().catch(() => {});
});

setInterval(draw, TV ? 250 : 1000);
if (pids.length) { pids.forEach(addRunner); setFocus(pids[0]); }
else if (bibs.length) startFromBibs(bibs);
else showPicker();
