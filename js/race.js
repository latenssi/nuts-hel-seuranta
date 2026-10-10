// Race logic on RaceResult data. Pure functions: no DOM, no map, no network.
// state: { splits: [{ name, distance }], times: [event seconds], exists: "1100…", totalLength }
// Split times carry a day offset (86400 per event day); exists[i] is "1" once split i is timed, before that
// times[i] is RaceResult's prediction.

// Event time now: the server sends seconds of the current day; pick the event day from the runner's own split times.
export function eventTime(serverTime, times, exists) {
  let ref = times[0];
  for (let i = 0; i < times.length; i++) if (exists[i] === "1" && times[i] > ref) ref = times[i];
  return serverTime + 86400 * Math.round((ref - serverTime) / 86400);
}

// RaceResult's map rules, minus its "MarkerWait": when a split's predicted time has passed but its timing data
// hasn't arrived (it can lag a lot), keep moving on the predictions instead of parking the marker at the split.
export function position(state, v) {
  const { splits, times, exists } = state;
  const lastIdx = exists.lastIndexOf("1");
  if (times.every(t => t === 0)) return { status: "hidden" };
  if (exists[exists.length - 1] === "1") return { status: "finished", dist: state.totalLength };
  const n = times.findIndex((t, i) => exists[i] === "0" && t > v && i > lastIdx);
  if (n === 0 || (n === -1 && lastIdx === -1)) return { status: "notstarted" };
  if (n === -1) return { status: "waiting", dist: state.totalLength, at: splits.length - 1 }; // past every prediction
  if (times[n] <= times[n - 1]) return { status: "waiting", dist: splits[n - 1].distance, at: n - 1 };
  const d = splits[n - 1].distance + (splits[n].distance - splits[n - 1].distance) / (times[n] - times[n - 1]) * Math.max(v - times[n - 1], 0);
  return { status: lastIdx >= 0 && n - 1 > lastIdx ? "late" : "moving", dist: d, next: n };
}

// Event time at event distance d: actual split times, predictions beyond.
export function passedAt(state, d) {
  const { splits, times } = state;
  let j = 0;
  while (j < splits.length - 2 && splits[j + 1].distance < d) j++;
  const span = splits[j + 1].distance - splits[j].distance || 1;
  return times[j] + (times[j + 1] - times[j]) * Math.min(1, Math.max(0, (d - splits[j].distance) / span));
}

// Finish for the TV camera: seconds to (negative: since) the finish, and whether to keep the camera on this runner:
// due within 5 min, or finished under a minute ago.
export function finishInfo(state, v) {
  const last = state.times.length - 1, t = state.times[last] - v;
  const done = state.exists[last] === "1";
  return { t, done, hot: done ? t > -60 : t < 300 };
}

// Search rows look like [bib, pid, rank, ..., name, ..., "Split kello hh:mm:ss", ...], nested under contest groups.
// Column order varies by event, so take the first plain-text column as the name and the first "text + time" as last split.
const plainText = c => typeof c === "string" && c && !/^[{[]/.test(c) && !/^[\d.,:]+$/.test(c);
export function collectRows(node, contest = null, out = []) {
  if (Array.isArray(node)) {
    for (const r of node) if (Array.isArray(r) && r.length > 4) {
      const rest = r.slice(3);
      out.push({ bib: r[0], pid: r[1], name: rest.find(plainText) || "", last: rest.find(c => /\D.*\d+:\d\d:\d\d/.test(c)) || "", contest });
    }
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) collectRows(v, contest ?? k.replace(/^#\d+_/, ""), out);
  }
  return out;
}

// RaceResult's event search answer -> NUTS events, newest first. Its filter also matches "Donuts", "Knutsford"…
export function nutsEvents(groups) {
  return groups.flatMap(g => g.Events)
    .filter(e => /\bNUTS\b/i.test(e.name))
    .sort((a, b) => b.dateFrom.localeCompare(a.dateFrom));
}

// The latest event that has already started (dates as YYYY-MM-DD).
export function defaultEvent(events, today) {
  return events.find(e => e.dateFrom <= today);
}
