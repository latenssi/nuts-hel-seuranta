import { test } from "node:test";
import assert from "node:assert/strict";
import { clock, dur, km, splitName, escapeHtml, parseClock } from "../js/format.js";

test("clock drops the event day and wraps", () => {
  assert.equal(clock(122431), "10:00:31"); // day 1, 10:00:31
  assert.equal(clock(36000), "10:00:00");
  assert.equal(clock(-1), "23:59:59");
});

test("dur shows hours only when needed", () => {
  assert.equal(dur(6679), "1:51:19");
  assert.equal(dur(65), "1:05");
  assert.equal(dur(-5), "0:00");
});

test("km uses a Finnish decimal comma", () => {
  assert.equal(km(25900), "25,9 km");
  assert.equal(km(0), "0,0 km");
});

test("splitName picks Finnish, then English, from RaceResult labels", () => {
  assert.equal(splitName("{EN:Start|FI:Lähtö}"), "Lähtö");
  assert.equal(splitName("{EN:Finish}"), "Finish");
  assert.equal(splitName("160 m"), "160 m");
});

test("escapeHtml escapes markup", () => {
  assert.equal(escapeHtml(`<b a="x">&'`), "&lt;b a=&quot;x&quot;&gt;&amp;&#39;");
});

test("parseClock reads HH:MM[:SS] and rejects the rest", () => {
  assert.equal(parseClock("10:30"), 37800);
  assert.equal(parseClock("9:05:07"), 32707);
  assert.equal(parseClock("10.30"), null);
  assert.equal(parseClock(null), null);
});
