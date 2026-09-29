// Keeping pieces between visits.
//
// Two kinds of browser storage, for two kinds of "coming back":
//
// - This tab (sessionStorage): the piece open in it, with its undo history.
//   A reload of the same tab, at the same address, carries on exactly where
//   it was -- even from an ?example= link or a saved page, which would
//   otherwise open their own piece again.
// - This browser (localStorage): the last few pieces edited, each under its
//   own id, newest first. A new tab or a new visit opens the newest, and the
//   menu offers the rest. Because each piece has its own place, opening an
//   example or a link starts a new piece instead of writing over the last.
//
// Both belong to this browser alone and can be cleared (Safari clears a
// site's storage after some weeks unused, unless the page is added to the
// Home Screen), which is why Save piece is still the way to keep something.
//
// Everything is wrapped in try, because some browsers refuse storage
// altogether (private windows, for instance), and a page that cannot keep a
// piece should still work in every other way.

const PIECES_KEY = "randaw-pieces";
const TAB_KEY = "randaw-tab";
// Where the one piece was kept before there were several; read once, then moved.
const OLD_KEY = "randaw-draft";
// How many pieces this browser keeps. Each is a few kilobytes.
const KEEP = 12;

// A fresh id for a piece: unique enough within one browser.
export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const isPiece = (p) => p && typeof p.id === "string" && typeof p.name === "string" && p.spec;

// The pieces kept in this browser, newest first: [{ id, name, spec, saved }].
export function keptPieces() {
  try {
    const pieces = JSON.parse(localStorage.getItem(PIECES_KEY) ?? "[]");
    if (Array.isArray(pieces) && pieces.length) return pieces.filter(isPiece);
    const old = JSON.parse(localStorage.getItem(OLD_KEY) ?? "null");
    if (!(old && typeof old.name === "string" && old.spec)) return [];
    // Moved once, so it keeps one id from now on.
    const moved = [{ id: newId(), name: old.name, spec: old.spec, saved: 0 }];
    localStorage.setItem(PIECES_KEY, JSON.stringify(moved));
    localStorage.removeItem(OLD_KEY);
    return moved;
  } catch {
    return [];
  }
}

// Keep a piece, as the newest. `seen` is when this tab last read or wrote it;
// if another tab has written the same piece since, this one is kept as a new
// piece instead, so neither tab's work replaces the other's.
//
// Returns { id, saved, split } -- the id it was kept under, its time, and
// whether that is a new id -- or null if it could not be kept.
export function keepPiece(id, name, spec, seen) {
  const pieces = keptPieces();
  const there = pieces.find((p) => p.id === id);
  const split = Boolean(there && seen !== undefined && there.saved !== seen);
  if (split) id = newId();
  const saved = Math.max(Date.now(), (there?.saved ?? 0) + 1);
  const kept = [{ id, name, spec, saved }, ...pieces.filter((p) => p.id !== id)];
  // If storage is full, let the oldest go until it fits (but keep this one).
  for (let n = Math.min(kept.length, KEEP); n >= 1; n--) {
    try {
      localStorage.setItem(PIECES_KEY, JSON.stringify(kept.slice(0, n)));
      return { id, saved, split };
    } catch {
      // too big, or no storage at all: try with fewer
    }
  }
  return null;
}

// This tab's piece, kept for a reload: { id, name, spec, history, future,
// kept, seen }. Tied to the address, so arriving at a different one (another
// example, say) starts afresh.
export function saveTab(address, tab) {
  try {
    sessionStorage.setItem(TAB_KEY, JSON.stringify({ address, ...tab }));
  } catch {
    // Too big (a long undo history) or no storage: try without the history.
    try {
      sessionStorage.setItem(TAB_KEY, JSON.stringify({ address, ...tab, history: [], future: [] }));
    } catch {
      // nothing to do
    }
  }
}

// This tab's piece, if it was kept at this same address; otherwise null.
export function loadTab(address) {
  try {
    const tab = JSON.parse(sessionStorage.getItem(TAB_KEY) ?? "null");
    if (!isPiece(tab) || tab.address !== address) return null;
    return { ...tab, history: tab.history ?? [], future: tab.future ?? [] };
  } catch {
    return null;
  }
}

// Ask the browser not to clear this page's storage when it is short of room
// or the page has not been visited for a while. Browsers decide for
// themselves (often by whether the page is bookmarked or on the Home Screen),
// and some have no way to ask; either way this is only a request.
export function askToKeep() {
  try {
    navigator.storage?.persist?.().catch(() => {});
  } catch {
    // not supported
  }
}
