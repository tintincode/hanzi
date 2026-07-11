// speech.js
// SpeechManager: wraps the browser's SpeechSynthesis API for reading
// Chinese characters aloud, including multi-reading (polyphonic) characters.
//
// Usage:
//   SpeechManager.init(allChars);      // once, with the full character list
//   SpeechManager.speak(char, pinyins); // returns a Promise, resolves when done

const SpeechManager = {
  state: {
    zhVoice: null,
    voicesReady: false
  },

  pinyinIndex: null,

  // Call once at startup with the full character dataset (array of
  // { c: '字', p: ['zi4', ...] }). Builds the pinyin lookup index and starts
  // loading available speech voices.
  init(allChars) {
    this.buildPinyinIndex(allChars);
    this.setupTTS();
  },

  buildPinyinIndex(allChars) {
    // Maps a pinyin reading (e.g. "bǔ") to a real character that uses that
    // exact reading. Bare romanized pinyin is unreliable TTS input — even
    // genuine Chinese voices are trained on real Chinese text, not isolated
    // romanization, and often mishandle or spell out short pinyin syllables
    // letter-by-letter. Speaking an actual character with that pronunciation
    // is far more reliable than speaking the romanized syllable itself.
    this.pinyinIndex = new Map();
    // Prefer single-pronunciation characters first — unambiguous, so the
    // reading we hear is guaranteed to be the one we looked up.
    for (const c of allChars) {
      if (c.p.length === 1 && !this.pinyinIndex.has(c.p[0])) {
        this.pinyinIndex.set(c.p[0], c.c);
      }
    }
    // Fill in any remaining readings using polyphonic characters as a
    // fallback (better than nothing, even if not perfectly unambiguous).
    for (const c of allChars) {
      for (const p of c.p) {
        if (!this.pinyinIndex.has(p)) this.pinyinIndex.set(p, c.c);
      }
    }
  },

  setupTTS() {
    if (!window.speechSynthesis) return;
    const loadVoices = () => {
      const vs = window.speechSynthesis.getVoices();
      if (vs.length === 0) return;
      this.state.zhVoice = vs.find(v => v.lang === 'zh-CN')
        || vs.find(v => v.lang === 'zh-TW')
        || vs.find(v => v.lang.startsWith('zh'))
        || null;
      this.state.voicesReady = true;
    };
    window.speechSynthesis.onvoiceschanged = loadVoices;
    loadVoices();
  },

  waitForVoices() {
    return new Promise(resolve => {
      if (!window.speechSynthesis || this.state.voicesReady) { resolve(); return; }
      const check = setInterval(() => {
        if (this.state.voicesReady) { clearInterval(check); resolve(); }
      }, 100);
      setTimeout(() => { clearInterval(check); resolve(); }, 3000);
    });
  },

  speakOne(text, lang, isRetry = false) {
    return new Promise(resolve => {
      if (!window.speechSynthesis) { resolve(); return; }
      // Small settle delay right before every speak() call (not just after
      // cancel()). The speech engine often clips the very start of an
      // utterance if asked to speak immediately after being idle or right
      // after a previous utterance ended — this gives it a moment to settle
      // first so the beginning of the audio doesn't get cut off.
      setTimeout(() => {
        try {
          const utt = new SpeechSynthesisUtterance(text);
          if (this.state.zhVoice) utt.voice = this.state.zhVoice;
          utt.lang = 'zh-CN';
          utt.rate = lang === 'pinyin' ? 0.7 : 0.85;
          let done = false;
          let errored = false;
          const finish = () => { if (!done) { done = true; resolve(); } };
          utt.onend = finish;
          utt.onerror = () => {
            errored = true;
            // Chrome's speech engine occasionally drops a single utterance in
            // a chained sequence (this is what makes multi-reading characters
            // more prone to skipping a syllable than single-reading ones —
            // more speak() calls means more chances to hit this). Retry once
            // before giving up on this particular syllable.
            if (!isRetry) {
              this.speakOne(text, lang, true).then(finish);
            } else {
              finish();
            }
          };
          // Defensive: Chrome can silently leave the engine in a "paused"
          // state between chained utterances, which would otherwise cause
          // every subsequent reading after the first to never play.
          window.speechSynthesis.resume();
          window.speechSynthesis.speak(utt);
          // Safety net: some browsers occasionally drop an utterance silently —
          // no sound, no onend, no onerror at all. Without this, a dropped
          // utterance would hang the promise chain forever and block every
          // reading after it (e.g. remaining pronunciations of a polyphonic
          // character) from ever being spoken.
          setTimeout(() => { if (!errored) finish(); }, 4000);
        } catch (e) {
          resolve();
        }
      }, 120);
    });
  },

  // Public entry point. Speaks `char` — if it has multiple readings
  // (polyphonic), speaks an example character for each reading in turn.
  async speak(char, pinyins) {
    if (!window.speechSynthesis) return;
    await this.waitForVoices();
    if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
      window.speechSynthesis.cancel();
      // Chrome has a known bug where speak() called immediately after
      // cancel() can silently no-op (nothing plays, no error fires). Give
      // the engine a tick to actually reset before queuing new speech —
      // this is the most likely cause of "sometimes it just doesn't speak."
      await new Promise(r => setTimeout(r, 80));
    }
    if (!pinyins || pinyins.length <= 1) {
      await this.speakOne(char, 'zh');
    } else {
      for (let i = 0; i < pinyins.length; i++) {
        const reading = pinyins[i];
        // Speaking bare romanized pinyin (e.g. "bǔ") is unreliable even on a
        // genuine Chinese voice — voices are trained on real Chinese text,
        // not isolated romanization, and often spell short syllables out
        // letter-by-letter ("b", "u") instead of pronouncing them as a word.
        // Look up a real character that uses this exact reading and speak
        // that instead — actual hanzi text is something any Chinese voice
        // reliably knows how to pronounce.
        const exampleChar = this.pinyinIndex && this.pinyinIndex.get(reading);
        if (exampleChar) {
          await this.speakOne(exampleChar, 'zh');
        } else {
          // No real character found with this exact reading (rare) — fall
          // back to the raw pinyin text as a last resort.
          await this.speakOne(reading, 'pinyin');
        }
        // Pause between readings so each utterance fully finishes — including
        // the engine's own internal cleanup — before the next one is queued,
        // rather than chaining them back-to-back.
        if (i < pinyins.length - 1) await new Promise(r => setTimeout(r, 650));
      }
    }
  }
};


export { SpeechManager };
