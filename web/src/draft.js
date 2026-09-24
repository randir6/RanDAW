// Keeping the piece between visits.
//
// The piece is saved in the browser's own storage (localStorage) after every
// change, so a reload -- or Safari quietly closing the tab -- does not lose
// it. That storage belongs to this browser alone and can be cleared, which is
// why Save piece is still the way to keep something.
//
// Everything is wrapped in try, because some browsers refuse storage
// altogether (private windows, for instance), and a page that cannot keep a
// draft should still work in every other way.

// Where the piece is kept, in this browser only.
const DRAFT_KEY = "randaw-draft";

export function saveDraft(name, spec) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ name, spec }));
  } catch {
    // no storage: nothing to do
  }
}

// The saved { name, spec }, or null if there is none (or it is unreadable).
export function loadDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null");
    return draft && typeof draft.name === "string" ? draft : null;
  } catch {
    return null;
  }
}
