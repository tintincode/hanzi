// js/templates.js
// Templates: defines HTML templates for rendering characters and history cards.

export const Templates = {
  card(c, studyResult, isStudyMode, isActive, isBookmarked) {
    const pinyins = c.p;
    const isMulti = pinyins.length > 1;
    const resultClass = studyResult ? ` ${studyResult}` : '';
    const activeClass = isStudyMode && isActive ? ' active' : '';
    const pyHTML = isMulti
      ? `<div class="char-pinyin multi multi-pinyins">${pinyins.map(p => `<span>${p}</span>`).join('')}</div>`
      : `<div class="char-pinyin">${pinyins[0] || ''}</div>`;
    
    // Bookmark is 阅读模式-only by design (see bookmarks.js header comment
    // for why) — simply not rendered at all in study mode, rather than
    // rendered-but-hidden, to avoid any risk of stray interaction there.
    const bookmarkHTML = !isStudyMode
      ? `<button class="bookmark-btn${isBookmarked ? ' active' : ''}" data-bookmark-id="${c.i}" aria-label="${isBookmarked ? '取消收藏' : '收藏'}" aria-pressed="${isBookmarked ? 'true' : 'false'}" title="收藏">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="${isBookmarked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
      </button>`
      : '';

    return `<div class="char-card${resultClass}${activeClass}" data-id="${c.i}">
      ${bookmarkHTML}
      <div class="char-num">${c.i}</div>
      <div class="char-glyph" title="点击朗读">${c.c}</div>
      ${pyHTML}
      <div class="card-result-btns">
        <button class="btn-correct" aria-label="标记正确" aria-pressed="${studyResult === 'correct' ? 'true' : 'false'}" title="正确">对<span class="key-hint">J</span></button>
        <button class="btn-wrong" aria-label="标记错误" aria-pressed="${studyResult === 'wrong' ? 'true' : 'false'}" title="错误">错<span class="key-hint">K</span></button>
      </div>
    </div>`;
  },

  sectionLabel(levelKey) {
    const labelMap = { '1': '一级字表 (3500字)', '2': '二级字表 (3000字)', '3': '三级字表 (1605字)' };
    // CSS variable names, not literal hex — these are injected into an
    // inline style attribute below, but var(--x) still resolves against
    // the page's current theme there, same as it would in a stylesheet.
    // Previously these were hardcoded hex values, which silently froze
    // these three dots to their light-mode colors even in dark mode —
    // invisible to both dark-mode CSS passes, since neither thought to
    // check inside a JS template for colors.
    const colorMap = { '1': 'var(--teal)', '2': 'var(--accent)', '3': 'var(--danger)' };
    return `<span class="level-dot" style="background:${colorMap[levelKey]}"></span>${labelMap[levelKey]}`;
  },

  emptyGrid() {
    return `<div class="empty"><div class="empty-char">？</div><p>没有找到匹配的汉字</p></div>`;
  },

  historyCard(session, isActive, isComplete, title, meta, iconEdit, iconDelete, escapeFn) {
    return `
      <div class="history-card${isActive ? ' active' : ''}" data-session-id="${session.id}" role="button" tabindex="0">
        <div class="history-card-main">
          <span class="history-card-title">${escapeFn(title)}</span>
          <span class="history-card-meta">${meta}</span>
        </div>
        <span class="history-card-badge ${isComplete ? 'done' : 'in-progress'}">${isComplete ? '已完成' : '进行中'}</span>
        <div class="history-card-actions">
          <button class="history-rename-btn" data-session-id="${session.id}" title="重命名" aria-label="重命名记录">${iconEdit}</button>
          <button class="history-delete-btn" data-session-id="${session.id}" title="删除" aria-label="删除记录">${iconDelete}</button>
        </div>
      </div>`;
  },

  emptyHistory() {
    return '<div class="history-panel-empty">暂无练习记录<br>开始练习模式后会自动保存进度</div>';
  },

  // Shown in place of the character grid when entering 练习模式 for a level
  // (or 全部) with no already-active session (see app.js's openChunkPicker /
  // HanziApp.selectChunk). `sections` is [{ titleHTML, cells }] — titleHTML
  // is pre-built markup (typically from sectionLabel() above, for the same
  // colored-dot level headers used in the character grid itself) or null
  // to omit a header (used when the picker is already scoped to one level,
  // so a redundant per-section label would just repeat what
  // chunk-picker-head already says). Each cell is { chunkAttr, level,
  // label, range, meta, status, isWhole } — range (e.g. "201–300", the
  // same global character index shown on every card) is only set for
  // per-chunk 组N cells, omitted for whole-level cells where it wouldn't
  // add anything; status is 'not-started' | 'in-progress' | 'done',
  // computed by the caller from that cell's own persisted session (if
  // any); `level` is the cell's *real* level (never 'all'), read back by
  // app.js's click handler so 全部's picker can resolve each cell to the
  // correct underlying level-scoped session.
  chunkPicker(headTitle, headSub, sections) {
    const sectionsHTML = sections.map(sec => `
      ${sec.titleHTML ? `<div class="section-label">${sec.titleHTML}</div>` : ''}
      <div class="chunk-picker-grid">${sec.cells.map(cell => `
        <button class="chunk-cell chunk-cell--${cell.status}${cell.isWhole ? ' chunk-cell--whole' : ''}" data-chunk="${cell.chunkAttr}" data-level="${cell.level}" title="${cell.label}${cell.range ? ` · 第${cell.range}字` : ''} · ${cell.meta}">
        <span class="chunk-cell-label">${cell.label}</span>
          ${cell.range ? `<span class="chunk-cell-range">${cell.range}</span>` : ''}
        <span class="chunk-cell-meta">${cell.meta}</span>
        </button>`).join('')}</div>`).join('');
    return `<div class="chunk-picker">
      <div class="chunk-picker-head">
        <h2 class="chunk-picker-title">${headTitle}</h2>
        <p class="chunk-picker-sub">${headSub}</p>
      </div>
      ${sectionsHTML}
    </div>`;
  }
};
