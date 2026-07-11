// js/search.js
// SearchManager: handles text normalization (pinyin tone stripping)
// and filtering characters by query, level, and wrong-only status.

const SearchManager = {
  allChars: [],

  init(allChars) {
    this.allChars = allChars;
  },

  /**
   * Strips accents/tones from pinyin for accent-insensitive search matching.
   */
  stripTones(str) {
    return str
      .toLowerCase()
      .replace(/[ǖǘǚǜü]/g, 'v')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  },

  /**
   * Filters the character list based on search term, level filter, and wrong-only filter.
   */
  filter(query, levelFilter, levelRanges, wrongOnly, studyResults) {
    let chars = this.allChars;

    // 1. Level Filter
    if (levelFilter !== 'all') {
      const range = levelRanges[levelFilter];
      if (range) {
        const [lo, hi] = range;
        chars = chars.filter(c => c.i >= lo && c.i <= hi);
      }
    }

    // 2. Search Query Matching (Exact Char, Pinyin Prefix, or Pinyin Substring)
    if (query) {
      const q = query.toLowerCase();
      const qStripped = this.stripTones(q);
      chars = chars.filter(c =>
        c.c === q ||
        c.p.some(p => p === q || p.startsWith(q) || this.stripTones(p).startsWith(qStripped)) ||
        c.p.join('/').includes(q)
      );
    }

    // 3. Wrong-Only Filter (mistakes review mode)
    if (wrongOnly && studyResults) {
      chars = chars.filter(c => studyResults.get(c.i) === 'wrong');
    }

    return chars;
  }
};


export { SearchManager };
