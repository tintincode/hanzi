// js/bookmarks.js
// BookmarkManager: persists "characters to revisit later", bookmarked
// while browsing in 阅读模式. Deliberately separate from 练习模式's
// history/session data (hanziStudyHistory.v1) and from theme preference
// (hanziStudyTheme) — bookmarking is its own concern with its own
// storage key, same "keep concerns separate" principle used throughout
// this app.
//
// One flat, global set — not scoped per level — since a bookmark reflects
// personal interest in a specific character, not something tied to
// whichever level tab happened to be open at the time. It IS scoped per
// profile, though (see setProfile below) — one learner's bookmarks
// shouldn't show up for another learner sharing the same device.
//
// Scope note: 阅读模式 only, by design (not 练习模式). In 练习模式, marking
// a card 错 already serves the "flag this for review" need via 只看错题 —
// a second, overlapping affordance there would just be confusing. The
// gap this actually fills is browsing without a grading signal at all.

const STORAGE_KEY_BASE = 'hanziStudyBookmarks.v1';

let bookmarked = new Set();
let profileId = null;
// Set once by app.js during init (see onSaveFailure below) — deliberately
// NOT a full reference to the app itself, keeping this module decoupled
// the same way SearchManager/SpeechManager are. Just a callback the app
// can use to notice when a save silently failed (almost always a full
// localStorage quota) and surface that to the person instead of it only
// reaching the console.
let onSaveError = null;

const BookmarkManager = {
  // Sets which profile's bookmarks this module reads/writes (one key per
  // profile: hanziStudyBookmarks.v1.<id>) and immediately (re)loads that
  // profile's set into memory — this is the single entry point used both
  // for the initial app load (see app.js's init(), called after
  // ProfileManager has resolved the active profile) and for every
  // subsequent profile switch, rather than having a separate no-arg
  // init() that only worked for the first case.
  setProfile(id) {
    profileId = id;
    try {
      const raw = localStorage.getItem(this.key());
      const arr = raw ? JSON.parse(raw) : [];
      bookmarked = new Set(Array.isArray(arr) ? arr.filter(n => Number.isInteger(n)) : []);
    } catch (e) {
      console.warn('BookmarkManager: failed to load bookmarks, starting empty.', e);
      bookmarked = new Set();
    }
  },

  // Registers a callback invoked whenever save() fails. One-time setup,
  // called once from app.js's init() — see the comment on the module-
  // private onSaveError above for why this exists instead of just giving
  // this module a direct app reference.
  onSaveFailure(callback) {
    onSaveError = callback;
  },

  key() {
    return profileId ? `${STORAGE_KEY_BASE}.${profileId}` : STORAGE_KEY_BASE;
  },

  isBookmarked(id) {
    return bookmarked.has(id);
  },

  // Returns the new state (true = now bookmarked, false = now removed).
  // Unchanged return shape even though save() can now fail — the
  // in-memory bookmark state still applies for this session either way
  // (see save()'s own comment), so what toggle() reports back is still
  // accurate; onSaveError is how a persistence failure specifically gets
  // surfaced, independent of this return value.
  toggle(id) {
    if (bookmarked.has(id)) {
      bookmarked.delete(id);
    } else {
      bookmarked.add(id);
    }
    this.save();
    return bookmarked.has(id);
  },

  save() {
    try {
      localStorage.setItem(this.key(), JSON.stringify([...bookmarked]));
    } catch (e) {
      // localStorage unavailable — bookmark still applies for this
      // session, just won't persist across reloads.
      console.warn('BookmarkManager: failed to save bookmarks.', e);
      if (onSaveError) onSaveError(e);
    }
  },

  count() {
    return bookmarked.size;
  },

  // Removes every bookmark. Used by the "清空收藏" confirm-gated action —
  // callers are responsible for their own confirmation UX, this just does
  // the actual clearing + persisting.
  clear() {
    bookmarked = new Set();
    this.save();
  },

  // Exposes the live Set for SearchManager's "只看收藏" filter — read-only
  // by convention (nothing outside this module should mutate it directly;
  // toggle()/save() are the only sanctioned write path, matching the
  // private-state pattern used in speech.js/search.js).
  getSet() {
    return bookmarked;
  }
};

export { BookmarkManager };
