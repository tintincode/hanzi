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
    // Set by startNewPracticeSession() (新练习), consumed by the very next
    // selectChunk() (app.js) — without this, picking a chunk/level you'd
    // already made progress on would just *resume* that existing session
    // (selectChunk's normal, correct behavior for an ordinary picker
    // click), defeating the entire point of 新练习: picking a chunk right
    // after it should always start a genuinely new attempt, even if that
    // exact chunk already has progress. One-shot and in-memory only (not
    // part of historyState / not persisted) — cleared the moment it's
    // consumed, and also whenever study mode is left (setStudy(false) in
    // app.js) so it can never linger into an unrelated later resume.
    pendingFreshStart: false,
    // Bulk-delete "select mode" (选择 toggle in the history panel) — both
    // in-memory only, reset whenever the panel closes (see
    // closeHistoryPanel) so reopening it later never starts back in select
    // mode from last time.
    historySelectMode: false,
    selectedSessionIds: new Set()
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
    const ok = StorageManager.save(this.state.historyState);
    // A failure here is almost always a full localStorage quota — see
    // app.js's showStorageWarning() for why this surfaces to the person
    // instead of just the console.error already logged inside
    // StorageManager.save(). Checked at this single call site rather than
    // at each of saveHistoryState()'s several callers, since they'd all
    // need the identical check otherwise.
    if (!ok && this.app) this.app.showStorageWarning();
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
      // null (or absent, pre-chunking) means "whole level"; only accept a
      // genuine non-negative integer otherwise, same distrust-the-file
      // stance as everything else in this function.
      chunkIndex: Number.isInteger(s.chunkIndex) && s.chunkIndex >= 0 ? s.chunkIndex : null,
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

  // How many characters chunk `chunkIndex` of `level` actually covers — the
  // last chunk in a level is usually smaller than PRACTICE_GROUP_SIZE (e.g.
  // 三级's 1605 characters don't divide evenly by 100), so this can't just
  // return PRACTICE_GROUP_SIZE unconditionally.
  chunkTotal(level, chunkIndex) {
    const groupSize = this.app.constants.PRACTICE_GROUP_SIZE;
    const levelTotal = this.levelTotal(level);
    const start = chunkIndex * groupSize;
    return Math.max(0, Math.min(start + groupSize, levelTotal) - start);
  },

  formatSessionTime(ts) {
    const date = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  },

  createPracticeSession(level = this.app.state.currentFilter, chunkIndex = null) {
    const now = Date.now();
    const namePart = chunkIndex != null ? `${this.levelName(level)} 组${chunkIndex + 1}` : this.levelName(level);
    const session = {
      id: `s_${now}_${Math.random().toString(36).slice(2, 8)}`,
      level,
      // null = whole-level session (the only kind that existed before
      // chunking was added) — number = a fixed PRACTICE_GROUP_SIZE-sized
      // group within the level, see openChunkPicker()/selectChunk() in app.js.
      chunkIndex,
      label: `${namePart} ${this.formatSessionTime(now)}`,
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
    // Whole-level only (chunkIndex null/absent) — deliberately does NOT
    // match chunked sessions, so this keeps meaning exactly what it meant
    // before chunking existed: "the most recent session covering this
    // entire level." Used by the picker's 整个级别 cell and by
    // ensurePracticeSession()'s fallback. For "any session touching this
    // level, chunked or not" (e.g. a reasonable resume target after
    // deleting the active one), see getLatestSessionForLevelAnyChunk below.
    return this.state.historyState.sessions
      .filter(s => s.level === level && s.chunkIndex == null)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null;
  },

  getLatestSessionForLevelAnyChunk(level) {
    return this.state.historyState.sessions
      .filter(s => s.level === level)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null;
  },

  getSessionForLevelChunk(level, chunkIndex) {
    return this.state.historyState.sessions
      .filter(s => s.level === level && s.chunkIndex === chunkIndex)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null;
  },

  activateSession(session) {
    if (!session) return;
    this.state.activeSession = session;
    this.state.historyState.activeSessionId = session.id;
    this.app.state.currentFilter = session.level || 'all';
    this.app.state.practiceChunkIndex = (typeof session.chunkIndex === 'number') ? session.chunkIndex : null;
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
    this.state.historySelectMode = false;
    this.state.selectedSessionIds.clear();
  },

  handleHistoryPanelKeydown(e) {
    if (e.key !== 'Escape') return;
    if (HistoryManager.state.historySelectMode) {
      HistoryManager.toggleSelectMode();
      return;
    }
    HistoryManager.closeHistoryPanel();
  },

  renderHistoryPanelList() {
    const sessions = [...this.state.historyState.sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    this.app.dom.historyPanelList.classList.toggle('select-mode', this.state.historySelectMode);
    if (sessions.length === 0) {
      this.app.dom.historyPanelList.innerHTML = Templates.emptyHistory();
      this.updateHistorySelectToolbar();
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
      const isSelected = this.state.selectedSessionIds.has(session.id);
      const isChunked = typeof session.chunkIndex === 'number';
      const total = isChunked ? this.chunkTotal(session.level, session.chunkIndex) : this.levelTotal(session.level);
      const isComplete = total > 0 && reviewed >= total;
      const defaultTitle = isChunked ? `${this.levelName(session.level)} 组${session.chunkIndex + 1}` : this.levelName(session.level);
      const title = session.label || defaultTitle;
      const meta = `${reviewed}/${total} 字 · 正确率 ${accuracy} · 对${session.correct || 0} / 错${session.wrong || 0}`;
      return Templates.historyCard(session, isActive, isComplete, isSelected, title, meta, iconEdit, iconDelete, escapeHtml);
    }).join('');

    this.app.dom.historyPanelList.querySelectorAll('.history-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.history-rename-btn') || e.target.closest('.history-delete-btn')) return;
        // In select mode the whole card is one big tap target for
        // toggling selection (not just the small checkbox) — same
        // "generous tap target" reasoning already applied throughout this
        // app's touch-target handling. Opening/resuming a session only
        // happens outside select mode.
        if (this.state.historySelectMode) {
          this.toggleSessionSelected(card.dataset.sessionId);
          return;
        }
        this.selectHistorySession(card.dataset.sessionId);
      });
      card.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        if (this.state.historySelectMode) {
          this.toggleSessionSelected(card.dataset.sessionId);
        } else {
          this.selectHistorySession(card.dataset.sessionId);
        }
      });
    });
    this.app.dom.historyPanelList.querySelectorAll('.history-card-check').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); this.toggleSessionSelected(btn.dataset.sessionId); });
    });
    this.app.dom.historyPanelList.querySelectorAll('.history-rename-btn').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); this.renameSession(btn.dataset.sessionId); });
    });
    this.app.dom.historyPanelList.querySelectorAll('.history-delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); this.deleteSession(btn.dataset.sessionId); });
    });
    this.updateHistorySelectToolbar();
  },

  // 选择/取消 toggle button (history-select-toggle-btn).
  toggleSelectMode() {
    this.state.historySelectMode = !this.state.historySelectMode;
    if (!this.state.historySelectMode) this.state.selectedSessionIds.clear();
    this.renderHistoryPanelList();
  },

  toggleSessionSelected(id) {
    if (this.state.selectedSessionIds.has(id)) {
      this.state.selectedSessionIds.delete(id);
    } else {
      this.state.selectedSessionIds.add(id);
    }
    // Only this one card's checkbox state actually changed — update it
    // directly rather than re-rendering the whole list, so selecting
    // several items in a row doesn't rebuild/reflow the entire panel each
    // time.
    const card = this.app.dom.historyPanelList.querySelector(`.history-card[data-session-id="${id}"]`);
    if (card) {
      const isSelected = this.state.selectedSessionIds.has(id);
      card.querySelector('.history-card-check').setAttribute('aria-pressed', isSelected ? 'true' : 'false');
    }
    this.updateHistorySelectToolbar();
  },

  // 全选/取消全选 toggle (history-select-all-btn) — selects every currently
  // listed session, or clears the selection entirely if everything is
  // already selected.
  toggleSelectAllSessions() {
    const allIds = this.state.historyState.sessions.map(s => s.id);
    const allSelected = allIds.length > 0 && allIds.every(id => this.state.selectedSessionIds.has(id));
    if (allSelected) {
      this.state.selectedSessionIds.clear();
    } else {
      this.state.selectedSessionIds = new Set(allIds);
    }
    this.renderHistoryPanelList();
  },

  // Keeps the select-mode toggle button's label, the toolbar's
  // visibility/count, and the bulk-delete button's disabled state all in
  // sync with historySelectMode/selectedSessionIds — called after every
  // render and every selection change rather than duplicating this logic
  // at each call site.
  updateHistorySelectToolbar() {
    const on = this.state.historySelectMode;
    this.app.dom.historySelectToggleBtn.textContent = on ? '取消' : '选择';
    this.app.dom.historySelectToolbar.hidden = !on;
    if (!on) return;
    const count = this.state.selectedSessionIds.size;
    this.app.dom.historySelectCount.textContent = `已选择 ${count} 项`;
    this.app.dom.historyBulkDeleteBtn.disabled = count === 0;
    const allIds = this.state.historyState.sessions.map(s => s.id);
    const allSelected = allIds.length > 0 && allIds.every(id => this.state.selectedSessionIds.has(id));
    this.app.dom.historySelectAllBtn.textContent = allSelected ? '取消全选' : '全选';
  },

  // Delete-bin icon in the select-mode toolbar.
  bulkDeleteSelected() {
    const ids = new Set(this.state.selectedSessionIds);
    if (ids.size === 0) return;
    this.app.openMiniModal({
      title: '删除记录',
      text: `确定要删除这 ${ids.size} 条记录吗？删除后将无法恢复。`,
      confirmLabel: '删除',
      danger: true,
      onConfirm: () => {
        const deletedActiveSession = this.state.activeSession && ids.has(this.state.activeSession.id);
        const deletedLevel = deletedActiveSession ? this.state.activeSession.level : null;
        this.state.historyState.sessions = this.state.historyState.sessions.filter(s => !ids.has(s.id));
        this.state.selectedSessionIds.clear();
        this.state.historySelectMode = false;

        if (deletedActiveSession) {
          // Same fallback reasoning as the single-session deleteSession()
          // below — prefer another session for the same level over a
          // stale reference to one that no longer exists.
          this.state.activeSession = null;
          this.state.historyState.activeSessionId = null;
          const inStudyMode = this.app.state.isStudyMode;
          const fallback = this.getLatestSessionForLevelAnyChunk(deletedLevel) || this.state.historyState.sessions[0] || null;
          if (fallback) {
            this.activateSession(fallback);
            this.app.renderGrid(true);
          } else if (inStudyMode) {
            this.app.openChunkPicker();
          } else {
            this.app.state.studyResults.clear();
            this.app.state.practiceActiveId = null;
            this.app.renderGrid(true);
          }
        }

        this.saveHistoryState();
        // See deleteSession()'s matching comment above — always refresh
        // the header's session-count badge, not just when the active
        // session happened to be among those deleted.
        this.updateHistorySelect();
      }
    });
  },

  // Discards the active session if it's still empty (no cards marked yet) —
  // used when the user switches the level filter before reviewing anything,
  // so we don't leave an empty session hanging around. If the session
  // already has progress, this just flushes it to storage instead.
  // Returns true if a session was discarded (caller may want to react).
  discardEmptyActiveSession() {
    if (!this.state.activeSession) return false;
    const alreadyTracked = this.state.historyState.sessions.some(s => s.id === this.state.activeSession.id);
    if (!alreadyTracked && this.app.state.studyResults.size === 0) {
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
    if (this.state.activeSession) {
      // Already have an active session — resync currentFilter/
      // practiceChunkIndex from it rather than requiring them to already
      // match. Level selection is 阅读模式-only now (see index.html/
      // app.js's filterLevelGroup handler), so currentFilter can freely
      // drift away from whatever level this session belongs to while it
      // sits paused in the background (e.g. browsing in 阅读模式, then
      // switching back into 练习模式) — this is what makes that resume
      // land on the right level/chunk regardless.
      //
      // Deliberately doesn't call loadSessionResults() here — that used
      // to run unconditionally as a "safety net," but that was actively
      // harmful: it overwrites app.state.studyResults from this session's
      // last *persisted* results, which can be stale if a recent action
      // hasn't been force-flushed back into the session object yet
      // (undoLastMark() only debounces its save — see its own comment).
      // Calling this on every mark-button click could then silently
      // revert a just-made undo the moment a second click landed before
      // that debounce fired.
      this.app.state.currentFilter = this.state.activeSession.level || 'all';
      this.app.state.practiceChunkIndex = (typeof this.state.activeSession.chunkIndex === 'number') ? this.state.activeSession.chunkIndex : null;
      return this.state.activeSession;
    }
    // No active session at all. Practice mode no longer has its own level
    // selector (the chunk picker always shows every level — see app.js's
    // openChunkPicker), so there's no meaningful "desired level" to fall
    // back to here beyond a sensible default; this branch is effectively
    // unreachable via the UI (setStudy(true) always shows the picker when
    // there's no active session), kept only as a defensive fallback.
    const session = this.createPracticeSession('all');
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
          // Prefer another session still covering the same level (chunked or
          // whole — whichever was touched most recently) over the previous
          // "just grab sessions[0]" fallback, which could land on a
          // completely unrelated level's session with no connection to what
          // the user was just doing.
          const fallback = this.getLatestSessionForLevelAnyChunk(deletedLevel) || this.state.historyState.sessions[0] || null;
          if (fallback) {
            this.activateSession(fallback);
            this.app.renderGrid(true);
          } else if (inStudyMode) {
            // Nothing left to resume for this level — back to the chunk
            // picker rather than silently starting a brand-new whole-level
            // session on the user's behalf.
            this.app.openChunkPicker();
          } else {
            this.app.state.studyResults.clear();
            this.app.state.practiceActiveId = null;
            this.app.renderGrid(true);
          }
        }

        this.saveHistoryState();
        // Always refresh the header's session-count badge — not just when
        // the deleted session happened to be the active one (previously
        // this was only called from inside that branch above, so deleting
        // any *other* session left the badge showing a stale, too-high
        // count until something unrelated happened to refresh it).
        // updateHistorySelect() already re-renders the panel list itself
        // if it's open, so the explicit check that used to live here is
        // redundant now.
        this.updateHistorySelect();
      }
    });
  },

  selectHistorySession(id) {
    const session = this.getSession(id);
    if (!session) return;
    this.closeHistoryPanel();
    this.saveActiveSession(true);
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

  // 新练习 (score-reset-btn). With chunking, "start fresh" is now just "go
  // back and pick a chunk" — the old version of this method existed to
  // relabel/reuse an already-empty active session or create a brand-new
  // whole-level one immediately, both of which mattered a lot more when a
  // session was necessarily the entire (thousands-strong) level. Flushing
  // to the picker sidesteps most of that complexity: opening the picker
  // creates nothing by itself (same "not persisted until first mark"
  // principle as createPracticeSession), so there's no clutter risk from
  // returning to it. pendingFreshStart handles the one piece that
  // sidestepping isn't enough for on its own — see its own comment above.
  startNewPracticeSession() {
    this.discardEmptyActiveSession();
    this.state.pendingFreshStart = true;
    this.app.openChunkPicker();
  }
};


export { HistoryManager };
