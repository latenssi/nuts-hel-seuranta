import { test } from "node:test";
import assert from "node:assert/strict";
import { eventTime, position, passedAt, finishInfo, collectRows, nutsEvents, defaultEvent } from "../js/race.js";

// A 3 km course with splits every km; times are event seconds.
const course = { splits: [{ distance: 0 }, { distance: 1000 }, { distance: 2000 }, { distance: 3000 }], totalLength: 3000 };
const runner = (times, exists) => ({ ...course, times, exists });

test("eventTime puts the server's time of day on the runner's event day", () => {
  // Real NUTS HEL data: split times on day 1 (86400 + time of day), server says 11:58:01.
  assert.equal(eventTime(43081, [122400, 122431], "11"), 86400 + 43081);
  assert.equal(eventTime(43081, [36000, 36031], "11"), 43081); // single-day event
});

test("position interpolates between the last split and the next prediction", () => {
  assert.deepEqual(position(runner([100, 400, 700, 1000], "1100"), 550), { status: "moving", dist: 1500, next: 2 });
});

test("position keeps moving past a split whose time is late", () => {
  const p = position(runner([100, 400, 700, 1000], "1100"), 800); // split 2 predicted at 700, not timed yet
  assert.equal(p.status, "late");
  assert.ok(p.dist > 2000 && p.dist < 3000);
});

test("position waits at the finish once every prediction has passed", () => {
  assert.deepEqual(position(runner([100, 400, 700, 1000], "1110"), 1100), { status: "waiting", dist: 3000, at: 3 });
});

test("position before the start, after the finish, and without data", () => {
  assert.equal(position(runner([100, 400, 700, 1000], "0000"), 50).status, "notstarted");
  assert.deepEqual(position(runner([100, 400, 700, 1000], "1111"), 2000), { status: "finished", dist: 3000 });
  assert.equal(position(runner([0, 0, 0, 0], "0000"), 50).status, "hidden");
});

test("passedAt interpolates split times and clamps at the ends", () => {
  const r = runner([100, 400, 700, 1000], "1100");
  assert.equal(passedAt(r, 1500), 550);
  assert.equal(passedAt(r, 0), 100);
  assert.equal(passedAt(r, 3000), 1000);
  assert.equal(passedAt(r, 5000), 1000);
});

test("finishInfo: due within 5 min or finished under a minute ago keeps the camera", () => {
  const out = runner([100, 400, 700, 1000], "1100");
  assert.deepEqual(finishInfo(out, 750), { t: 250, done: false, hot: true });
  assert.equal(finishInfo(out, 600).hot, false); // 400 s to go
  const done = runner([100, 400, 700, 1000], "1111");
  assert.equal(finishInfo(done, 1030).hot, true);
  assert.equal(finishInfo(done, 1100).hot, false);
});

test("collectRows finds name and last split whatever the column order", () => {
  const data = {
    "#1_43 km": [["337", "8697", "1.", "{en:F|fi:N}", "Kristiane Width", "[img:/graphics/flags/FI.svg]", "ChasingNotLast", "43.5", "Maali kello 12:58:48"]],
    "#2_160 km": [["306", "19485", "1.", "Ulla Huopaniemi", "[img:/graphics/flags/FI.svg]", "Samba Trail Running", "160.9", "Maali kello 10:47:54", "21:47:36"]],
  };
  assert.deepEqual(collectRows(data), [
    { bib: "337", pid: "8697", name: "Kristiane Width", last: "Maali kello 12:58:48", contest: "43 km" },
    { bib: "306", pid: "19485", name: "Ulla Huopaniemi", last: "Maali kello 10:47:54", contest: "160 km" },
  ]);
});

test("nutsEvents keeps NUTS events newest first; defaultEvent is the latest started", () => {
  const groups = [{ Events: [
    { id: 1, name: "NUTS Pyhä", dateFrom: "2026-08-08" },
    { id: 2, name: "Duck Donuts 5K", dateFrom: "2026-11-01" },
    { id: 3, name: "NUTS HEL", dateFrom: "2026-10-09" },
  ] }, { Events: [{ id: 4, name: "NUTS Karhunkierros", dateFrom: "2027-05-28" }] }];
  const evs = nutsEvents(groups);
  assert.deepEqual(evs.map(e => e.id), [4, 3, 1]);
  assert.equal(defaultEvent(evs, "2026-10-10").id, 3);
  assert.equal(defaultEvent(evs, "2026-10-09").id, 3);
  assert.equal(defaultEvent(evs, "2026-01-01"), undefined);
});
