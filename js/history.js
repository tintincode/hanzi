import { StorageManager } from './storage.js';
import { Templates } from './templates.js';

// history.js
// HistoryManager: owns practice-session persistence (localStorage) and the
// history panel UI (list, rename, delete, select).
//
// Unlike SpeechManager, this isn't a fully standalone wrapper around a
// browser API — practice sessions are inherently tied to what's currently
// on screen (which level is selected, which cards are marked, whether
// study mode is on). So HistoryManager holds a reference to the host app
// (set in init()) and reads/writes a handful of shared things through it:
// app.state.{currentFilter, currentSearch, wrongOnly, studyResults,
// practiceActiveId, isStudyMode, markHistory}, app.dom, app.allChars,
// app.constants.LEVEL_RANGES, and a few app methods (renderGrid,
// updateScore, updateUndoUI, updateFilterButtons, updateHeaderOffset,
// setStudy, scrollToPracticeCard, syncPracticeSelection, openMiniModal).
//
// Usage:
//   HistoryManager.init(HanziApp); // once, after HanziApp.cacheDOM()
//   HistoryManager.syncActiveSession(); // once, after bindEvents/setup

// Standalone and deliberately `this`-free — renderHistoryPanelList() passes
// this around as a bare function reference (into Templates.historyCard()),
// which would silently lose any `this` binding if this were a method
// instead. Keeping it a plain function makes that safe by construction
// rather than by convention.
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

