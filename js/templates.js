// js/templates.js
// Templates: defines HTML templates for rendering characters and history cards.

export const Templates = {
  card(c, studyResult, isStudyMode, isActive) {
    const pinyins = c.p;
    const isMulti = pinyins.length > 1;
    const resultClass = studyResult ? ` ${studyResult}` : '';
    const activeClass = isStudyMode && isActive ? ' active' : '';
    const pyHTML = isMulti
      ? `<div class="char-pinyin multi multi-pinyins">${pinyins.map(p => `<span>${p}</span>`).join('')}</div>`
      : `<div class="char-pinyin">${pinyins[0] || ''}</div>`;
    
    return `<div class="char-card${resultClass}${activeClass}" data-id="${c.i}">
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
  }
};
