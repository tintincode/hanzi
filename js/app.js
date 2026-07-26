// js/app.js
import { ALL_CHARS } from './data.js';
import { SpeechManager } from './speech.js';
import { HistoryManager } from './history.js';
import { SearchManager } from './search.js';
import { Templates } from './templates.js';
import { BookmarkManager } from './bookmarks.js';
import { ThemeManager } from './theme.js';

const HanziApp = {
  constants: {
    LEVEL_RANGES: { 1: [1, 3500], 2: [3501, 6500], 3: [6501, 8105] },
    CHUNK_SIZE: 200,
    // Fixed size for 练习模式's chunk picker (see openChunkPicker/selectChunk
    // below) — independent of CHUNK_SIZE above, which is an unrelated
    // rendering-batch size for infinite scroll. A level's total character
    // count (3500/3000/1605/8105) is too large to hand someone in one
    // session; this splits it into fixed 100-character groups instead.
    PRACTICE_GROUP_SIZE: 100
  },
  
  state: {
    currentFilter: 'all',
    currentSearch: '',
    visibleChars: [],
    renderedCount: 0,
    activeModalIdx: -1,
    studyResults: new Map(),
    practiceActiveId: null,
    // null = no chunk restriction (either not in 练习模式, or an
    // old-style whole-level session) — a number narrows getFiltered() to
    // that one PRACTICE_GROUP_SIZE-sized slice of the current level. Only
    // ever meaningful while isStudyMode is true — see
    // getPracticeChunkRange()'s guard below.
    practiceChunkIndex: null,
    searchTimer: null,
    completeToastTimer: null,
    hwWriter: null,
    // Stack of {id, prevResult} — replaces the old single-slot
    // lastMarkAction. Every mark pushes an entry; undo pops the most
    // recent one, so repeated undo (button clicks or U/Ctrl+Z) walks
    // back through the whole session's marks, not just the last one.
    markHistory: [],
    wrongOnly: false,
    bookmarkOnly: false,
    isStudyMode: false,
    focusTrapContainer: null,
    focusTrapHandler: null,
    focusTrapReturnEl: null
  },

  init() {
    this.allChars = ALL_CHARS; // Start with fast offline mock data
    this.charMap = new Map(this.allChars.map(c => [c.c, c]));
    // Maps character id -> its rendered .char-card element, kept in sync
    // by renderNextChunk() (populated) and renderGrid() (cleared on every
    // full re-render). Lets id-based lookups (ensureCardRendered,
    // getPracticeActiveCard, undoLastMark, toggleBookmark) be an O(1) Map
    // read instead of a `document.querySelector('[data-id="..."]')` scan
    // — the latter is fine for one-off lookups, but adds up during a fast
    // J/K grading session, especially in the "全部" (8,105-char) view.
    this.cardEls = new Map();
    SpeechManager.init(this.allChars);
    HistoryManager.init(this);
    SearchManager.init(this.allChars);
    BookmarkManager.init();
    this.cacheDOM();
    ThemeManager.init(this);
    this.bindEvents();
    this.setupInfiniteScroll();
    this.updateBookmarkFilterUI();
    
    // The full 8,105-character dataset ships offline in data.js, so no
    // network fetch is needed here.
    const resumedStudyMode = HistoryManager.syncActiveSession();
    if (!resumedStudyMode) this.renderGrid(true);
    this.updateHeaderOffset();
    this.updateReadingProgress();
  },


  cacheDOM() {
    this.dom = {
      gridContainer: document.getElementById('grid-container'),
      search: document.getElementById('search'),
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
      readingProgressCount: document.getElementById('reading-progress-count'),
      backToTopBtn: document.getElementById('back-to-top-btn'),
      themeToggleBtn: document.getElementById('theme-toggle-btn'),
      scoreCorrect: document.getElementById('score-correct'),
      scoreWrong: document.getElementById('score-wrong'),
      scoreAccuracy: document.getElementById('score-accuracy'),
      wrongFilterBtn: document.getElementById('wrong-filter-btn'),
      wrongFilterCount: document.getElementById('wrong-filter-count'),
      bookmarkFilterBtn: document.getElementById('bookmark-filter-btn'),
      bookmarkFilterCount: document.getElementById('bookmark-filter-count'),
      bookmarkClearBtn: document.getElementById('bookmark-clear-btn'),
      historyToggleBtn: document.getElementById('history-toggle-btn'),
      historyCount: document.getElementById('history-count'),
      historyPanel: document.getElementById('history-panel'),
      historyPanelList: document.getElementById('history-panel-list'),
      historyPanelClose: document.getElementById('history-panel-close'),
      historyExportBtn: document.getElementById('history-export-btn'),
      historyImportBtn: document.getElementById('history-import-btn'),
      historyImportInput: document.getElementById('history-import-input'),
      scoreResetBtn: document.getElementById('score-reset-btn'),
      practiceCompleteToast: document.getElementById('practice-complete-toast'),
      undoBarBtn: document.getElementById('undo-bar-btn'),
      undoBarCount: document.getElementById('undo-bar-count'),
      siteTitleBtn: document.getElementById('site-title-btn'),
      scrollSentinel: document.getElementById('scroll-sentinel'),
      modal: document.getElementById('modal'),
      fcNum: document.getElementById('fc-num'),
      fcChar: document.getElementById('fc-char'),
      fcPinyin: document.getElementById('fc-pinyin'),
      fcCloseBtn: document.getElementById('fc-close-btn'),
      fcBookmarkBtn: document.getElementById('fc-bookmark-btn'),
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

      // Level selection is 阅读模式-only (the selector lives in
      // .reading-bar, hidden during 练习模式 — see index.html) — this
      // handler can only ever fire while browsing, so it's just a plain
      // grid re-render, with none of the practice-session bookkeeping
      // this used to need back when the same buttons also drove which
      // level's chunk picker to show.
      this.state.currentFilter = btn.dataset.level;
        this.renderGrid(true);
    });

    this.dom.gridContainer.addEventListener('click', (e) => {
      const chunkCell = e.target.closest('.chunk-cell');
      if (chunkCell) {
        this.selectChunk(chunkCell.dataset.level, chunkCell.dataset.chunk);
        return;
      }

      const bookmarkBtn = e.target.closest('.bookmark-btn');
      const markBtn = e.target.closest('.card-result-btns button');
      const glyph = e.target.closest('.char-glyph');
      const card = e.target.closest('.char-card');

      if (!card) return;

      const cardId = parseInt(card.dataset.id, 10);

      if (bookmarkBtn) {
        e.stopPropagation();
        this.toggleBookmark(parseInt(bookmarkBtn.dataset.bookmarkId, 10));
        return;
      }

      if (markBtn) {
        e.stopPropagation();
        HistoryManager.ensurePracticeSession();
        this.setPracticeActive(cardId);
        const resultType = markBtn.classList.contains('btn-correct') ? 'correct' : 'wrong';
        this.gradeCard(card, resultType);
        // Targeted blur — not the old blanket click-blur hack (which broke
        // Tab navigation everywhere and was removed for that reason). This
        // one only fires for the mark buttons specifically, because
        // leaving focus parked here silently blocks the very next J/K/
        // Space/arrow keypress (handlePracticeKey ignores keydowns whose
        // target is a <button>) — without this, using the mouse once
        // breaks keyboard shortcuts until the user clicks elsewhere.
        markBtn.blur();
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
    if (this.dom.bookmarkFilterBtn) {
      this.dom.bookmarkFilterBtn.addEventListener('click', () => this.toggleBookmarkOnly());
    }
    if (this.dom.bookmarkClearBtn) {
      this.dom.bookmarkClearBtn.addEventListener('click', () => this.clearAllBookmarks());
    }
    this.dom.historyToggleBtn.addEventListener('click', () => HistoryManager.openHistoryPanel());
    this.dom.historyPanelClose.addEventListener('click', () => HistoryManager.closeHistoryPanel());
    this.dom.historyPanel.addEventListener('click', (e) => { if (e.target === this.dom.historyPanel) HistoryManager.closeHistoryPanel(); });
    this.dom.historyExportBtn.addEventListener('click', () => HistoryManager.exportHistory());
    this.dom.historyImportBtn.addEventListener('click', () => this.dom.historyImportInput.click());
    this.dom.historyImportInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) HistoryManager.importHistoryFromFile(file);
      e.target.value = ''; // allow re-selecting the same file next time
    });
    this.dom.scoreResetBtn.addEventListener('click', () => HistoryManager.startNewPracticeSession());
    this.dom.siteTitleBtn.addEventListener('click', () => this.goHome());

    this.dom.fcCloseBtn.addEventListener('click', () => this.closeModal());
    if (this.dom.fcBookmarkBtn) {
      this.dom.fcBookmarkBtn.addEventListener('click', () => {
        const openChar = this.state.visibleChars[this.state.activeModalIdx];
        if (openChar) this.toggleBookmark(openChar.i);
      });
    }
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

    // Live 阅读进度 counter + back-to-top visibility — one shared rAF-
    // throttled scroll handler so it stays cheap even while flick-scrolling
    // through a long list. Reading progress is mode-gated (阅读模式 only);
    // back-to-top works the same in both modes.
    let scrollTicking = false;
    window.addEventListener('scroll', () => {
      if (scrollTicking) return;
      scrollTicking = true;
      requestAnimationFrame(() => {
        this.updateReadingProgress();
        if (this.dom.backToTopBtn) {
          this.dom.backToTopBtn.classList.toggle('show', window.scrollY > 600);
        }
        scrollTicking = false;
      });
    }, { passive: true });

    if (this.dom.backToTopBtn) {
      this.dom.backToTopBtn.addEventListener('click', () => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }

    if (this.dom.undoBarBtn) {
      this.dom.undoBarBtn.addEventListener('click', () => {
        this.undoLastMark();
        // Same targeted blur as the grading buttons (see markBtn.blur()
        // above) and for the same reason — arguably more important here,
        // since 撤销 is specifically meant to be used mid-flow during a
        // keyboard-driven J/K grading session. Without this, clicking
        // undo once would silently swallow the very next J/K/U/Space/
        // arrow keypress until the user clicked elsewhere first.
        this.dom.undoBarBtn.blur();
      });
    }

    ThemeManager.bindEvents();
  },

  setupInfiniteScroll() {
    this.observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) {
        this.renderNextChunk();
      }
    }, { rootMargin: '200px' });
    this.observer.observe(this.dom.scrollSentinel);
  },

  // [lo, hi] (inclusive, in the same c.i id-space as LEVEL_RANGES) for the
  // currently active practice chunk, or null when no chunk restriction
  // applies. Gated on isStudyMode specifically (not just practiceChunkIndex
  // being non-null) so that leftover chunk state can never leak into
  // 阅读模式's view even if something forgets to clear it on mode switch —
  // same defensive-guard-at-the-read-site pattern already used for
  // bookmarkOnly in getFiltered() below.
  getPracticeChunkRange() {
    if (!this.state.isStudyMode || this.state.practiceChunkIndex == null) return null;
    const level = this.state.currentFilter;
    const base = level === 'all' ? 1 : this.constants.LEVEL_RANGES[level][0];
    const levelTotal = level === 'all'
      ? this.allChars.length
      : (this.constants.LEVEL_RANGES[level][1] - this.constants.LEVEL_RANGES[level][0] + 1);
    const groupSize = this.constants.PRACTICE_GROUP_SIZE;
    const start = base + this.state.practiceChunkIndex * groupSize;
    const end = Math.min(start + groupSize - 1, base + levelTotal - 1);
    return [start, end];
  },

  getFiltered() {
    return SearchManager.filter(
      this.state.currentSearch,
      // currentFilter serves two different purposes depending on mode:
      // in 阅读模式 it's directly set by the level selector (see
      // index.html — it lives in .reading-bar, 练习模式 has no selector
      // of its own); in 练习模式 it's set by activateSession() to
      // whichever session is currently active, so the grid stays scoped
      // to that session's level/chunk regardless of whatever 阅读模式
      // last left it on.
      this.state.currentFilter,
      this.constants.LEVEL_RANGES,
      this.state.wrongOnly,
      this.state.studyResults,
      // Bookmark filtering is 阅读模式-only by design — guarded here
      // (rather than relying on bookmarkOnly always being reset on mode
      // switch) so it can never silently carry into 练习模式's view.
      this.state.bookmarkOnly && !this.state.isStudyMode,
      BookmarkManager.getSet(),
      this.getPracticeChunkRange()
    );
  },

  // A single "practice the whole thing" cell for `level` — 'all' means all
  // 8105 characters as one session (level:'all', chunkIndex:null, same as
  // how 练习模式 worked before chunking existed); a real level means that
  // level's own whole-level session. fullWidth controls whether this cell
  // spans its whole grid row (used when it's the lone whole-cell in a
  // single-level picker) or sits compactly alongside siblings (used in the
  // grouped 全部/整个一级/整个二级/整个三级 row — see openChunkPicker below).
  buildWholeCell(level, fullWidth) {
    const levelTotal = level === 'all'
      ? this.allChars.length
      : (this.constants.LEVEL_RANGES[level][1] - this.constants.LEVEL_RANGES[level][0] + 1);
    const levelName = HistoryManager.levelName(level);
    const session = HistoryManager.getLatestSessionForLevel(level);
    const reviewed = session ? Object.keys(session.results || {}).length : 0;
    const status = reviewed === 0 ? 'not-started' : (reviewed >= levelTotal ? 'done' : 'in-progress');
    return {
      chunkAttr: 'whole',
      level,
      label: level === 'all' ? '全部' : `整个${levelName}`,
      meta: `${reviewed} / ${levelTotal}`,
      status,
      isWhole: fullWidth
    };
  },

  // The numbered 组1…组N cells for a real level ('1'/'2'/'3', never 'all')
  // — no whole-level cell included, since that's built separately by
  // buildWholeCell above (openChunkPicker composes the two as needed).
  buildChunkCells(level) {
    const groupSize = this.constants.PRACTICE_GROUP_SIZE;
    const range = this.constants.LEVEL_RANGES[level];
    const base = range[0];
    const levelTotal = range[1] - range[0] + 1;
    const numChunks = Math.ceil(levelTotal / groupSize);

    const cells = [];
    for (let i = 0; i < numChunks; i++) {
      const start = base + i * groupSize;
      const end = Math.min(start + groupSize - 1, base + levelTotal - 1);
      const chunkSize = end - start + 1;
      const session = HistoryManager.getSessionForLevelChunk(level, i);
      const reviewed = session ? Object.keys(session.results || {}).length : 0;
      const status = reviewed === 0 ? 'not-started' : (reviewed >= chunkSize ? 'done' : 'in-progress');
      // start/end are the same global character index (c.i) printed on
      // every card's .char-num — showing that here (rather than a
      // level-local "1-100" position) means it's directly
      // cross-referenceable with what you actually see in the grid, and
      // avoids every level's own 组1 confusingly showing the same "1-100"
      // range in 全部's fanned-out picker.
      cells.push({
        chunkAttr: String(i),
        level,
        label: `组 ${i + 1}`,
        range: `${start}–${end}`,
        meta: `${reviewed} / ${chunkSize}`,
        status,
        isWhole: false
      });
    }
    return cells;
  },

  // Shows the chunk-selection grid in place of the character grid, instead
  // of jumping straight into a (potentially thousands-long) whole-level
  // practice session. Always shows every level's options — 全部/整个一级/
  // 整个二级/整个三级 in one grouped row, followed by each level's own
  // 组1…组N — since 练习模式 has no level selector of its own anymore
  // (level selection is 阅读模式-only; see index.html/getFiltered()'s
  // comment). Called whenever 练习模式 is entered with no already-active
  // session (see setStudy()) — an explicit resume (app boot, history-panel
  // pick, or just toggling modes with a session still active) bypasses
  // this entirely and goes straight to the grid.
  openChunkPicker() {
    // Safety-net flush/discard for callers that haven't already done this
    // themselves (setStudy, startNewPracticeSession, deleteSession's
    // fallback all reach here without having flushed first). The
    // filterLevelGroup click handler is the one exception — it must flush
    // *before* reassigning currentFilter (saveActiveSession() stamps a
    // flushed session with app.state.currentFilter), so it calls this
    // itself first; by the time it reaches here, this is just a harmless
    // no-op repeat (historyDirty is already false).
    HistoryManager.discardEmptyActiveSession();

    this.state.practiceChunkIndex = null;
    this.state.practiceActiveId = null;
    this.state.studyResults.clear();
    this.state.markHistory = [];
    this.state.wrongOnly = false;
    this.dom.wrongFilterBtn.setAttribute('aria-pressed', 'false');
    this.state.visibleChars = [];
    this.state.renderedCount = 0;
    this.cardEls.clear();
    this.updateScore();
    this.updateUndoUI();

    const groupSize = this.constants.PRACTICE_GROUP_SIZE;
    const headTitle = '选择练习组';
    const headSub = `选择整级练习，或按级别挑选练习组，每组 ${groupSize} 字`;
    // 全部/整个一级/整个二级/整个三级 together as one grouped row, rather
    // than each 整个X级 buried inside its own level's section.
    const wholeRow = {
      titleHTML: '整级练习',
      cells: ['all', '1', '2', '3'].map(lvl => this.buildWholeCell(lvl, false))
    };
    const levelSections = ['1', '2', '3'].map(lvl => ({
      titleHTML: Templates.sectionLabel(lvl),
      cells: this.buildChunkCells(lvl)
    }));
    const sections = [wholeRow, ...levelSections];

    this.dom.gridContainer.innerHTML = Templates.chunkPicker(headTitle, headSub, sections);
    window.scrollTo({ top: 0 });
  },

  // Handles a click on a chunk-picker cell (see openChunkPicker above) —
  // level/chunkAttr are read from the cell's own data-level/data-chunk
  // (not assumed from this.state.currentFilter), since a cell in 全部's
  // fanned-out picker belongs to a specific real level regardless of which
  // tab was active when the picker opened. chunkAttr is either 'whole' or
  // a stringified chunk index.
  selectChunk(level, chunkAttr) {
    const chunkIndex = chunkAttr === 'whole' ? null : parseInt(chunkAttr, 10);
    let session;
    if (HistoryManager.state.pendingFreshStart) {
      // 新练习 was pressed just before this click — always start a
      // genuinely new session for whatever was picked, even if that exact
      // chunk/whole-level already has progress (the normal branch below
      // would otherwise just resume it, silently defeating 新练习). The
      // old session, if any, stays intact as its own separate entry in
      // 历史记录 — same as how a fresh 新练习 session always worked before
      // chunking existed.
      HistoryManager.state.pendingFreshStart = false;
      session = HistoryManager.createPracticeSession(level, chunkIndex);
    } else {
      session = chunkIndex === null
      ? (HistoryManager.getLatestSessionForLevel(level) || HistoryManager.createPracticeSession(level, null))
      : (HistoryManager.getSessionForLevelChunk(level, chunkIndex) || HistoryManager.createPracticeSession(level, chunkIndex));
    }
    HistoryManager.activateSession(session);
    this.renderGrid(false);
    HistoryManager.saveActiveSession(true);
    this.scrollToPracticeCard(this.state.practiceActiveId);
    HistoryManager.saveHistoryState();
  },

  renderGrid(resetScroll = false) {
    this.state.visibleChars = this.getFiltered();
    this.state.renderedCount = 0;
    // Every full re-render discards whatever's currently in gridContainer
    // below, so any element references cached from the previous render are
    // about to go stale — clear before repopulating rather than risk a
    // lookup returning a detached node.
    this.cardEls.clear();

    if (resetScroll) {
      window.scrollTo({ top: 0 });
    }

    if (this.state.visibleChars.length === 0) {
      this.dom.gridContainer.innerHTML = Templates.emptyGrid();
      this.state.practiceActiveId = null;
      this.updateScore();
      this.updateReadingProgress();
      return;
    }

    this.dom.gridContainer.innerHTML = '';
    this.renderNextChunk();
    this.syncPracticeSelection();
    this.updateScore();
    this.updateReadingProgress();
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
        // Register the newly-added elements in the id->element cache. Based
        // on position (last N children) rather than a fresh query, since
        // targetGrid may already be live in document (an existing section
        // from a prior chunk) or still part of docFragment — this works
        // identically either way.
        const newEls = Array.from(targetGrid.children).slice(-run.chars.length);
        run.chars.forEach((c, i) => this.cardEls.set(c.i, newEls[i]));
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
      const newEls = Array.from(mainGrid.children).slice(-chunk.length);
      chunk.forEach((c, i) => this.cardEls.set(c.i, newEls[i]));
    }

    this.state.renderedCount = end;
    this.applyPracticeActive();
  },

  cardHTML(c) {
    const studyResult = this.state.studyResults.get(c.i);
    const isActive = c.i === this.state.practiceActiveId;
    return Templates.card(c, studyResult, this.state.isStudyMode, isActive, BookmarkManager.isBookmarked(c.i));
  },

  // Keeps the grading buttons' aria-pressed in sync with the card's actual
  // marked state. Templates.card() sets it correctly at initial render,
  // but applyCardResult()/undoLastMark()/clearCardStates() all mutate an
  // already-rendered card's classes directly rather than re-rendering the
  // template — so each of those needs to call this too, or aria-pressed
  // would silently go stale the moment a card gets marked.
  setCardAriaPressed(card, result) {
    const correctBtn = card.querySelector('.btn-correct');
    const wrongBtn = card.querySelector('.btn-wrong');
    if (correctBtn) correctBtn.setAttribute('aria-pressed', result === 'correct' ? 'true' : 'false');
    if (wrongBtn) wrongBtn.setAttribute('aria-pressed', result === 'wrong' ? 'true' : 'false');
  },

  // Keeps the 撤销 bar button's count badge and disabled state in sync
  // with the undo stack. Called after every mark and every undo.
  updateUndoUI() {
    if (!this.dom.undoBarBtn || !this.dom.undoBarCount) return;
    const count = this.state.markHistory.length;
    this.dom.undoBarCount.textContent = String(count);
    this.dom.undoBarBtn.disabled = count === 0;
  },

  applyCardResult(card, result) {
    const id = parseInt(card.dataset.id, 10);
    const current = this.state.studyResults.get(id);

    this.state.markHistory.push({ id, prevResult: current });
    // Defensive cap — a very long marathon session shouldn't let this grow
    // unbounded. 50 is comfortably more than anyone would realistically
    // want to walk back through in one sitting.
    if (this.state.markHistory.length > 50) this.state.markHistory.shift();

    card.classList.remove('revealed');
    card.classList.remove('correct', 'wrong');

    if (current === result) {
      this.state.studyResults.delete(id);
      this.setCardAriaPressed(card, null);
    } else {
      this.state.studyResults.set(id, result);
      card.classList.add(result);
      this.setCardAriaPressed(card, result);
    }
    this.updateScore();
    this.updateUndoUI();
    HistoryManager.state.historyDirty = true;
    HistoryManager.scheduleHistorySave();

    if (this.state.wrongOnly && this.state.studyResults.get(id) !== 'wrong') {
      // The card just regraded away from "wrong" — drop it from the
      // wrong-only review list instead of leaving it dangling in view.
      this.renderGrid();
    }
  },

  // Shared by both the mouse-click and keyboard (J/K) grading paths, so
  // the two can't silently drift apart in behavior again — previously the
  // click path only marked the card and stopped there, while the keyboard
  // path also advanced to the next card, which looked like an unintended
  // inconsistency.
  gradeCard(card, result) {
    this.applyCardResult(card, result);
    this.advancePracticeCard();
    HistoryManager.saveActiveSession(true);
  },

  undoLastMark() {
    if (this.state.markHistory.length === 0) return false;
    const { id, prevResult } = this.state.markHistory.pop();

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
      const card = this.cardEls.get(id) || null;
      if (card) {
        card.classList.remove('correct', 'wrong', 'revealed');
        if (prevResult) card.classList.add(prevResult);
        this.setCardAriaPressed(card, prevResult || null);
      }
    }

    const activeCard = this.ensureCardRendered(id);
    this.setPracticeActive(id);
    if (activeCard) activeCard.scrollIntoView({ block: 'center', behavior: 'smooth' });

    this.updateScore();
    this.updateUndoUI();
    HistoryManager.state.historyDirty = true;
    // Forced, not debounced — mirrors gradeCard()'s own immediate save.
    // Undo needs the session object to reflect the reverted state right
    // away, not 250ms later: anything that reads session.results in the
    // meantime (there's at least one such read elsewhere) would otherwise
    // see the stale pre-undo marks and could reintroduce them.
    HistoryManager.saveActiveSession(true);
    return true;
  },

  // Applies visual state to any bookmark button — the grid card's star,
  // the flashcard modal's button, or (in principle) any future surface —
  // without knowing or caring which one it's touching.
  setBookmarkBtnState(btn, isBookmarked) {
    btn.classList.toggle('active', isBookmarked);
    btn.setAttribute('aria-pressed', isBookmarked ? 'true' : 'false');
    btn.setAttribute('aria-label', isBookmarked ? '取消收藏' : '收藏');
    const svg = btn.querySelector('svg');
    if (svg) svg.setAttribute('fill', isBookmarked ? 'currentColor' : 'none');
  },

  // Single source of truth for toggling a bookmark, called from both the
  // grid card's star and the flashcard modal's button — keeps both
  // surfaces in sync with each other regardless of which one was clicked,
  // rather than each maintaining its own toggle logic that could drift
  // apart (same principle as gradeCard() unifying mouse/keyboard grading
  // earlier in this app).
  toggleBookmark(id) {
    const isNowBookmarked = BookmarkManager.toggle(id);

    const card = this.cardEls.get(id) || null;
    const cardBtn = card ? card.querySelector('.bookmark-btn') : null;
    if (cardBtn) this.setBookmarkBtnState(cardBtn, isNowBookmarked);

    const openChar = this.state.visibleChars[this.state.activeModalIdx];
    if (this.dom.fcBookmarkBtn && openChar && openChar.i === id) {
      this.setBookmarkBtnState(this.dom.fcBookmarkBtn, isNowBookmarked);
    }

    this.updateBookmarkFilterUI();
    if (this.state.bookmarkOnly && !isNowBookmarked) {
      // Just unbookmarked while viewing 只看收藏 — drop it from view,
      // matching the existing wrongOnly regrade-away pattern.
      this.renderGrid();
    }
    return isNowBookmarked;
  },

  // Keeps the 只看收藏 toggle's badge count and disabled state — and the
  // 清空收藏 button's disabled state — in sync. Called after any bookmark
  // toggle, and once at startup/mode-switch so it's accurate before the
  // user touches anything.
  updateBookmarkFilterUI() {
    const count = BookmarkManager.count();
    if (this.dom.bookmarkFilterCount && this.dom.bookmarkFilterBtn) {
    this.dom.bookmarkFilterCount.textContent = String(count);
    this.dom.bookmarkFilterBtn.disabled = count === 0 && !this.state.bookmarkOnly;
    }
    if (this.dom.bookmarkClearBtn) {
      this.dom.bookmarkClearBtn.disabled = count === 0;
    }
  },

  // Removes every bookmark at once, behind the same danger-confirm dialog
  // pattern already used for deleting a practice session in the History
  // panel. If 只看收藏 happens to be active, turns it off too — staying on
  // a filter that would now show nothing forever would just be confusing.
  clearAllBookmarks() {
    const count = BookmarkManager.count();
    if (count === 0) return;
    this.openMiniModal({
      title: '清空收藏',
      text: `确定要清空全部 ${count} 个收藏吗？此操作无法撤销。`,
      confirmLabel: '清空',
      danger: true,
      onConfirm: () => {
        BookmarkManager.clear();
        this.updateBookmarkFilterUI();
        if (this.state.bookmarkOnly) {
          this.state.bookmarkOnly = false;
          if (this.dom.bookmarkFilterBtn) this.dom.bookmarkFilterBtn.setAttribute('aria-pressed', 'false');
        }
        // Rebuilds every currently-rendered card fresh (reading bookmark
        // state from BookmarkManager, now empty), so every star updates —
        // cheaper to just re-render than to hunt down and reset each
        // .bookmark-btn individually. The flashcard modal isn't touched
        // by renderGrid(), but it's structurally impossible for it to be
        // open here: it's a full-screen overlay covering the reading bar
        // this button lives in, so reaching this click means it's closed.
        this.renderGrid(true);
      }
    });
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
    return this.cardEls.get(this.state.practiceActiveId) || null;
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
    return this.cardEls.get(id) || null;
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
    if (!nextId) {
      // Nothing left unmarked — clear the active pointer instead of
      // leaving it stuck on the card that was just graded. Without this,
      // that last card keeps its .active class forever (nothing ever
      // moves it elsewhere), which combined with .active.correct/
      // .active.wrong's CSS rule (buttons stay visible for the current
      // graded card, meant to be a brief window before advancing to the
      // next one) means its 对/错 buttons stay permanently visible
      // instead of going back to hover-only like every other completed
      // card. The 🎉 completion toast is the intended "you're done"
      // signal — not a stuck-open button pair on one specific card.
      this.setPracticeActive(null);
      return;
    }
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

    if (this.dom.fcBookmarkBtn) {
      // 阅读模式 only, matching the grid card's own bookmark button — the
      // flashcard modal is reachable from both modes (clicking a card's
      // edge/pinyin/number opens it regardless of mode), so this has to
      // be checked fresh on every open/navigate rather than being a
      // fixed part of the modal's markup.
      this.dom.fcBookmarkBtn.hidden = this.state.isStudyMode;
      this.setBookmarkBtnState(this.dom.fcBookmarkBtn, BookmarkManager.isBookmarked(c.i));
    }

    if (!wasOpen) this.openFocusTrap(this.dom.modal, this.dom.fcCloseBtn);
  },

  initStrokes(char) {
    const container = document.getElementById('stroke-container');
    container.innerHTML = '<div class="stroke-loading">加载笔顺…</div>';
    this.state.hwWriter = null;

    // HanziWriter draws raw SVG with literal colors passed at creation
    // time — it has no idea about CSS variables or dark mode, so the
    // stroke colors have to be resolved manually here to match whichever
    // theme is currently active. Values are picked to match --ink /
    // --border / --teal in each theme (see :root and
    // :root[data-theme="dark"] in styles.css).
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const strokeColor = isDark ? '#f3ede2' : '#1a1714';
    const outlineColor = isDark ? 'rgba(255,255,255,0.15)' : 'rgba(26,23,20,0.12)';
    const drawingColor = isDark ? '#4cb896' : '#0f6e56';

    try {
      this.state.hwWriter = HanziWriter.create('stroke-container', char, {
        width: 180,
        height: 180,
        padding: 12,
        showOutline: true,
        strokeColor: strokeColor,
        outlineColor: outlineColor,
        drawingColor: drawingColor,
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
    SpeechManager.stop();
  },

  navCard(dir) {
    SpeechManager.stop();
    this.showModal(this.state.activeModalIdx + dir);
  },

  // Ephemeral "阅读进度" counter for 阅读模式 — no persistence, just reflects
  // whichever character card is currently topmost in the viewport, so the
  // user always has a live sense of position while scrolling. Resets on
  // reload by design; nothing here is saved.
  updateReadingProgress() {
    if (this.state.isStudyMode || !this.dom.readingProgressCount) return;
    const total = this.state.visibleChars.length;
    if (total === 0) {
      this.dom.readingProgressCount.textContent = '– / –';
      return;
    }

    const headerOffset = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-offset')) || 0;
    const readingBar = document.querySelector('.reading-bar');
    const threshold = headerOffset + (readingBar ? readingBar.offsetHeight : 0);

    const cards = document.querySelectorAll('.char-card');
    let topCard = null;
    for (const card of cards) {
      if (card.getBoundingClientRect().bottom > threshold) { topCard = card; break; }
    }
    if (!topCard) topCard = cards[cards.length - 1] || null;
    if (!topCard) { this.dom.readingProgressCount.textContent = '– / –'; return; }

    const id = parseInt(topCard.dataset.id, 10);
    const idx = this.state.visibleChars.findIndex(c => c.i === id);
    this.dom.readingProgressCount.textContent = idx === -1
      ? '– / –'
      : `${(idx + 1).toLocaleString()} / ${total.toLocaleString()}`;
  },

  setStudy(on) {
    document.body.classList.toggle('study-mode', on);
    this.state.isStudyMode = on;
    this.dom.btnNormal.classList.toggle('active', !on);
    this.dom.btnStudy.classList.toggle('active', on);
    HistoryManager.state.historyState.practiceMode = on;
    if (!on) {
      HistoryManager.saveActiveSession(true);
      // Cancel any pending "start fresh on next chunk pick" intent from an
      // unconsumed 新练习 click — leaving 练习模式 abandons the picker
      // entirely, so that intent shouldn't silently apply to some later,
      // unrelated resume.
      HistoryManager.state.pendingFreshStart = false;
      this.state.practiceActiveId = null;
      this.state.studyResults.clear();
      this.clearCardStates();
      // Rebuild the grid in 阅读模式's shape — without this, the DOM is
      // left however it was last rendered while entering 练习模式 (which
      // omits bookmark buttons entirely, since Templates.card() doesn't
      // render them in study mode), so returning to 阅读模式 would show
      // no bookmark stars at all despite bookmarks still being intact.
      this.renderGrid(false);
    } else {
      // Resume directly if a session is already active (regardless of
      // level — 阅读模式's own level filter may have changed currentFilter
      // since this session was paused; ensurePracticeSession() resyncs it
      // from the session itself). Otherwise there's nothing to resume, so
      // show the picker.
      if (HistoryManager.state.activeSession) {
      HistoryManager.ensurePracticeSession();
        // setStudy(false) clears studyResults/markHistory/practiceActiveId
        // on the way out (see below), and ensurePracticeSession()'s fast
        // path deliberately doesn't repopulate them (removing that reload
        // fixed a different bug — see its own comment) — so this resume
        // path needs to restore them explicitly, or every card in the
        // session would render as unmarked despite the underlying data
        // being intact in HistoryManager.state.activeSession.results.
        HistoryManager.loadSessionResults(HistoryManager.state.activeSession);
      this.renderGrid(false);
      HistoryManager.saveActiveSession(true);
      this.scrollToPracticeCard(this.state.practiceActiveId);
      } else {
        this.openChunkPicker();
      }
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

  toggleBookmarkOnly() {
    this.state.bookmarkOnly = !this.state.bookmarkOnly;
    if (this.dom.bookmarkFilterBtn) {
      this.dom.bookmarkFilterBtn.setAttribute('aria-pressed', String(this.state.bookmarkOnly));
    }
    this.renderGrid(true);
  },

  clearCardStates() {
    this.dom.scoreCorrect.textContent = '0';
    this.dom.scoreWrong.textContent = '0';
    this.dom.scoreAccuracy.textContent = '';
    this.dom.practiceProgressFill.style.width = '0%';
    this.dom.practiceProgressCount.textContent = '0 / 0';
    this.dom.practiceCompleteToast.classList.remove('show');
    this.state.markHistory = [];
    this.updateUndoUI();
    document.querySelectorAll('.char-card').forEach(c => {
      c.classList.remove('correct', 'wrong', 'revealed', 'active');
      this.setCardAriaPressed(c, null);
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

    this.gradeCard(card, key === 'j' ? 'correct' : 'wrong');
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
