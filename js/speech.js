// speech.js
// SpeechManager: wraps the browser's SpeechSynthesis API for reading
// Chinese characters aloud, including multi-reading (polyphonic) characters.
//
// Usage:
//   SpeechManager.init(allChars);      // once, with the full character list
//   SpeechManager.speak(char, pinyins); // returns a Promise, resolves when done
//   SpeechManager.stop();               // immediately halts any speech in progress

// Tuned delays — each exists to work around a specific browser quirk (see
// comments at each usage site below for the reasoning behind the value).
const SETTLE_DELAY_MS = 120;        // pre-speak settle, avoids clipped audio starts
const UTTERANCE_TIMEOUT_MS = 4000;  // safety net for silently-dropped utterances
const CANCEL_SETTLE_MS = 80;        // post-cancel settle before queuing new speech
const INTER_READING_PAUSE_MS = 650; // pause between a polyphonic character's readings
const VOICE_POLL_INTERVAL_MS = 100;
const VOICE_WAIT_TIMEOUT_MS = 3000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Module-private state. Deliberately NOT exposed on the SpeechManager
// object (it used to live at SpeechManager.state.*, publicly writable —
// e.g. calling code could do `SpeechManager.state.zhVoice = null` and
// silently break voice selection, or reset `generation` and defeat the
// supersession logic below). Being plain module-scoped `let` bindings
// instead, they're only reachable from code inside this file, closed over
// by the methods below regardless of how those methods get called.
let zhVoice = null;
let voicesReady = false;
// Bumped on every speak()/stop() call. Any in-flight request captures its
// own token and checks it against this before proceeding — if a newer
// call has since superseded it, it bails out immediately instead of
// continuing to queue audio. Without this, clicking a second character
// while a polyphonic first character is still being read could interleave
// both characters' audio out of order.
let generation = 0;
// Maps a pinyin reading (e.g. "bǔ") to a real character that uses that
// exact reading — also private for the same reason as above.
let pinyinIndex = null;

