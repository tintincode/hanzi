// js/storage.js
// StorageManager: handles all interactions with localStorage, history state structure,
// data migration (versioning), and history session pruning.

const HISTORY_KEY_BASE = 'hanziStudyHistory.v1';
// Raised from 30 to 100. At the app's typical grain (练习模式's
// PRACTICE_GROUP_SIZE-sized chunked sessions, ~100 characters each,
// roughly 3KB of JSON per session), 100 sessions is ~300KB — trivial
// against any browser's localStorage quota. The one scenario worth
// knowing about: a whole, unchunked level session (up to 3500 characters
// for level 1) runs closer to ~57KB each, so 100 of *those* specifically
// would land around ~5.7MB — enough to bump into the ~5MB ceiling some
// browsers (notably Safari) enforce. This is per PROFILE (see
// profiles.js — each learner's history lives under its own key), so a
// device with several profiles all doing heavy whole-level practice
// multiplies that further. save() below already fails soft on a quota
// error (caught, logged, returns false) rather than throwing/crashing —
// worth remembering that means saves can start silently no-op'ing well
// before anyone would notice, not that this limit is unsafe to raise.
const MAX_HISTORY_SESSIONS = 100;

// Which profile's data load()/save() currently read and write — set once by
// ProfileManager during startup (see profiles.js), before HistoryManager
// ever calls load(). Module-private for the same "don't let external code
// silently swap this out mid-operation" reasoning used elsewhere in this
// app (SpeechManager/SearchManager's private state).
let profileId = null;

export const StorageManager = {
  // Every profile's history lives under its own key
  // (hanziStudyHistory.v1.<id>), so switching profiles never mixes one
  // learner's sessions with another's. Falls back to the legacy
  // unprefixed key if this is never called (profileId stays null) —
  // defensive: if ProfileManager somehow fails to initialize, the app
  // still reads/writes *something* consistent rather than silently
  // pointing at a key nothing else uses.
  setProfile(id) {
    profileId = id;
  },

  key() {
    return this.keyFor(profileId);
  },

  // Builds the storage key for an arbitrary profile id, independent of
  // whichever profile is currently active (the shared `profileId` above).
  // Used by loadFor()/saveFor() below, and by key() itself for the
  // normal (currently-active-profile) case.
  keyFor(id) {
    return id ? `${HISTORY_KEY_BASE}.${id}` : HISTORY_KEY_BASE;
  },

  load() {
    return this.loadFor(profileId);
  },

  // Same parsing/validation/trim as load(), but for an explicit profile
  // id rather than whichever one is currently active — reads directly
  // from that profile's own key without touching the shared `profileId`
  // pointer, so it's safe to call for a profile other than the active
  // one (e.g. profiles.js exporting a backup for a profile you haven't
  // switched to) without any risk of it bleeding into whatever's
  // currently loaded elsewhere.
  loadFor(id) {
    try {
      const raw = localStorage.getItem(this.keyFor(id));
      if (!raw) return this.defaultState();
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === 1 && Array.isArray(parsed.sessions)) {
        // Clean empty sessions created by previous versions
        parsed.sessions = parsed.sessions.filter(s => s.results && Object.keys(s.results).length > 0);
        if (!parsed.sessions.some(s => s.id === parsed.activeSessionId)) {
          parsed.activeSessionId = null;
        }
        this.trim(parsed);
        return parsed;
      }
    } catch (e) {
      console.warn("StorageManager: Failed to load history state, using default.", e);
    }
    return this.defaultState();
  },

  defaultState() {
    return { version: 1, activeSessionId: null, practiceMode: false, sessions: [] };
  },

  save(historyState) {
    return this.saveFor(profileId, historyState);
  },

  // Same as save(), but writes to an explicit profile id's own key
  // rather than whichever profile is currently active. See loadFor()'s
  // comment for why this matters.
  saveFor(id, historyState) {
    try {
      this.trim(historyState);
      localStorage.setItem(this.keyFor(id), JSON.stringify(historyState));
      return true;
    } catch (e) {
      console.error("StorageManager: Failed to save history state.", e);
      return false;
    }
  },

  // Trims in memory only — does NOT itself persist. Called from both
  // load() and save(): load() trims the just-parsed state so an in-memory
  // session list is never over MAX_HISTORY_SESSIONS, but that trim isn't
  // written back to localStorage until the next save() (which trims again
  // immediately before writing). In the narrow window between a load()'s
  // trim and the first subsequent save(), the on-disk copy can still
  // contain the untrimmed session list — inconsequential in practice
  // (a crash in that window just means the same sessions get trimmed
  // again on the next save()), but worth knowing this is "trim in memory"
  // rather than "trim = persist".
  trim(historyState) {
    const sessions = historyState.sessions;
    if (!Array.isArray(sessions)) return;
    sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (sessions.length > MAX_HISTORY_SESSIONS) {
      const activeId = historyState.activeSessionId;
      const kept = [];
      for (const s of sessions) {
        if (kept.length < MAX_HISTORY_SESSIONS || s.id === activeId) {
          kept.push(s);
        }
      }
      historyState.sessions = kept;
    }
  }
};
