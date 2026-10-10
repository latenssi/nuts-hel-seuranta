// Text formatting. Pure functions: no DOM, no map.

export const pad = n => String(n).padStart(2, "0");

export function clock(sec) { // event seconds -> HH:MM:SS of day
  const s = ((Math.round(sec) % 86400) + 86400) % 86400;
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

export function dur(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export const km = m => (m / 1000).toLocaleString("fi-FI", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " km";

export function splitName(raw) { // "{EN:Start|FI:Lähtö}" -> "Lähtö"
  const m = /^\{(.*)\}$/.exec(raw || "");
  if (!m) return raw;
  const parts = Object.fromEntries(m[1].split("|").map(p => [p.slice(0, p.indexOf(":")), p.slice(p.indexOf(":") + 1)]));
  return parts.FI || parts.EN || Object.values(parts)[0];
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// "HH:MM" or "HH:MM:SS" -> seconds of day, anything else -> null.
export function parseClock(s) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s || "");
  return m ? m[1] * 3600 + m[2] * 60 + (+m[3] || 0) : null;
}
