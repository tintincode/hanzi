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
// whichever level tab happened to be open at the time.
//
// Scope note: 阅读模式 only, by design (not 练习模式). In 练习模式, marking
// a card 错 already serves the "flag this for review" need via 只看错题 —
// a second, overlapping affordance there would just be confusing. The
// gap this actually fills is browsing without a grading signal at all.

const STORAGE_KEY = 'hanziStudyBookmarks.v1';

let bookmarked = new Set();

const BookmarkManager = {
  init() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      bookmarked = new Set(Array.isArray(arr) ? arr.filter(n => Number.isInteger(n)) : []);
    } catch (e) {
      console.warn('BookmarkManager: failed to load bookmarks, starting empty.', e);
      bookmarked = new Set();
    }
  },

  isBookmarked(id) {
    return bookmarked.has(id);
  },

  // Returns the new state (true = now bookmarked, false = now removed).
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
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...bookmarked]));
    } catch (e) {
      // localStorage unavailable — bookmark still applies for this
      // session, just won't persist across reloads.
      console.warn('BookmarkManager: failed to save bookmarks.', e);
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
