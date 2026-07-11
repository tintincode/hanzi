// js/app.js
import { ALL_CHARS } from './data.js';
import { SpeechManager } from './speech.js';
import { HistoryManager } from './history.js';
import { SearchManager } from './search.js';
import { Templates } from './templates.js';

const HanziApp = {
  constants: {
    LEVEL_RANGES: { 1: [1, 3500], 2: [3501, 6500], 3: [6501, 8105] },
    CHUNK_SIZE: 200
  },
  
  state: {
    currentFilter: 'all',
    currentSearch: '',
    visibleChars: [],
    renderedCount: 0,
    activeModalIdx: -1,
    studyResults: new Map(),
    practiceActiveId: null,
    searchTimer: null,
    completeToastTimer: null,
    hwWriter: null,
    lastMarkAction: null,
    wrongOnly: false,
    isStudyMode: false,
    focusTrapContainer: null,
    focusTrapHandler: null,
    focusTrapReturnEl: null
  },

  init() {
    this.allChars = ALL_CHARS; // Start with fast offline mock data
    this.charMap = new Map(this.allChars.map(c => [c.c, c]));
    SpeechManager.init(this.allChars);
    HistoryManager.init(this);
    SearchManager.init(this.allChars);
    this.cacheDOM();
    this.bindEvents();
    this.setupInfiniteScroll();
    
    // The full 8,105-character dataset ships offline in data.js, so no
    // network fetch is needed here.
    HistoryManager.syncActiveSession();
    this.renderGrid(true);
    this.updateHeaderOffset();
  },


  cacheDOM() {
    this.dom = {
      gridContainer: document.getElementById('grid-container'),
      search: document.getElementById('search'),
      stats: document.getElementById('stats'),
      filterLevelGroup: document.getElementById('filter-level-group'),
      btnNormal: document.getElementById('btn-normal'),
      btnStudy: document.getElementById('btn-study'),
      btnLarge: document.getElementById('btn-large'),
      btnCompact: document.getElementById('btn-compact'),
      helpBtn: document.getElementById('help-btn'),
      helpModal: document.getElementById('help-modal'),
      helpCloseBtn: document.getElementById('help-close-btn'),
      practiceProgressFill: document.getElementById('practice-progress-fill'),
      practiceProgressCount: document.getElementById('practice-progress-count'),
      scoreCorrect: document.getElementById('score-correct'),
      scoreWrong: document.getElementById('score-wrong'),
      scoreAccuracy: document.getElementById('score-accuracy'),
      wrongFilterBtn: document.getElementById('wrong-filter-btn'),
      wrongFilterCount: document.getElementById('wrong-filter-count'),
      historyToggleBtn: document.getElementById('history-toggle-btn'),
      historyCount: document.getElementById('history-count'),
      historyPanel: document.getElementById('history-panel'),
      historyPanelList: document.getElementById('history-panel-list'),
      historyPanelClose: document.getElementById('history-panel-close'),
      scoreResetBtn: document.getElementById('score-reset-btn'),
      practiceCompleteToast: document.getElementById('practice-complete-toast'),
      siteTitleBtn: document.getElementById('site-title-btn'),
      scrollSentinel: document.getElementById('scroll-sentinel'),
      modal: document.getElementById('modal'),
      fcNum: document.getElementById('fc-num'),
      fcChar: document.getElementById('fc-char'),
      fcPinyin: document.getElementById('fc-pinyin'),
      fcCloseBtn: document.getElementById('fc-close-btn'),
      fcReplayBtn: document.getElementById('fc-replay-btn'),
      fcSpeakBtn: document.getElementById('fc-speak-btn'),
      fcPrevBtn: document.getElementById('fc-prev-btn'),
      fcNextBtn: document.getElementById('fc-next-btn'),
      fcPrimaryCloseBtn: document.getElementById('fc-primary-close-btn')
    };
  },

  bindEvents() {
    this.dom.search.addEventListener('input', (e) => {
      clearTimeout(this.state.searchTimer);
      this.state.searchTimer = setTimeout(() => {
        this.state.currentSearch = e.target.value.trim();
        this.state.practiceActiveId = null;
        this.renderGrid(true);
        if (this.state.isStudyMode) HistoryManager.scheduleHistorySave();
      }, 200);
    });

    this.dom.filterLevelGroup.addEventListener('click', (e) => {
      const btn = e.target.closest('.filter-btn');
      if (!btn) return;
      
      document.querySelectorAll('.filter-btn[data-level]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      if (this.state.isStudyMode) {
        HistoryManager.discardEmptyActiveSession();
      }

      this.state.currentFilter = btn.dataset.level;
      this.state.practiceActiveId = null;

      if (this.state.isStudyMode) {
        const session = HistoryManager.getLatestSessionForLevel(this.state.currentFilter) || HistoryManager.createPracticeSession(this.state.currentFilter);
        HistoryManager.activateSession(session);
      }
      this.renderGrid(true);
    });

    this.dom.gridContainer.addEventListener('click', (e) => {
      const markBtn = e.target.closest('.card-result-btns button');
      const glyph = e.target.closest('.char-glyph');
      const card = e.target.closest('.char-card');

      if (!card) return;

      const cardId = parseInt(card.dataset.id, 10);

      if (markBtn) {
        e.stopPropagation();
        HistoryManager.ensurePracticeSession();
        this.setPracticeActive(cardId);
        const resultType = markBtn.classList.contains('btn-correct') ? 'correct' : 'wrong';
        this.applyCardResult(card, resultType);
        return;
      }

      if (glyph) {
        e.stopPropagation();
        if (this.state.isStudyMode) {
          this.setPracticeActive(cardId);
          if (!card.classList.contains('correct') && !card.classList.contains('wrong')) {
            card.classList.add('revealed');
          }
        } else {
          this.speakChar(e, glyph.textContent);
        }
        return;
      }

      if (this.state.isStudyMode) {
        this.setPracticeActive(cardId);
        if (!card.classList.contains('correct') && !card.classList.contains('wrong')) {
          card.classList.add('revealed');
        }
      } else {
        this.state.activeModalIdx = this.state.visibleChars.findIndex(c => c.i === cardId);
        this.showModal(this.state.activeModalIdx);
      }
    });

    this.dom.btnNormal.addEventListener('click', () => this.setStudy(false));
    this.dom.btnStudy.addEventListener('click', () => this.setStudy(true));
    this.dom.btnLarge.addEventListener('click', () => this.setCompact(false));
    this.dom.btnCompact.addEventListener('click', () => this.setCompact(true));

    this.dom.helpBtn.addEventListener('click', () => this.openHelp());
    this.dom.helpCloseBtn.addEventListener('click', () => this.closeHelp());
    this.dom.helpModal.addEventListener('click', (e) => {
      if (e.target === this.dom.helpModal) this.closeHelp();
    });

    this.dom.wrongFilterBtn.addEventListener('click', () => this.toggleWrongOnly());
    this.dom.historyToggleBtn.addEventListener('click', () => HistoryManager.openHistoryPanel());
    this.dom.historyPanelClose.addEventListener('click', () => HistoryManager.closeHistoryPanel());
    this.dom.historyPanel.addEventListener('click', (e) => { if (e.target === this.dom.historyPanel) HistoryManager.closeHistoryPanel(); });
    this.dom.scoreResetBtn.addEventListener('click', () => HistoryManager.startNewPracticeSession());
    this.dom.siteTitleBtn.addEventListener('click', () => this.goHome());

    this.dom.fcCloseBtn.addEventListener('click', () => this.closeModal());
    this.dom.fcPrimaryCloseBtn.addEventListener('click', () => this.closeModal());
    this.dom.fcReplayBtn.addEventListener('click', () => this.replayStrokes());
    this.dom.fcSpeakBtn.addEventListener('click', () => this.speakModalChar());
    this.dom.fcPrevBtn.addEventListener('click', () => this.navCard(-1));
    this.dom.fcNextBtn.addEventListener('click', () => this.navCard(1));
    this.dom.modal.addEventListener('click', (e) => {
      if (e.target === this.dom.modal) this.closeModal();
    });

    document.addEventListener('keydown', (e) => this.handleGlobalKeys(e));
    window.addEventListener('resize', () => this.updateHeaderOffset());
    window.addEventListener('beforeunload', () => HistoryManager.saveActiveSession(true));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') HistoryManager.saveActiveSession(true);
    });
  },

  setupInfiniteScroll() {
    this.observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) {
        this.renderNextChunk();
      }
    }, { rootMargin: '200px' });
    this.observer.observe(this.dom.scrollSentinel);
  },

  getFiltered() {
    return SearchManager.filter(
      this.state.currentSearch,
      this.state.currentFilter,
      this.constants.LEVEL_RANGES,
      this.state.wrongOnly,
      this.state.studyResults
    );
  },

  renderGrid(resetScroll = false) {
    this.state.visibleChars = this.getFiltered();
    this.dom.stats.textContent = `显示 ${this.state.visibleChars.length.toLocaleString()} 字`;
    this.state.renderedCount = 0;

    if (resetScroll) {
      window.scrollTo({ top: 0 });
    }

    if (this.state.visibleChars.length === 0) {
      this.dom.gridContainer.innerHTML = Templates.emptyGrid();
      this.state.practiceActiveId = null;
      this.updateScore();
      return;
    }

    this.dom.gridContainer.innerHTML = '';
    this.renderNextChunk();
    this.syncPracticeSelection();
    this.updateScore();
  },

  renderNextChunk() {
    const total = this.state.visibleChars.length;
    if (this.state.renderedCount >= total) return;

    const end = Math.min(this.state.renderedCount + this.constants.CHUNK_SIZE, total);
    const chunk = this.state.visibleChars.slice(this.state.renderedCount, end);

    const isGroupedLayout = !this.state.currentSearch;

    if (isGroupedLayout) {
      // Split the chunk into consecutive same-level runs first (usually just
      // one run, occasionally two when a chunk straddles a level boundary),
      // then do exactly one HTML-string build + one DOM insert per run —
      // instead of one insertAdjacentHTML call per character.
      const runs = [];
      chunk.forEach(c => {
        let levelKey = '1';
        if (c.i > 3500 && c.i <= 6500) levelKey = '2';
        else if (c.i > 6500) levelKey = '3';

        const lastRun = runs[runs.length - 1];
        if (lastRun && lastRun.levelKey === levelKey) {
          lastRun.chars.push(c);
        } else {
          runs.push({ levelKey, chars: [c] });
        }
      });

      const docFragment = document.createDocumentFragment();

      runs.forEach(run => {
          // Check DOM directly to avoid duplicating group heading zones
        let targetGrid = docFragment.getElementById(`grid-sec-${run.levelKey}`)
          || this.dom.gridContainer.querySelector(`#grid-sec-${run.levelKey}`);

        if (!targetGrid) {
            const sectionDiv = document.createElement('div');
            sectionDiv.className = 'section-label';
          sectionDiv.innerHTML = Templates.sectionLabel(run.levelKey);
            docFragment.appendChild(sectionDiv);

          targetGrid = document.createElement('div');
          targetGrid.className = 'char-grid';
          targetGrid.id = `grid-sec-${run.levelKey}`;
          docFragment.appendChild(targetGrid);
          }
          
        const html = run.chars.map(c => this.cardHTML(c)).join('');
        targetGrid.insertAdjacentHTML('beforeend', html);
      });

      this.dom.gridContainer.appendChild(docFragment);
    } else {
      let mainGrid = this.dom.gridContainer.querySelector('.char-grid');
      if (!mainGrid) {
        mainGrid = document.createElement('div');
        mainGrid.className = 'char-grid';
        this.dom.gridContainer.appendChild(mainGrid);
      }
      const html = chunk.map(c => this.cardHTML(c)).join('');
      mainGrid.insertAdjacentHTML('beforeend', html);
    }

    this.state.renderedCount = end;
    this.applyPracticeActive();
  },

  cardHTML(c) {
    const studyResult = this.state.studyResults.get(c.i);
    const isActive = c.i === this.state.practiceActiveId;
    return Templates.card(c, studyResult, this.state.isStudyMode, isActive);
  },

  applyCardResult(card, result) {
    const id = parseInt(card.dataset.id, 10);
    const current = this.state.studyResults.get(id);

    this.state.lastMarkAction = { id, prevResult: current };

    card.classList.remove('revealed');
    card.classList.remove('correct', 'wrong');

    if (current === result) {
      this.state.studyResults.delete(id);
    } else {
      this.state.studyResults.set(id, result);
      card.classList.add(result);
    }
    this.updateScore();
    HistoryManager.state.historyDirty = true;
    HistoryManager.scheduleHistorySave();

    if (this.state.wrongOnly && this.state.studyResults.get(id) !== 'wrong') {
      // The card just regraded away from "wrong" — drop it from the
      // wrong-only review list instead of leaving it dangling in view.
      this.renderGrid();
    }
  },

  undoLastMark() {
    if (!this.state.lastMarkAction) return false;
    const { id, prevResult } = this.state.lastMarkAction;

    if (prevResult) {
      this.state.studyResults.set(id, prevResult);
    } else {
      this.state.studyResults.delete(id);
    }

    if (this.state.wrongOnly) {
      // Re-render first so the restored card actually exists in the
      // filtered (wrong-only) DOM before we try to focus/scroll to it.
      this.renderGrid();
    } else {
      const card = document.querySelector(`.char-card[data-id="${id}"]`);
      if (card) {
        card.classList.remove('correct', 'wrong', 'revealed');
        if (prevResult) card.classList.add(prevResult);
      }
    }

    const activeCard = this.ensureCardRendered(id);
    this.setPracticeActive(id);
    if (activeCard) activeCard.scrollIntoView({ block: 'center', behavior: 'smooth' });

    this.updateScore();
    HistoryManager.state.historyDirty = true;
    HistoryManager.scheduleHistorySave();
    this.state.lastMarkAction = null;
    return true;
  },

  updateScore() {
    let correct = 0;
    let wrong = 0;
    for (const result of this.state.studyResults.values()) {
      if (result === 'correct') correct++;
      if (result === 'wrong') wrong++;
    }
    this.dom.scoreCorrect.textContent = String(correct);
    this.dom.scoreWrong.textContent = String(wrong);
    this.dom.wrongFilterCount.textContent = String(wrong);
    this.dom.wrongFilterBtn.disabled = wrong === 0 && !this.state.wrongOnly;

    const graded = correct + wrong;
    this.dom.scoreAccuracy.textContent = graded > 0 ? `准确率 ${Math.round((correct / graded) * 100)}%` : '';

    const total = this.state.visibleChars.length;
    const markedInView = total ? this.state.visibleChars.filter(c => this.state.studyResults.has(c.i)).length : 0;
    const pct = total ? Math.round((markedInView / total) * 100) : 0;
    this.dom.practiceProgressFill.style.width = `${pct}%`;
    this.dom.practiceProgressCount.textContent = `${markedInView} / ${total}`;

    // The wrong-only view always has markedInView === total (every visible
    // card is already graded "wrong"), so the completion toast would fire
    // spuriously while just reviewing mistakes — only show it for the full set.
    if (this.state.isStudyMode && !this.state.wrongOnly && total > 0 && markedInView === total) {
      this.showPracticeCompleteToast();
    }
  },

  showPracticeCompleteToast() {
    this.dom.practiceCompleteToast.classList.add('show');
    clearTimeout(this.state.completeToastTimer);
    this.state.completeToastTimer = setTimeout(() => this.dom.practiceCompleteToast.classList.remove('show'), 2600);
  },

  syncPracticeSelection() {
    if (!this.state.isStudyMode) return;
    if (!this.state.visibleChars.some(c => c.i === this.state.practiceActiveId)) {
      this.state.practiceActiveId = this.getNextUnmarkedId(0) || (this.state.visibleChars[0] && this.state.visibleChars[0].i) || null;
    }
    this.applyPracticeActive();
  },

  setPracticeActive(id) {
    this.state.practiceActiveId = id;
    this.applyPracticeActive();
    if (this.state.isStudyMode) HistoryManager.scheduleHistorySave();
  },

  applyPracticeActive() {
    document.querySelectorAll('.char-card.active').forEach(el => el.classList.remove('active'));
    if (!this.state.practiceActiveId) return;
    const card = this.getPracticeActiveCard();
    if (card) card.classList.add('active');
  },

  getPracticeActiveCard() {
    if (!this.state.practiceActiveId) return null;
    return document.querySelector(`.char-card[data-id="${this.state.practiceActiveId}"]`);
  },

  getNextUnmarkedId(startIdx) {
    for (let offset = 0; offset < this.state.visibleChars.length; offset++) {
      const idx = (startIdx + offset) % this.state.visibleChars.length;
      const candidate = this.state.visibleChars[idx];
      if (candidate && !this.state.studyResults.has(candidate.i)) return candidate.i;
    }
    return null;
  },

  ensureCardRendered(id) {
    if (!id) return null;
    const idx = this.state.visibleChars.findIndex(c => c.i === id);
    if (idx === -1) return null;
    // The grid renders in chunks as you scroll (infinite scroll), so the
    // target card may not exist in the DOM yet — render forward until it does.
    while (this.state.renderedCount <= idx && this.state.renderedCount < this.state.visibleChars.length) {
      this.renderNextChunk();
    }
    return document.querySelector(`.char-card[data-id="${id}"]`);
  },

  scrollToPracticeCard(id) {
    const card = this.ensureCardRendered(id);
    if (!card) return;
    // The card may have just been lazily rendered for the first time, after
    // applyPracticeActive() already ran and found nothing to highlight —
    // make sure the highlight actually lands on it now that it exists.
    if (id === this.state.practiceActiveId) {
      document.querySelectorAll('.char-card.active').forEach(el => el.classList.remove('active'));
      card.classList.add('active');
    }
    requestAnimationFrame(() => card.scrollIntoView({ block: 'center' }));
  },

  advancePracticeCard() {
    if (!this.state.visibleChars.length || !this.state.practiceActiveId) return;
    const currentIdx = this.state.visibleChars.findIndex(c => c.i === this.state.practiceActiveId);
    const nextId = this.getNextUnmarkedId(currentIdx + 1);
    if (!nextId) return;
    const card = this.ensureCardRendered(nextId);
    this.setPracticeActive(nextId);
    if (card) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  },

  updateFilterButtons() {
    document.querySelectorAll('.filter-btn[data-level]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.level === this.state.currentFilter);
    });
  },

  // --- Accessibility: focus trap for modals ---
  // Keeps Tab / Shift+Tab cycling within `container` while a modal is open,
  // and remembers what was focused beforehand so closeFocusTrap() can put
  // focus back where the user was. `container` must already be visible
  // (i.e. its 'open' class already applied) when this is called, since it
  // needs to query for actually-focusable elements inside it.
  FOCUSABLE_SELECTOR: 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',

  getFocusableIn(container) {
    return Array.from(container.querySelectorAll(this.FOCUSABLE_SELECTOR))
      .filter(el => el.offsetParent !== null);
  },

  openFocusTrap(container, preferredFocusEl) {
    this.state.focusTrapReturnEl = document.activeElement;
    this.state.focusTrapContainer = container;

    const toFocus = preferredFocusEl || this.getFocusableIn(container)[0];
    if (toFocus) toFocus.focus();

    this.state.focusTrapHandler = (e) => {
      if (e.key !== 'Tab') return;
      const items = this.getFocusableIn(container);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !container.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !container.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };
    container.addEventListener('keydown', this.state.focusTrapHandler);
  },

  closeFocusTrap() {
    const { focusTrapContainer, focusTrapHandler, focusTrapReturnEl } = this.state;
    if (focusTrapContainer && focusTrapHandler) {
      focusTrapContainer.removeEventListener('keydown', focusTrapHandler);
    }
    this.state.focusTrapContainer = null;
    this.state.focusTrapHandler = null;
    this.state.focusTrapReturnEl = null;
    if (focusTrapReturnEl && document.body.contains(focusTrapReturnEl)) {
      focusTrapReturnEl.focus();
    }
  },

  openMiniModal({ title, text, withInput, inputValue, confirmLabel, danger, onConfirm }) {
    const backdrop = document.getElementById('mini-modal');
    const titleEl = document.getElementById('mini-modal-title');
    const textEl = document.getElementById('mini-modal-text');
    const inputEl = document.getElementById('mini-modal-input');
    const confirmBtn = document.getElementById('mini-modal-confirm');
    const cancelBtn = document.getElementById('mini-modal-cancel');

    titleEl.textContent = title || '';
    textEl.textContent = text || '';
    textEl.style.display = text ? '' : 'none';

    if (withInput) {
      inputEl.style.display = '';
      inputEl.value = inputValue || '';
    } else {
      inputEl.style.display = 'none';
    }

    confirmBtn.textContent = confirmLabel || '确定';
    confirmBtn.className = danger ? 'mini-btn-danger' : 'mini-btn-primary';

    const cleanup = () => {
      backdrop.classList.remove('open');
      confirmBtn.removeEventListener('click', handleConfirm);
      cancelBtn.removeEventListener('click', handleCancel);
      backdrop.removeEventListener('click', handleBackdropClick);
      document.removeEventListener('keydown', handleKeydown);
      this.closeFocusTrap();
    };
    function handleConfirm() {
      const value = withInput ? inputEl.value.trim() : true;
      cleanup();
      if (withInput && !value) return;
      onConfirm(value);
    }
    function handleCancel() { cleanup(); }
    function handleBackdropClick(e) { if (e.target === backdrop) cleanup(); }
    function handleKeydown(e) {
      if (e.key === 'Escape') cleanup();
      if (e.key === 'Enter' && withInput) handleConfirm();
    }

    confirmBtn.addEventListener('click', handleConfirm);
    cancelBtn.addEventListener('click', handleCancel);
    backdrop.addEventListener('click', handleBackdropClick);
    document.addEventListener('keydown', handleKeydown);

    backdrop.classList.add('open');
    this.openFocusTrap(backdrop, withInput ? inputEl : confirmBtn);
    if (withInput) inputEl.select();
  },

  showModal(idx) {
    if (idx < 0 || idx >= this.state.visibleChars.length) return;
    const wasOpen = this.dom.modal.classList.contains('open');
    this.state.activeModalIdx = idx;
    const c = this.state.visibleChars[idx];
    this.dom.fcNum.textContent = `#${c.i} / 8105`;
    this.dom.fcChar.textContent = c.c;
    this.dom.fcPinyin.textContent = c.p.join(' / ') || '—';
    this.dom.modal.classList.add('open');

    this.initStrokes(c.c);

    document.querySelectorAll('.char-card.active').forEach(el => el.classList.remove('active'));
    const activeEl = this.ensureCardRendered(c.i);
    if (activeEl) { activeEl.classList.add('active'); activeEl.scrollIntoView({ block: 'center', behavior: 'smooth' }); }

    if (!wasOpen) this.openFocusTrap(this.dom.modal, this.dom.fcCloseBtn);
  },

  initStrokes(char) {
    const container = document.getElementById('stroke-container');
    container.innerHTML = '<div class="stroke-loading">加载笔顺…</div>';
    this.state.hwWriter = null;

    try {
      this.state.hwWriter = HanziWriter.create('stroke-container', char, {
        width: 180,
        height: 180,
        padding: 12,
        showOutline: true,
        strokeColor: '#1a1714',
        outlineColor: 'rgba(26,23,20,0.12)',
        drawingColor: '#0f6e56',
        animationSpeed: 0.8,
        delayBetweenStrokes: 150,
        onLoadCharDataSuccess: () => {
          const loading = container.querySelector('.stroke-loading');
          if (loading) loading.remove();
          this.state.hwWriter.animateCharacter();
        },
        onLoadCharDataError: () => {
          container.innerHTML = '<div class="stroke-loading" style="color:var(--ink3);font-size:0.72rem;padding:1rem;text-align:center;">暂无笔顺数据</div>';
        }
      });
    } catch(e) {
      container.innerHTML = '<div class="stroke-loading" style="color:var(--ink3);">暂无数据</div>';
    }
  },

  replayStrokes() {
    if (this.state.hwWriter) this.state.hwWriter.animateCharacter();
  },

  closeModal() {
    if (!this.dom.modal.classList.contains('open')) return;
    this.dom.modal.classList.remove('open');
    document.querySelectorAll('.char-card.active').forEach(el => el.classList.remove('active'));
    this.state.hwWriter = null;
    document.getElementById('stroke-container').innerHTML = '<div class="stroke-loading">加载中…</div>';
    this.closeFocusTrap();
  },

  navCard(dir) {
    this.showModal(this.state.activeModalIdx + dir);
  },

  setStudy(on) {
    document.body.classList.toggle('study-mode', on);
    this.state.isStudyMode = on;
    this.dom.btnNormal.classList.toggle('active', !on);
    this.dom.btnStudy.classList.toggle('active', on);
    HistoryManager.state.historyState.practiceMode = on;
    if (!on) {
      HistoryManager.saveActiveSession(true);
      this.state.practiceActiveId = null;
      this.state.studyResults.clear();
      this.clearCardStates();
    } else {
      HistoryManager.ensurePracticeSession();
      this.renderGrid(false);
      HistoryManager.saveActiveSession(true);
      this.scrollToPracticeCard(this.state.practiceActiveId);
    }
    HistoryManager.saveHistoryState();
    this.updateHeaderOffset();
  },

  setCompact(on) {
    document.body.classList.toggle('compact', on);
    this.dom.btnLarge.classList.toggle('active', !on);
    this.dom.btnCompact.classList.toggle('active', on);
    this.updateHeaderOffset();
  },

  toggleWrongOnly() {
    this.state.wrongOnly = !this.state.wrongOnly;
    this.dom.wrongFilterBtn.setAttribute('aria-pressed', String(this.state.wrongOnly));
    this.renderGrid(true);
    if (this.state.wrongOnly) {
      this.scrollToPracticeCard(this.state.practiceActiveId);
    }
  },

  clearCardStates() {
    this.dom.scoreCorrect.textContent = '0';
    this.dom.scoreWrong.textContent = '0';
    this.dom.scoreAccuracy.textContent = '';
    this.dom.practiceProgressFill.style.width = '0%';
    this.dom.practiceProgressCount.textContent = '0 / 0';
    this.dom.practiceCompleteToast.classList.remove('show');
    document.querySelectorAll('.char-card').forEach(c => {
      c.classList.remove('correct', 'wrong', 'revealed', 'active');
    });
  },

  updateHeaderOffset() {
    const header = document.querySelector('header');
    if (!header) return;
    document.documentElement.style.setProperty('--header-offset', `${header.offsetHeight}px`);
  },

  goHome() {
    HistoryManager.saveActiveSession(true);
    this.setStudy(false);
    this.setCompact(false);
    this.dom.search.value = '';
    this.state.currentSearch = '';

    document.querySelectorAll('.filter-btn[data-level]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.level === 'all');
    });
    this.state.currentFilter = 'all';
    this.renderGrid(true);
  },

  handleGlobalKeys(e) {
    if (e.key === 'Escape') { this.closeHelp(); this.closeModal(); return; }
    if (this.handlePracticeKey(e)) return;
    if (!this.dom.modal.classList.contains('open')) return;
    if (e.key === 'ArrowRight') this.navCard(1);
    if (e.key === 'ArrowLeft') this.navCard(-1);
  },

  handlePracticeKey(e) {
    if (!this.state.isStudyMode) return false;
    if (this.dom.modal.classList.contains('open')) return false;
    if (this.dom.helpModal.classList.contains('open')) return false;
    if (document.getElementById('mini-modal').classList.contains('open')) return false;
    if (this.dom.historyPanel.classList.contains('open')) return false;
    
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'SELECT' || e.target.isContentEditable) return false;

    const key = e.key.toLowerCase();
    const revealKey = e.key === ' ' || e.key === 'Spacebar' || e.key === 'Enter';
    const gradeKey = key === 'j' || key === 'k';
    const undoKey = key === 'u' || (e.ctrlKey && key === 'z');
    if (!revealKey && !gradeKey && !undoKey && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return false;

    e.preventDefault();

    if (undoKey) {
      this.undoLastMark();
      return true;
    }

    this.syncPracticeSelection();
    const card = this.getPracticeActiveCard();
    if (!card) return true;

    if (revealKey) {
      card.classList.add('revealed');
      card.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return true;
    }

    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      this.movePracticeSelection(e.key === 'ArrowRight' ? 1 : -1);
      return true;
    }

    if (!card.classList.contains('revealed') && !card.classList.contains('correct') && !card.classList.contains('wrong')) {
      card.classList.add('revealed');
      return true;
    }

    this.applyCardResult(card, key === 'j' ? 'correct' : 'wrong');
    this.advancePracticeCard();
    HistoryManager.saveActiveSession(true);
    return true;
  },

  movePracticeSelection(dir) {
    if (!this.state.visibleChars.length) return;
    const currentIdx = Math.max(0, this.state.visibleChars.findIndex(c => c.i === this.state.practiceActiveId));
    const nextIdx = (currentIdx + dir + this.state.visibleChars.length) % this.state.visibleChars.length;
    const nextId = this.state.visibleChars[nextIdx].i;
    const card = this.ensureCardRendered(nextId);
    this.setPracticeActive(nextId);
    if (card) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  },

  getPinyinsForChar(char) {
    const entry = this.charMap.get(char);
    return entry ? entry.p : [];
  },

  speakChar(event, char) {
    event.stopPropagation();
    const card = event.target.closest('.char-card');
    const pinyins = this.getPinyinsForChar(char);
    if (card) {
      card.classList.add('speaking');
      SpeechManager.speak(char, pinyins).then(() => card.classList.remove('speaking'));
      setTimeout(() => card.classList.remove('speaking'), 5000);
    } else {
      SpeechManager.speak(char, pinyins);
    }
  },

  speakModalChar() {
    const char = this.dom.fcChar.textContent;
    const pinyins = this.getPinyinsForChar(char);
    this.dom.fcSpeakBtn.classList.add('speaking');
    SpeechManager.speak(char, pinyins).then(() => this.dom.fcSpeakBtn.classList.remove('speaking'));
    setTimeout(() => this.dom.fcSpeakBtn.classList.remove('speaking'), 5000);
  },

  openHelp() {
    this.dom.helpModal.classList.add('open');
    this.openFocusTrap(this.dom.helpModal, this.dom.helpCloseBtn);
  },
  closeHelp() {
    if (!this.dom.helpModal.classList.contains('open')) return;
    this.dom.helpModal.classList.remove('open');
    this.closeFocusTrap();
  }
};


// Start application
document.addEventListener('DOMContentLoaded', () => HanziApp.init());
