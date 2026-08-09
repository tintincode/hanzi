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
    
    // Deliberately NOT gated by the same reveal/hover/.correct/.wrong
    // visibility rules that hide .char-pinyin in 练习模式 (see
    // `body.study-mode .char-pinyin { visibility: hidden; }` in
    // styles.css) — this badge needs to be visible *before* you reveal
    // the answer, since its whole purpose is telling you to try recalling
    // more than one reading while you're still guessing, not just
    // explaining what you already revealed. It doesn't say which
    // readings, only that there's more than one — otherwise it'd be
    // giving away part of the answer.
    const multiBadgeHTML = isMulti
      ? `<span class="char-multi-badge" title="多音字 · 共 ${pinyins.length} 种读音">音 ${pinyins.length}</span>`
      : '';
    
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
      <div class="char-top-row">
        ${multiBadgeHTML}
      <div class="char-num">${c.i}</div>
      </div>
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

  historyCard(session, isActive, isComplete, isSelected, title, meta, iconEdit, iconDelete, escapeFn) {
    return `
      <div class="history-card${isActive ? ' active' : ''}" data-session-id="${session.id}" role="button" tabindex="0">
        <button class="history-card-check" data-session-id="${session.id}" aria-label="选择此记录" aria-pressed="${isSelected ? 'true' : 'false'}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </button>
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

  // canDelete is false only when this is the last remaining profile —
  // deleting it would leave the app with zero profiles, which
  // ProfileManager.deleteProfile() refuses anyway, but omitting the
  // button entirely here avoids offering an action that would just
  // silently do nothing.
  //
  // iconExport adds a per-row backup button (see profiles.js's
  // exportProfileFlow()) — works for ANY profile row regardless of
  // whether it's the currently active one, so it's never conditionally
  // omitted the way the delete button is. Import is deliberately NOT a
  // per-row action (see the shared "导入资料" button elsewhere in the
  // panel, in index.html) — importing resolves its own target profile by
  // matching the backup file's saved name, rather than needing you to
  // pick a row first.
  profileCard(profile, isActive, canDelete, iconEdit, iconDelete, iconExport, escapeFn) {
    return `
      <div class="profile-card${isActive ? ' active' : ''}" data-profile-id="${profile.id}" role="button" tabindex="0">
        <div class="profile-card-main">
          <span class="profile-card-title">${escapeFn(profile.name)}</span>
          ${isActive ? '<span class="profile-card-badge">当前</span>' : ''}
        </div>
        <div class="profile-card-actions">
          <button class="profile-export-btn" data-profile-id="${profile.id}" title="导出此资料备份" aria-label="导出此资料备份">${iconExport}</button>
          <button class="profile-rename-btn" data-profile-id="${profile.id}" title="重命名" aria-label="重命名资料">${iconEdit}</button>
          ${canDelete ? `<button class="profile-delete-btn" data-profile-id="${profile.id}" title="删除" aria-label="删除资料">${iconDelete}</button>` : ''}
        </div>
      </div>`;
  },

  emptyHistory() {
    return '<div class="history-panel-empty">暂无练习记录<br>开始练习模式后会自动保存进度</div>';
  },

  // Shown in place of the character grid when entering 练习模式 with no
  // already-active session (see app.js's openChunkPicker / HanziApp.
  // selectChunk). `sections` is [{ titleHTML, cells }] — titleHTML is
  // pre-built markup (from sectionLabel() above for a level's colored-dot
  // header, or a plain string for the 整级练习 row) shown above that
  // section's cells; every section currently supplies one, since
  // openChunkPicker always shows every level's options together (a null
  // titleHTML is still handled below, but nothing currently passes it —
  // kept as a harmless fallback rather than a live code path). Each cell
  // is { chunkAttr, level, label, range, meta, status } — range (e.g.
  // "201–300", the same global character index shown on every card) is
  // only set for per-chunk 组N cells, omitted for whole-level cells where
  // it wouldn't add anything; status is 'not-started' | 'in-progress' |
  // 'done', computed by the caller from that cell's own persisted session
  // (if any); `level` is the cell's *real* level (never 'all'), read back
  // by app.js's click handler so 全部's picker can resolve each cell to
  // the correct underlying level-scoped session.
  chunkPicker(headTitle, headSub, sections) {
    const sectionsHTML = sections.map(sec => `
      ${sec.titleHTML ? `<div class="section-label">${sec.titleHTML}</div>` : ''}
      <div class="chunk-picker-grid">${sec.cells.map(cell => `
        <button class="chunk-cell chunk-cell--${cell.status}" data-chunk="${cell.chunkAttr}" data-level="${cell.level}" title="${cell.label}${cell.range ? ` · 第${cell.range}字` : ''} · ${cell.meta}">
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