const HistoryManager = {
  // Note: HISTORY_KEY / MAX_HISTORY_SESSIONS live in storage.js only —
  // StorageManager owns persistence details, HistoryManager just calls it.
  state: {
    historyState: { version: 1, activeSessionId: null, practiceMode: false, sessions: [] },
    activeSession: null,
    historySaveTimer: null,
    historyDirty: false,
    // Set by startNewPracticeSession(), consumed by the next level-filter
    // switch: carries "start fresh" intent forward to whichever level the
    // user actually lands on next, rather than scoping 新练习 only to
    // whatever level happened to be selected at the moment it was pressed.
    // Deliberately in-memory only (not part of historyState / not
    // persisted) — a one-shot intent, not a durable setting; it naturally
    // lapses on reload the same way an un-acted-on click would.
    pendingFreshStart: false
  },

  app: null,

  init(app) {
    this.app = app;
    this.loadHistoryState();
  },

  loadHistoryState() {
    this.state.historyState = StorageManager.load();
  },

  saveHistoryState() {
    StorageManager.save(this.state.historyState);
  },

  // --- Backup / restore (练习模式 history only — exports exactly what
  // StorageManager persists, so nothing needs to know about this format
  // beyond StorageManager itself) ---

  exportHistory() {
    this.saveActiveSession(true); // flush any pending progress first
    const data = JSON.stringify(this.state.historyState, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `hanzi-study-history-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  // Merge by session id, keeping whichever copy (local or imported) has the
  // later updatedAt — so restoring a backup on a device that already has
  // some progress never silently discards it.
  mergeSessionsById(localSessions, importedSessions) {
    const map = new Map();
    localSessions.forEach(s => map.set(s.id, s));
    importedSessions.forEach(s => {
      const existing = map.get(s.id);
      if (!existing || (s.updatedAt || 0) > (existing.updatedAt || 0)) {
        map.set(s.id, s);
      }
    });
    return Array.from(map.values());
  },

  // Rebuilds a session from only the parts of an imported record we
  // actually trust, rather than passing the raw parsed object straight
  // into storage. In particular, `correct`/`wrong` are recomputed from
  // `results` instead of trusting whatever counts the file claims — a
  // hand-edited or corrupted backup could otherwise show a plausible-
  // looking but wrong accuracy figure with no way to notice. Unrecognized
  // result values, non-integer result keys, and malformed markHistory
  // entries are silently dropped rather than rejecting the whole session,
  // since a single bad field shouldn't discard an otherwise-good record.
  sanitizeImportedSession(s) {
    const results = {};
    let correct = 0;
    let wrong = 0;
    for (const [id, val] of Object.entries(s.results || {})) {
      if (!/^\d+$/.test(id)) continue; // keys must be plain character ids
      if (val === 'c') { results[id] = 'c'; correct++; }
      else if (val === 'w') { results[id] = 'w'; wrong++; }
      // anything else (unrecognized value) is silently dropped
    }

    const markHistory = Array.isArray(s.markHistory)
      ? s.markHistory.filter(m =>
          m && Number.isInteger(m.id) &&
          (m.prevResult === undefined || m.prevResult === null || m.prevResult === 'correct' || m.prevResult === 'wrong')
        )
      : [];

    return {
      id: s.id,
      level: s.level,
      label: typeof s.label === 'string' ? s.label : this.levelName(s.level),
      createdAt: Number.isFinite(s.createdAt) ? s.createdAt : Date.now(),
      updatedAt: Number.isFinite(s.updatedAt) ? s.updatedAt : Date.now(),
      lastId: Number.isInteger(s.lastId) ? s.lastId : null,
      correct,
      wrong,
      results,
      markHistory
    };
  },

  importHistoryFromFile(file) {
    const alert = (title, text) => this.app.openMiniModal({ title, text, confirmLabel: '确定', onConfirm: () => {} });

    const reader = new FileReader();
    reader.onerror = () => alert('导入失败', '读取文件时发生错误，请重试。');
    reader.onload = () => {
      let parsed;
      try {
        parsed = JSON.parse(reader.result);
      } catch (e) {
        alert('导入失败', '所选文件不是有效的 JSON 格式。');
        return;
      }
      if (!parsed || !Array.isArray(parsed.sessions)) {
        alert('导入失败', '文件内容与历史记录格式不符。');
        return;
      }
      // Basic sanity filter — keep only entries that actually look like sessions.
      const validSessions = parsed.sessions
        .filter(s => s && typeof s.id === 'string' && typeof s.level !== 'undefined' && s.results && typeof s.results === 'object')
        .map(s => this.sanitizeImportedSession(s));
      if (!validSessions.length) {
        alert('导入失败', '文件中没有可识别的练习记录。');
        return;
      }

      const before = this.state.historyState.sessions.length;
      this.state.historyState.sessions = this.mergeSessionsById(this.state.historyState.sessions, validSessions);
      this.saveHistoryState(); // StorageManager.save() trims as part of writing

      // If the currently active session was among the imported ones, reload
      // its (possibly newer) data into the live view so what's on screen
      // matches what's now in storage.
      if (this.state.activeSession) {
        const refreshed = this.getSession(this.state.activeSession.id);
        if (refreshed) {
          this.state.activeSession = refreshed;
          this.loadSessionResults(refreshed);
          if (this.app.state.isStudyMode) this.app.renderGrid(false);
        }
      }

      this.updateHistorySelect();
      const added = Math.max(0, this.state.historyState.sessions.length - before);
      alert('导入完成', `已处理 ${validSessions.length} 条记录（新增 ${added} 条，其余为更新或重复，已自动合并）。`);
    };
    reader.readAsText(file);
  },

  syncActiveSession() {
    const initialSession = this.getSession(this.state.historyState.activeSessionId) || this.state.historyState.sessions[0] || null;

    if (this.state.historyState.practiceMode && initialSession) {
      // Only restore the saved level filter / search / view state when
      // we're actually resuming into 练习模式. Otherwise a past exercise
      // session would silently force the level filter (e.g. always
      // landing on 一级 3500) even for a plain 阅读模式 page load, which
      // breaks the independence between the two modes.
      this.activateSession(initialSession);
      this.app.setStudy(true);
      return true; // setStudy(true) already rendered + scrolled to the resume position
    }

    this.updateHistorySelect();
    return false;
  },

  scheduleHistorySave() {
    clearTimeout(this.state.historySaveTimer);
    this.state.historySaveTimer = setTimeout(() => this.saveActiveSession(), 250);
  },

  levelName(level) {
    const names = { '1': '一级', '2': '二级', '3': '三级' };
    return level === 'all' ? '全部' : (names[level] || `${level}级`);
  },

  levelTotal(level) {
    if (level === 'all') return this.app.allChars.length;
    const range = this.app.constants.LEVEL_RANGES[level];
    return range ? (range[1] - range[0] + 1) : 0;
  },

  formatSessionTime(ts) {
    const date = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  },

  createPracticeSession(level = this.app.state.currentFilter) {
    const now = Date.now();
    const session = {
      id: `s_${now}_${Math.random().toString(36).slice(2, 8)}`,
      level,
      label: `${this.levelName(level)} ${this.formatSessionTime(now)}`,
      createdAt: now,
      updatedAt: now,
      lastId: null,
      correct: 0,
      wrong: 0,
      results: {},
      markHistory: []
    };
    // Not added to historyState.sessions / persisted yet — only happens once the
    // first card is actually marked, in saveActiveSession(). This avoids
    // littering history with empty sessions from opening practice mode or
    // pressing "新练习" without reviewing anything.
    this.state.activeSession = session;
    this.state.historyState.activeSessionId = session.id;
    this.updateHistorySelect();
    return session;
  },

  getSession(id) {
    return this.state.historyState.sessions.find(s => s.id === id) || null;
  },

  getLatestSessionForLevel(level) {
    return this.state.historyState.sessions
      .filter(s => s.level === level)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null;
  },

  activateSession(session) {
    if (!session) return;
    this.state.activeSession = session;
    this.state.historyState.activeSessionId = session.id;
    this.app.state.currentFilter = session.level || 'all';
    this.app.state.currentSearch = '';
    this.app.dom.search.value = '';
    this.app.state.wrongOnly = false;
    this.app.dom.wrongFilterBtn.setAttribute('aria-pressed', 'false');
    this.app.updateFilterButtons();
    this.loadSessionResults(session);
    this.updateHistorySelect();
  },

  loadSessionResults(session) {
    this.app.state.studyResults.clear();
    // Restores the undo stack too, not just the final marks — without
    // this, undo would still reset on every refresh/mode-switch even
    // though the marks themselves persist, since there'd be nothing to
    // rebuild the stack from.
    this.app.state.markHistory = Array.isArray(session.markHistory) ? session.markHistory.slice() : [];
    const results = session.results || {};
    Object.entries(results).forEach(([id, result]) => {
      if (result === 'c') this.app.state.studyResults.set(parseInt(id, 10), 'correct');
      if (result === 'w') this.app.state.studyResults.set(parseInt(id, 10), 'wrong');
    });
    this.app.state.practiceActiveId = session.lastId || null;
    this.app.updateScore();
    this.app.updateUndoUI();
  },

  saveActiveSession(force = false) {
    clearTimeout(this.state.historySaveTimer);
    if (!this.state.activeSession) return;
    if (!force && !this.app.state.isStudyMode) return;
    // A forced flush (e.g. switching the level filter) shouldn't touch the
    // session's updatedAt / re-sort history if nothing was actually marked
    // since the last save — otherwise just clicking between level tabs
    // reshuffles the history list with no new practice happening.
    if (!this.state.historyDirty) return;

    const results = {};
    let correct = 0;
    let wrong = 0;
    for (const [id, result] of this.app.state.studyResults.entries()) {
      if (result === 'correct') {
        results[id] = 'c';
        correct++;
      } else if (result === 'wrong') {
        results[id] = 'w';
        wrong++;
      }
    }
    this.state.activeSession.level = this.app.state.currentFilter;
    this.state.activeSession.lastId = this.app.state.practiceActiveId;
    this.state.activeSession.results = results;
    this.state.activeSession.correct = correct;
    this.state.activeSession.wrong = wrong;
    this.state.activeSession.markHistory = this.app.state.markHistory.slice();
    this.state.activeSession.updatedAt = Date.now();
    this.state.historyState.activeSessionId = this.state.activeSession.id;
    this.state.historyDirty = false;

    const hasProgress = Object.keys(results).length > 0;
    const alreadyTracked = this.state.historyState.sessions.some(s => s.id === this.state.activeSession.id);
    if (!hasProgress) {
      // Nothing has been marked yet — don't litter history with an empty entry.
      // (If it was already tracked from a previous mark that got reset, leave
      // it in place; we only skip *adding* new empty sessions.)
      if (!alreadyTracked) return;
    } else if (!alreadyTracked) {
      this.state.historyState.sessions.unshift(this.state.activeSession);
    }

    this.saveHistoryState();
    this.updateHistorySelect();
  },

  updateHistorySelect() {
    const count = this.state.historyState.sessions.length;
    this.app.dom.historyCount.textContent = count;
    this.app.dom.historyCount.style.display = count > 0 ? '' : 'none';
    if (this.app.dom.historyPanel.classList.contains('open')) this.renderHistoryPanelList();
  },

  openHistoryPanel() {
    this.renderHistoryPanelList();
    this.app.dom.historyPanel.classList.add('open');
    document.addEventListener('keydown', this.handleHistoryPanelKeydown);
    const firstCard = this.app.dom.historyPanelList.querySelector('.history-card');
    this.app.openFocusTrap(this.app.dom.historyPanel, firstCard || this.app.dom.historyPanelClose);
  },

  closeHistoryPanel() {
    if (!this.app.dom.historyPanel.classList.contains('open')) return;
    this.app.dom.historyPanel.classList.remove('open');
    document.removeEventListener('keydown', this.handleHistoryPanelKeydown);
    this.app.closeFocusTrap();
  },

  handleHistoryPanelKeydown(e) {
    if (e.key === 'Escape') HistoryManager.closeHistoryPanel();
  },

  renderHistoryPanelList() {
    const sessions = [...this.state.historyState.sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (sessions.length === 0) {
      this.app.dom.historyPanelList.innerHTML = Templates.emptyHistory();
      return;
    }
    const iconEdit = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
    const iconDelete = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
    this.app.dom.historyPanelList.innerHTML = sessions.map(session => {
      const reviewed = Object.keys(session.results || {}).length;
      const accuracy = (session.correct || 0) + (session.wrong || 0) > 0
        ? `${Math.round((session.correct || 0) / ((session.correct || 0) + (session.wrong || 0)) * 100)}%`
        : '—';
      const isActive = session.id === this.state.historyState.activeSessionId;
      const total = this.levelTotal(session.level);
      const isComplete = total > 0 && reviewed >= total;
      const title = session.label || this.levelName(session.level);
      const meta = `${reviewed}/${total} 字 · 正确率 ${accuracy} · 对${session.correct || 0} / 错${session.wrong || 0}`;
      return Templates.historyCard(session, isActive, isComplete, title, meta, iconEdit, iconDelete, escapeHtml);
    }).join('');

    this.app.dom.historyPanelList.querySelectorAll('.history-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.history-rename-btn') || e.target.closest('.history-delete-btn')) return;
        this.selectHistorySession(card.dataset.sessionId);
      });
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.selectHistorySession(card.dataset.sessionId); }
      });
    });
    this.app.dom.historyPanelList.querySelectorAll('.history-rename-btn').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); this.renameSession(btn.dataset.sessionId); });
    });
    this.app.dom.historyPanelList.querySelectorAll('.history-delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); this.deleteSession(btn.dataset.sessionId); });
    });
  },

  // Discards the active session if it's still empty (no cards marked yet) —
  // used when the user switches the level filter before reviewing anything,
  // so we don't leave an empty session hanging around. If the session
  // already has progress, this just flushes it to storage instead.
  // Returns true if a session was discarded (caller may want to react).
  discardEmptyActiveSession() {
    if (!this.state.activeSession) return false;
    if (this.app.state.studyResults.size === 0) {
      const id = this.state.activeSession.id;
      this.state.historyState.sessions = this.state.historyState.sessions.filter(s => s.id !== id);
      this.state.activeSession = null;
      this.state.historyState.activeSessionId = null;
      this.saveHistoryState();
      this.updateHistorySelect();
      return true;
    }
    this.saveActiveSession(true);
    return false;
  },

  ensurePracticeSession() {
    if (this.state.activeSession && this.state.activeSession.level === this.app.state.currentFilter) {
      this.loadSessionResults(this.state.activeSession);
      return this.state.activeSession;
    }
    const session = this.getLatestSessionForLevel(this.app.state.currentFilter) || this.createPracticeSession(this.app.state.currentFilter);
    this.activateSession(session);
    return session;
  },

  renameSession(id) {
    const session = this.getSession(id);
    if (!session) return;
    const current = session.label || this.levelName(session.level);
    this.app.openMiniModal({
      title: '重命名记录',
      withInput: true,
      inputValue: current,
      confirmLabel: '保存',
      onConfirm: (value) => {
        session.label = value;
        this.saveHistoryState();
        this.updateHistorySelect();
        if (this.app.dom.historyPanel.classList.contains('open')) this.renderHistoryPanelList();
      }
    });
  },

  deleteSession(id) {
    const session = this.getSession(id);
    if (!session) return;
    const label = session.label || this.levelName(session.level);
    this.app.openMiniModal({
      title: '删除记录',
      text: `确定要删除记录「${label}」吗？删除后将无法恢复。`,
      confirmLabel: '删除',
      danger: true,
      onConfirm: () => {
        const deletedId = session.id;
        const deletedLevel = session.level;
        const wasActive = this.state.activeSession && this.state.activeSession.id === deletedId;
        this.state.historyState.sessions = this.state.historyState.sessions.filter(s => s.id !== deletedId);

        if (wasActive) {
          this.state.activeSession = null;
          this.state.historyState.activeSessionId = null;
          const inStudyMode = this.app.state.isStudyMode;
          const fallback = this.getLatestSessionForLevel(deletedLevel) || this.state.historyState.sessions[0] || null;
          if (fallback) {
            this.activateSession(fallback);
          } else if (inStudyMode) {
            const newSession = this.createPracticeSession(this.app.state.currentFilter);
            this.activateSession(newSession);
          } else {
            this.app.state.studyResults.clear();
            this.app.state.practiceActiveId = null;
            this.updateHistorySelect();
          }
          this.app.renderGrid(true);
        }

        this.saveHistoryState();
        if (this.app.dom.historyPanel.classList.contains('open')) this.renderHistoryPanelList();
      }
    });
  },

  selectHistorySession(id) {
    const session = this.getSession(id);
    if (!session) return;
    this.closeHistoryPanel();
    this.saveActiveSession(true);
    // An explicit pick from the history panel always wins over any
    // still-pending "start fresh on next switch" intent from an earlier
    // 新练习 click — otherwise picking a specific old session here could
    // get silently discarded by the very next level switch.
    this.state.pendingFreshStart = false;
    this.activateSession(session);
    this.state.historyState.practiceMode = true;
    document.body.classList.add('study-mode');
    this.app.state.isStudyMode = true;
    this.app.dom.btnNormal.classList.remove('active');
    this.app.dom.btnStudy.classList.add('active');
    this.app.renderGrid(false);
    this.saveHistoryState();
    this.app.updateHeaderOffset();
    this.app.scrollToPracticeCard(this.app.state.practiceActiveId);
  },

  startNewPracticeSession() {
    // Carries "start fresh" intent forward to whichever level the user
    // switches to next (see state.pendingFreshStart comment above),
    // regardless of which branch below actually runs.
    this.state.pendingFreshStart = true;

    if (this.state.activeSession && this.app.state.studyResults.size === 0) {
      const now = Date.now();
      this.state.activeSession.createdAt = now;
      this.state.activeSession.updatedAt = now;
      this.state.activeSession.label = `${this.levelName(this.state.activeSession.level)} ${this.formatSessionTime(now)}`;
      this.saveHistoryState();
      this.updateHistorySelect();
      this.app.state.practiceActiveId = null;
      this.app.syncPracticeSelection();
      return;
    }
    this.saveActiveSession(true);
    const session = this.createPracticeSession(this.app.state.currentFilter);
    this.activateSession(session);
    this.app.state.studyResults.clear();
    this.app.state.practiceActiveId = null;
    this.app.updateScore();
    this.app.renderGrid(true);
    this.saveActiveSession(true);
  }
};


export { HistoryManager };
