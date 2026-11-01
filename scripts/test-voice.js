// Checks voice: the microphone recording turned into the small WAV file the AI gets, the silence check, and what
// Lefty says out loud (no emoji, the right voice for the language). Run: npm run test:voice

const Voice = require('../src/overlay/voice');

let failed = 0;
function check(condition, message) {
  if (!condition) failed += 1;
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${message}`);
}

const tone = (hz, seconds, rate, amplitude = 0.5) => Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / rate));
const peak = (samples, from = 100) => samples.slice(from).reduce((m, v) => Math.max(m, Math.abs(v)), 0);

// --- the recording as a WAV file ---
{
  const left = tone(440, 1, 48000);
  const right = tone(440, 1, 48000);
  const wav = Voice.toWav([left, right], 48000);
  const view = new DataView(wav.buffer);
  const text = (at, n) => String.fromCharCode(...wav.slice(at, at + n));
  check(text(0, 4) === 'RIFF' && text(8, 4) === 'WAVE' && text(12, 4) === 'fmt ' && text(36, 4) === 'data', 'a proper WAV file: RIFF, WAVE, fmt and data blocks');
  check(view.getUint16(20, true) === 1 && view.getUint16(22, true) === 1 && view.getUint32(24, true) === 16000 && view.getUint16(34, true) === 16,
    'plain PCM, mono, 16 kHz, 16-bit: plenty for speech, and small');
  check(view.getUint32(40, true) === 16000 * 2 && wav.length === 44 + 32000 && view.getUint32(4, true) === wav.length - 8, 'one second of stereo 48 kHz becomes 16000 samples, sizes filled in right');
  const kb = Math.round((Voice.base64(wav).length * 3) / 4 / 1024);
  check(kb >= 30 && kb <= 33, `a second of speech is about 31 KB to send (${kb} KB)`);
  const loud = Voice.toWav([Float32Array.from([1, -1, 2, -2, 0])], 16000);
  const lv = new DataView(loud.buffer);
  check(lv.getInt16(44, true) === 32767 && lv.getInt16(46, true) === -32768 && lv.getInt16(48, true) === 32767 && lv.getInt16(50, true) === -32768 && lv.getInt16(52, true) === 0,
    'full volume maps to the 16-bit limits, and anything louder is clipped');
}

// --- bringing the rate down without folding high sounds into noise ---
{
  const speech = Voice.downsample([tone(500, 0.5, 48000)], 48000);
  check(speech.length === 8000 && peak(speech) > 0.45, `a 500 Hz voice tone keeps its strength (${peak(speech).toFixed(2)})`);
  const hiss = Voice.downsample([tone(20000, 0.5, 48000)], 48000);
  check(peak(hiss) < 0.25, `a 20 kHz hiss mostly disappears instead of coming back as noise (${peak(hiss).toFixed(2)})`);
  const odd = Voice.downsample([tone(300, 0.5, 44100)], 44100);
  check(odd.length === 8000 && peak(odd) > 0.45, '44.1 kHz microphones work too');
  const mixed = Voice.downsample([Float32Array.from({ length: 4800 }, () => 0.6), Float32Array.from({ length: 4800 }, () => -0.2)], 48000);
  check(Math.abs(mixed[10] - 0.2) < 1e-6, 'two channels are mixed into one');
}

// --- silence is not sent ---
check(!Voice.heardSomething(new Float32Array(16000)), 'silence: nothing to send');
check(!Voice.heardSomething(Float32Array.from({ length: 16000 }, () => (Math.random() - 0.5) * 0.01)), 'a quiet room hum: nothing to send');
check(Voice.heardSomething(Float32Array.from([...new Float32Array(8000), ...tone(200, 0.3, 16000, 0.2)])), 'a voice after a pause: something was said');
check(Voice.heardSomething(tone(200, 0.5, 48000, 0.1), 48000), 'checked at the microphone\'s own rate');

// --- base64 for the trip to the AI ---
{
  const bytes = Uint8Array.from({ length: 70000 }, (_, i) => i % 256);
  check(Buffer.from(Voice.base64(bytes), 'base64').equals(Buffer.from(bytes)), 'base64 round-trips, long recordings included');
}

// --- what Lefty says ---
check(Voice.speakable('🎉 Done! You did it. What next?') === 'Done! You did it. What next?', 'emoji are not read out');
check(Voice.speakable('⚡ Click Save 💾') === 'Click Save', 'nor the Do it mark');
check(Voice.speakable('✋ Your turn: Name it anything ✏️') === 'Your turn: Name it anything', 'the "Your turn" mark neither');
check(Voice.speakable('Thinking…') === 'Thinking...' && Voice.speakable('■ Stop (Esc)') === 'Stop (Esc)', 'symbols become words or go');
check(Voice.speakable('   ') === '' && Voice.speakable(null) === '', 'nothing to say says nothing');
const long = `${'This is a long sentence about saving files. '.repeat(12)}`;
const cut = Voice.speakable(long);
check(cut.length <= 300 && /\.$/.test(cut), `long answers are cut at the end of a sentence (${cut.length} characters)`);
check(Voice.speakable('सेव करें 💾') === 'सेव करें', 'Hindi words are read as they are');

// --- which language, which voice ---
check(Voice.langOf('सेव बटन दबाएँ') === 'hi' && Voice.langOf('சேமிக்கவும்') === 'ta' && Voice.langOf('Click Save') === '', 'the script shows the language (Hindi, Tamil); Latin letters alone can\'t tell');
check(Voice.voiceLang('सेव बटन दबाएँ', 'en') === 'hi', "Hindi words get a Hindi voice whatever came before");
check(Voice.voiceLang('Stopped.', 'hi') === '', "Lefty's own English words aren't read in a Hindi voice");
check(Voice.voiceLang('Haz clic en Guardar', 'es') === 'es' && Voice.voiceLang('Click Save', '') === '', 'Spanish answers get a Spanish voice; unknown means the default voice');
const voices = [
  { name: 'Microsoft David', lang: 'en-US', localService: true },
  { name: 'Microsoft Swara Online', lang: 'hi-IN', localService: false },
  { name: 'Microsoft Kalpana', lang: 'hi-IN', localService: true },
  { name: 'Microsoft Helena', lang: 'es_ES', localService: true },
];
check(Voice.pickVoice(voices, 'hi').name === 'Microsoft Kalpana', 'a voice on this PC is preferred (works offline)');
check(Voice.pickVoice(voices, 'es-MX').name === 'Microsoft Helena', 'a voice for the language, whatever its country');
check(Voice.pickVoice(voices, 'ta') === null && Voice.pickVoice(voices, '') === null && Voice.pickVoice(null, 'hi') === null, 'no voice for the language: the default one');

// --- sending by itself once the user stops talking ---
{
  const ear = Voice.endOfSpeech({ quietMs: 1500 });
  check(!ear.hear(0.001, 0) && !ear.hear(0.001, 5000), 'quiet before anything was said: keep listening');
  check(!ear.hear(0.2, 5100) && !ear.hear(0.005, 5200) && !ear.hear(0.3, 6000), 'a short pause while talking: keep listening');
  check(!ear.hear(0.005, 6100) && !ear.hear(0.005, 7500) && ear.hear(0.005, 7600), 'quiet for 1.5 s after talking: done');
}

console.log(failed ? `\n${failed} voice check(s) FAILED` : '\nAll voice checks passed.');
process.exit(failed ? 1 : 0);
