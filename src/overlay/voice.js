// Voice, the parts that are plain maths and text: the microphone recording turned into a small WAV file for the AI
// (16 kHz mono is plenty for speech), a check that anything was said at all, and what Lefty says out loud: his words
// without emoji, in a Windows voice for the user's language.
//
//   toWav(channels, rate) -> Uint8Array   channels: Float32Arrays (one per channel) at rate Hz -> 16 kHz mono WAV
//   heardSomething(samples) -> false for silence (no microphone sound worth sending)
//   endOfSpeech({ quietMs }) -> { hear(level, now) -> true once someone spoke and then stayed quiet for quietMs }
//   speakable(text) -> what to say: no emoji or symbols, short
//   langOf(text) -> 'hi' | 'ta' | ... from the script it's written in, or '' (Latin script: can't tell)
//   voiceLang(text, lang) -> the language to say text in, given the language the user speaks
//   pickVoice(voices, lang) -> the voice to use (null: the browser's default)
// Pure functions: loaded by the overlay page and by Node tests.

(function (root) {
  const RATE = 16000;

  // Mixes the channels and brings the rate down to 16 kHz. Each output sample averages the input samples it covers,
  // which also filters out the high sounds that would otherwise fold back as noise.
  function downsample(channels, rate) {
    const length = channels[0] ? channels[0].length : 0;
    const ratio = rate / RATE;
    const out = new Float32Array(Math.max(0, Math.floor(length / ratio)));
    for (let i = 0; i < out.length; i += 1) {
      const start = Math.floor(i * ratio);
      const end = Math.max(start + 1, Math.min(length, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (const channel of channels) for (let j = start; j < end; j += 1) sum += channel[j];
      out[i] = sum / ((end - start) * channels.length);
    }
    return out;
  }

  function toWav(channels, rate) {
    const samples = rate === RATE && channels.length === 1 ? channels[0] : downsample(channels, rate);
    const bytes = new Uint8Array(44 + samples.length * 2);
    const view = new DataView(bytes.buffer);
    const text = (at, s) => { for (let i = 0; i < s.length; i += 1) view.setUint8(at + i, s.charCodeAt(i)); };
    text(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true);       // the format block's size
    view.setUint16(20, 1, true);        // plain PCM
    view.setUint16(22, 1, true);        // mono
    view.setUint32(24, RATE, true);
    view.setUint32(28, RATE * 2, true); // bytes per second
    view.setUint16(32, 2, true);        // bytes per sample
    view.setUint16(34, 16, true);       // bits per sample
    text(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i += 1) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return bytes;
  }

  // Something was said: some 50 ms stretch is louder than a quiet room.
  function heardSomething(samples, rate = RATE) {
    const stretch = Math.max(1, Math.round(rate / 20));
    for (let start = 0; start < samples.length; start += stretch) {
      let sum = 0;
      const end = Math.min(samples.length, start + stretch);
      for (let i = start; i < end; i += 1) sum += samples[i] * samples[i];
      if (Math.sqrt(sum / (end - start)) > 0.015) return true;
    }
    return false;
  }

  // Listening without a button to let go of: once something was said, a quiet stretch this long means the user is
  // done, so Lefty sends it himself. level: the loudness (RMS) of the latest bit of sound.
  const SPEECH_LEVEL = 0.02;
  function endOfSpeech({ quietMs = 1500 } = {}) {
    let spoke = false;
    let quietSince = null;
    return {
      hear(level, now) {
        if (level > SPEECH_LEVEL) { spoke = true; quietSince = null; return false; }
        if (!spoke) return false;
        if (quietSince === null) quietSince = now;
        return now - quietSince >= quietMs;
      },
    };
  }

  function base64(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }

  // Lefty's words as they should sound: no emoji, arrows or button symbols; at most a few sentences.
  function speakable(text) {
    const said = String(text || '')
      .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu, ' ')
      .replace(/[→↵⏎■▶•·✓✔✗×]/g, ' ')
      .replace(/…/g, '...')
      .replace(/\s+/g, ' ')
      .trim();
    if (said.length <= 300) return said;
    const cut = said.slice(0, 300);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    return end > 80 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, '')}...`;
  }

  const SCRIPTS = [
    [/[ऀ-ॿ]/, 'hi'], [/[஀-௿]/, 'ta'], [/[ఀ-౿]/, 'te'], [/[ಀ-೿]/, 'kn'],
    [/[ഀ-ൿ]/, 'ml'], [/[ঀ-৿]/, 'bn'], [/[઀-૿]/, 'gu'], [/[਀-੿]/, 'pa'],
    [/[؀-ۿ]/, 'ar'], [/[Ѐ-ӿ]/, 'ru'], [/[぀-ヿ]/, 'ja'], [/[가-힯]/, 'ko'],
    [/[一-鿿]/, 'zh'], [/[฀-๿]/, 'th'], [/[֐-׿]/, 'he'], [/[Ͱ-Ͽ]/, 'el'],
  ];

  function langOf(text) {
    const found = SCRIPTS.find(([pattern]) => pattern.test(String(text || '')));
    return found ? found[1] : '';
  }

  // The language to say these words in: their own script's, else the user's language if it is written in Latin
  // letters too (Lefty's own English messages aren't read in a Hindi voice), else '' (the default voice).
  const NON_LATIN = new Set([...SCRIPTS.map(([, lang]) => lang), 'mr', 'ne', 'ur', 'fa', 'uk', 'bg', 'sr']);
  function voiceLang(text, lang) {
    const script = langOf(text);
    if (script) return script;
    const base = String(lang || '').toLowerCase().split('-')[0];
    return base && !NON_LATIN.has(base) ? String(lang) : '';
  }

  // A voice for the language: one on this PC first (works offline), else any that speaks it. Null when none does
  // (or no language is known): the browser's default voice then.
  function pickVoice(voices, lang) {
    const want = String(lang || '').toLowerCase().split('-')[0];
    if (!want || !Array.isArray(voices)) return null;
    const speaks = voices.filter((v) => v && String(v.lang || '').toLowerCase().replace('_', '-').split('-')[0] === want);
    return speaks.find((v) => v.localService) || speaks[0] || null;
  }

  const api = { toWav, downsample, heardSomething, endOfSpeech, base64, speakable, langOf, voiceLang, pickVoice, RATE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LeftyVoice = api;
})(this);
