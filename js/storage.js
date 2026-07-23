// js/storage.js
// StorageManager: handles all interactions with localStorage, history state structure,
// data migration (versioning), and history session pruning.

const HISTORY_KEY = 'hanziStudyHistory.v1';
const MAX_HISTORY_SESSIONS = 30;

export const StorageManager = {
  load() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
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
    try {
      this.trim(historyState);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(historyState));
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
