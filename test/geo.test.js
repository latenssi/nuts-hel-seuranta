import { test } from "node:test";
import assert from "node:assert/strict";
import { hav, trackFrom, along, sliceBetween } from "../js/geo.js";

// Three points due north, ~111 m apart (0.001° latitude), with a repeated point that must be dropped.
const track = trackFrom([[60, 25], [60.001, 25], [60.001, 25], [60.002, 25]]);
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test("hav measures metres on the globe", () => {
  near(hav([60, 25], [60.001, 25]), 111.2, 0.1);
});

test("trackFrom drops repeated points and sums the length", () => {
  assert.equal(track.pts.length, 3);
  near(track.length, 2 * hav([60, 25], [60.001, 25]));
});

test("along interpolates and clamps to the track", () => {
  near(along(track, track.length / 4).latlng[0], 60.0005);
  assert.deepEqual(along(track, -10).latlng, [60, 25]);
  near(along(track, 1e9).latlng[0], 60.002);
});

test("sliceBetween keeps the inner vertices and both cut points", () => {
  const s = sliceBetween(track, track.length * 0.25, track.length * 0.75);
  assert.equal(s.length, 3);
  near(s[0][0], 60.0005);
  near(s[1][0], 60.001);
  near(s[2][0], 60.0015);
});
