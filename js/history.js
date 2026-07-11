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
// practiceActiveId, isStudyMode, lastMarkAction}, app.dom, app.allChars,
// app.constants.LEVEL_RANGES, and a few app methods (renderGrid,
// updateScore, updateFilterButtons, updateHeaderOffset, setStudy,
// scrollToPracticeCard, syncPracticeSelection, openMiniModal).
//
// Usage:
//   HistoryManager.init(HanziApp); // once, after HanziApp.cacheDOM()
//   HistoryManager.syncActiveSession(); // once, after bindEvents/setup

const HistoryManager = {
  constants: {
    HISTORY_KEY: 'hanziStudyHistory.v1',
    MAX_HISTORY_SESSIONS: 30
  },

  state: {
    historyState: { version: 1, activeSessionId: null, practiceMode: false, sessions: [] },
    activeSession: null,
    historySaveTimer: null,
    historyDirty: false
  },

  app: null,

  init(app) {
    this.app = app;
    this.loadHistoryState();
  },

  loadHistoryState() {
    try {
      const raw = localStorage.getItem(this.constants.HISTORY_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === 1 && Array.isArray(parsed.sessions)) {
        // One-time cleanup: drop empty sessions saved by older versions of the
        // app (e.g. created by opening practice mode without marking anything).
        const before = parsed.sessions.length;
        parsed.sessions = parsed.sessions.filter(s => Object.keys(s.results || {}).length > 0);
        if (parsed.sessions.length !== before && !parsed.sessions.some(s => s.id === parsed.activeSessionId)) {
          parsed.activeSessionId = null;
        }
        this.state.historyState = parsed;
      }
    } catch (e) {
      this.state.historyState = { version: 1, activeSessionId: null, practiceMode: false, sessions: [] };
    }
  },

  saveHistoryState() {
    try {
      this.trimHistorySessions();
      localStorage.setItem(this.constants.HISTORY_KEY, JSON.stringify(this.state.historyState));
    } catch (e) {
      // Safe boundary fallback
    }
  },

  syncActiveSession() {
    this.trimHistorySessions();
    const initialSession = this.getSession(this.state.historyState.activeSessionId) || this.state.historyState.sessions[0] || null;
    if (initialSession) {
      this.activateSession(initialSession);
    } else {
      this.updateHistorySelect();
    }
    if (this.state.historyState.practiceMode && initialSession) {
      this.app.setStudy(true);
    }
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
      results: {}
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

  trimHistorySessions() {
    const sessions = this.state.historyState.sessions;
    sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (sessions.length > this.constants.MAX_HISTORY_SESSIONS) {
      const activeId = this.state.activeSession ? this.state.activeSession.id : null;
      const kept = [];
      for (const s of sessions) {
        if (kept.length < this.constants.MAX_HISTORY_SESSIONS || s.id === activeId) kept.push(s);
      }
      this.state.historyState.sessions = kept;
    }
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
    this.app.state.lastMarkAction = null;
    const results = session.results || {};
    Object.entries(results).forEach(([id, result]) => {
      if (result === 'c') this.app.state.studyResults.set(parseInt(id, 10), 'correct');
      if (result === 'w') this.app.state.studyResults.set(parseInt(id, 10), 'wrong');
    });
    this.app.state.practiceActiveId = session.lastId || null;
    this.app.updateScore();
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
  },

  closeHistoryPanel() {
    this.app.dom.historyPanel.classList.remove('open');
    document.removeEventListener('keydown', this.handleHistoryPanelKeydown);
  },

  handleHistoryPanelKeydown(e) {
    if (e.key === 'Escape') HistoryManager.closeHistoryPanel();
  },

  renderHistoryPanelList() {
    const sessions = [...this.state.historyState.sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (sessions.length === 0) {
      this.app.dom.historyPanelList.innerHTML = '<div class="history-panel-empty">暂无练习记录<br>开始练习模式后会自动保存进度</div>';
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
      return `
        <div class="history-card${isActive ? ' active' : ''}" data-session-id="${session.id}" role="button" tabindex="0">
          <div class="history-card-main">
            <span class="history-card-title">${this.escapeHtml(title)}</span>
            <span class="history-card-meta">${meta}</span>
          </div>
          <span class="history-card-badge ${isComplete ? 'done' : 'in-progress'}">${isComplete ? '已完成' : '进行中'}</span>
          <div class="history-card-actions">
            <button class="history-rename-btn" data-session-id="${session.id}" title="重命名" aria-label="重命名记录">${iconEdit}</button>
            <button class="history-delete-btn" data-session-id="${session.id}" title="删除" aria-label="删除记录">${iconDelete}</button>
          </div>
        </div>`;
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

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
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