const SpeechManager = {
  // Call once at startup with the full character dataset (array of
  // { c: '字', p: ['zi4', ...] }). Builds the pinyin lookup index and starts
  // loading available speech voices.
  init(allChars) {
    this.buildPinyinIndex(allChars);
    this.setupTTS();
  },

  buildPinyinIndex(allChars) {
    // Bare romanized pinyin is unreliable TTS input — even genuine Chinese
    // voices are trained on real Chinese text, not isolated romanization,
    // and often mishandle or spell out short pinyin syllables letter-by-
    // letter. Speaking an actual character with that pronunciation is far
    // more reliable than speaking the romanized syllable itself.
    pinyinIndex = new Map();
    // Prefer single-pronunciation characters first — unambiguous, so the
    // reading we hear is guaranteed to be the one we looked up.
    for (const c of allChars) {
      if (c.p.length === 1 && !pinyinIndex.has(c.p[0])) {
        pinyinIndex.set(c.p[0], c.c);
      }
    }
    // Fill in any remaining readings using polyphonic characters as a
    // fallback (better than nothing, even if not perfectly unambiguous).
    for (const c of allChars) {
      for (const p of c.p) {
        if (!pinyinIndex.has(p)) pinyinIndex.set(p, c.c);
      }
    }
  },

  setupTTS() {
    if (!window.speechSynthesis) return;
    const loadVoices = () => {
      const vs = window.speechSynthesis.getVoices();
      if (vs.length === 0) return;
      zhVoice = vs.find(v => v.lang === 'zh-CN')
        || vs.find(v => v.lang === 'zh-TW')
        || vs.find(v => v.lang.startsWith('zh'))
        || null;
      voicesReady = true;
    };
    window.speechSynthesis.onvoiceschanged = loadVoices;
    loadVoices();
  },

  waitForVoices() {
    return new Promise(resolve => {
      if (!window.speechSynthesis || voicesReady) { resolve(); return; }
      const check = setInterval(() => {
        if (voicesReady) { clearInterval(check); resolve(); }
      }, VOICE_POLL_INTERVAL_MS);
      setTimeout(() => { clearInterval(check); resolve(); }, VOICE_WAIT_TIMEOUT_MS);
    });
  },

  // Immediately halts any in-progress or queued speech and invalidates any
  // speak() call currently in flight (bumping `generation` first, then
  // cancelling, so the in-flight call's onerror handler sees the bump and
  // correctly skips its retry instead of re-queuing stale audio).
  stop() {
    generation++;
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  },

  // myGen: the calling speak()'s generation token, or null for calls made
  // outside of speak()'s sequencing (kept optional so speakOne remains
  // usable standalone). When provided, an onerror is only retried if this
  // request is still the active one — otherwise the error is almost
  // certainly cancel() firing because a newer speak()/stop() intentionally
  // superseded this one, and retrying would queue stale audio behind it.
  speakOne(text, lang, isRetry = false, myGen = null) {
    return new Promise(resolve => {
      if (!window.speechSynthesis) { resolve(); return; }
      // Small settle delay right before every speak() call (not just after
      // cancel()). The speech engine often clips the very start of an
      // utterance if asked to speak immediately after being idle or right
      // after a previous utterance ended — this gives it a moment to settle
      // first so the beginning of the audio doesn't get cut off.
      setTimeout(() => {
        // Superseded while waiting out the settle delay — don't even start
        // this utterance, so it never gets a chance to queue behind (or
        // interleave with) whatever superseded it.
        if (myGen !== null && myGen !== generation) { resolve(); return; }
        try {
          const utt = new SpeechSynthesisUtterance(text);
          if (zhVoice) utt.voice = zhVoice;
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
            // before giving up on this particular syllable — but only if
            // this request hasn't since been superseded (see myGen comment
            // above); otherwise this "error" is just our own cancel().
            const stillActive = myGen === null || myGen === generation;
            if (!isRetry && stillActive) {
              this.speakOne(text, lang, true, myGen).then(finish);
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
          setTimeout(() => { if (!errored) finish(); }, UTTERANCE_TIMEOUT_MS);
        } catch (e) {
          // Previously swallowed silently — warn so a real failure (e.g. a
          // browser rejecting the utterance outright) is at least visible
          // in devtools instead of just quietly doing nothing.
          console.warn('SpeechManager: failed to speak utterance', e);
          resolve();
        }
      }, SETTLE_DELAY_MS);
    });
  },

  // Public entry point. Speaks `char` — if it has multiple readings
  // (polyphonic), speaks an example character for each reading in turn.
  async speak(char, pinyins) {
    if (!window.speechSynthesis) return;
    // Claim this as the active request. Bumping here (before anything else)
    // means any previously in-flight speak() call's checks will now see a
    // mismatch and stop advancing, even if this call never ends up needing
    // to touch speechSynthesis.cancel() itself (e.g. nothing was playing).
    const myGen = ++generation;

    await this.waitForVoices();
    if (myGen !== generation) return; // superseded while waiting for voices

    if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
      window.speechSynthesis.cancel();
      // Chrome has a known bug where speak() called immediately after
      // cancel() can silently no-op (nothing plays, no error fires). Give
      // the engine a tick to actually reset before queuing new speech —
      // this is the most likely cause of "sometimes it just doesn't speak."
      await sleep(CANCEL_SETTLE_MS);
    }
    if (myGen !== generation) return; // superseded during the cancel-settle wait

    if (!pinyins || pinyins.length <= 1) {
      await this.speakOne(char, 'zh', false, myGen);
    } else {
      for (let i = 0; i < pinyins.length; i++) {
        if (myGen !== generation) return; // superseded mid-sequence
        const reading = pinyins[i];
        // Speaking bare romanized pinyin (e.g. "bǔ") is unreliable even on a
        // genuine Chinese voice — voices are trained on real Chinese text,
        // not isolated romanization, and often spell short syllables out
        // letter-by-letter ("b", "u") instead of pronouncing them as a word.
        // Look up a real character that uses this exact reading and speak
        // that instead — actual hanzi text is something any Chinese voice
        // reliably knows how to pronounce.
        const exampleChar = pinyinIndex && pinyinIndex.get(reading);
        if (exampleChar) {
          await this.speakOne(exampleChar, 'zh', false, myGen);
        } else {
          // No real character found with this exact reading (rare) — fall
          // back to the raw pinyin text as a last resort.
          await this.speakOne(reading, 'pinyin', false, myGen);
        }
        if (myGen !== generation) return; // superseded right after that utterance
        // Pause between readings so each utterance fully finishes — including
        // the engine's own internal cleanup — before the next one is queued,
        // rather than chaining them back-to-back.
        if (i < pinyins.length - 1) await sleep(INTER_READING_PAUSE_MS);
      }
    }
  }
};


export { SpeechManager };
