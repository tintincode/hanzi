// js/theme.js
// ThemeManager: light/dark/auto theme cycling, with genuine live OS-level
// following while in "auto" mode. Deliberately separate from practice
// history/bookmarks/data storage — theme is purely a display preference,
// same "keep concerns separate" principle used throughout this app.
//
// The very first resolution (before this module even loads) happens via
// a small inline blocking script in <head>, to avoid a flash of the
// wrong theme before CSS paints — that script sets the SAME two
// attributes this module manages (data-theme / data-theme-mode) using
// identical resolution logic. This module takes over from there: it
// syncs the toggle button's label to match what was already resolved,
// then wires up click-to-cycle and the live OS-change listener.
//
// Usage:
//   ThemeManager.init(HanziApp);  // once, after HanziApp.cacheDOM()
//   ThemeManager.bindEvents();    // once, wires the toggle + matchMedia listener

const STORAGE_KEY = 'hanziStudyTheme';

const ThemeManager = {
  // Reference to the host app — needed for a handful of things this
  // module doesn't own itself: app.dom.themeToggleBtn, app.dom.modal (to
  // check whether the flashcard is open), app.state.visibleChars /
  // activeModalIdx (to find which character that is), and
  // app.initStrokes() (to refresh stroke colors if the OS theme changes
  // live while that modal happens to be open). Same pattern already used
  // by HistoryManager.
  app: null,

  init(app) {
    this.app = app;
    // Sync the toggle button's title/label to whatever the inline
    // blocking script in <head> already resolved before this module
    // even loaded.
    this.updateThemeToggleLabel(document.documentElement.getAttribute('data-theme-mode') || 'auto');
  },

  bindEvents() {
    const btn = this.app.dom.themeToggleBtn;
    if (btn) {
      btn.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme-mode') || 'auto';
        const next = current === 'light' ? 'dark' : current === 'dark' ? 'auto' : 'light';
        this.applyThemeMode(next);
        try {
          localStorage.setItem(STORAGE_KEY, next);
        } catch (e) {
          // localStorage unavailable — theme still applies for this session,
          // just won't persist across reloads.
        }
      });
    }

    // Live OS theme-following — only takes effect while data-theme-mode
    // is "auto". Always registered (cheap to leave listening even when
    // not in auto mode right now — the mode can change later via the
    // toggle, and this only re-checks the guard on actual OS changes,
    // which are rare).
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
        if (document.documentElement.getAttribute('data-theme-mode') !== 'auto') return;
        document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
        // The flashcard modal is normally unreachable while this toggle
        // is too (both live in the header, covered by the modal's own
        // backdrop) — but that only rules out a *manual click* causing
        // this overlap. This listener fires from the OS, not a click, so
        // it genuinely can happen while a flashcard is open. Stroke
        // colors are resolved from data-theme at the moment initStrokes()
        // runs (see its own comment there) — refresh them now instead of
        // leaving them stale until the next open/navigate.
        if (this.app.dom.modal && this.app.dom.modal.classList.contains('open')) {
          const openChar = this.app.state.visibleChars[this.app.state.activeModalIdx];
          if (openChar) this.app.initStrokes(openChar.c);
        }
      });
    }
  },

  // Resolves `mode` ("light"/"dark"/"auto") to an actual color and applies
  // both data-theme (resolved, for CSS) and data-theme-mode (the actual
  // choice, for the toggle button's own icon) — mirrors the same logic as
  // the inline blocking script in <head>, since both need to resolve
  // "auto" identically.
  applyThemeMode(mode) {
    const resolved = mode === 'auto'
      ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : mode;
    document.documentElement.setAttribute('data-theme', resolved);
    document.documentElement.setAttribute('data-theme-mode', mode);
    this.updateThemeToggleLabel(mode);
  },

  updateThemeToggleLabel(mode) {
    const btn = this.app.dom.themeToggleBtn;
    if (!btn) return;
    const labels = {
      light: '当前：浅色（点击切换到深色）',
      dark: '当前：深色（点击切换到跟随系统）',
      auto: '当前：跟随系统（点击切换到浅色）'
    };
    const text = labels[mode] || labels.auto;
    btn.title = text;
    btn.setAttribute('aria-label', text);
  }
};

export { ThemeManager };
