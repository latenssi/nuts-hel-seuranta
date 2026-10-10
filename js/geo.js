// Route geometry on [lat, lon] points. Pure functions: no DOM, no map.

const R = 6371008.8;

export function hav(a, b) {
  const toRad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toRad, dLon = (b[1] - a[1]) * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toRad) * Math.cos(b[0] * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// track: { pts: [[lat,lon]], cum: [m], length }. Repeated points are dropped.
export function trackFrom(points) {
  const pts = [];
  for (const p of points) {
    const prev = pts[pts.length - 1];
    if (!prev || prev[0] !== p[0] || prev[1] !== p[1]) pts.push(p);
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + hav(pts[i - 1], pts[i]));
  return { pts, cum, length: cum[cum.length - 1] };
}

// Point along the track by metres on the GPX line.
export function along(track, m) {
  const { pts, cum } = track;
  m = Math.max(0, Math.min(m, track.length));
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= m) lo = mid; else hi = mid; }
  const seg = cum[hi] - cum[lo], t = seg > 0 ? (m - cum[lo]) / seg : 0;
  return { latlng: [pts[lo][0] + (pts[hi][0] - pts[lo][0]) * t, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * t], idx: lo };
}

// The part of the track between two distances, as a polyline.
export function sliceBetween(track, m0, m1) {
  const a = along(track, m0), b = along(track, m1);
  return [a.latlng, ...track.pts.slice(a.idx + 1, b.idx + 1), b.latlng];
}
