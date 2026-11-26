/**
 * audio.js
 * Real sampled cello playback using Tone.js + nbrosowsky/tonejs-instruments cello samples
 * (same cello sound library used in https://mpak23.github.io/learncellonotes/),
 * with a warm FM synth fallback while samples finish loading or if offline.
 */

const CelloAudio = (() => {
  const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  const CELLO_SAMPLE_MAP = {
    'C2': 'C2.mp3',
    'D2': 'D2.mp3',
    'D#2': 'Ds2.mp3',
    'E2': 'E2.mp3',
    'F2': 'F2.mp3',
    'G2': 'G2.mp3',
    'G#2': 'Gs2.mp3',
    'A2': 'A2.mp3',
    'A#2': 'As2.mp3',
    'B2': 'B2.mp3',
    'C3': 'C3.mp3',
    'C#3': 'Cs3.mp3',
    'D3': 'D3.mp3',
    'D#3': 'Ds3.mp3',
    'E3': 'E3.mp3',
    'F3': 'F3.mp3',
    'F#3': 'Fs3.mp3',
    'G3': 'G3.mp3',
    'G#3': 'Gs3.mp3',
    'A3': 'A3.mp3',
    'A#3': 'As3.mp3',
    'B3': 'B3.mp3',
    'C4': 'C4.mp3',
    'C#4': 'Cs4.mp3',
    'D4': 'D4.mp3',
    'D#4': 'Ds4.mp3',
    'E4': 'E4.mp3',
    'F4': 'F4.mp3',
    'F#4': 'Fs4.mp3',
    'G4': 'G4.mp3',
    'G#4': 'Gs4.mp3',
    'A4': 'A4.mp3',
    'B4': 'B4.mp3',
    'C5': 'C5.mp3',
  };

  const REMOTE_BASE_URL =
    'https://raw.githubusercontent.com/nbrosowsky/tonejs-instruments/master/samples/cello/';

  let celloSampler = null;
  let fallbackSynth = null;
  let samplerLoaded = false;
  let audioStarted = false;
  let status = 'idle'; // 'idle' | 'loading' | 'ready' | 'fallback'
  const statusListeners = new Set();

  function setStatus(next) {
    status = next;
    statusListeners.forEach((fn) => {
      try { fn(status); } catch (_) {}
    });
  }

  function onStatusChange(fn) {
    statusListeners.add(fn);
    fn(status);
  }

  function midiToToneName(midi) {
    const noteIdx = ((midi % 12) + 12) % 12;
    const octave = Math.floor(midi / 12) - 1;
    return `${SHARP_NAMES[noteIdx]}${octave}`;
  }

  function init() {
    if (celloSampler || fallbackSynth) return;
    if (typeof Tone === 'undefined') {
      console.warn('Tone.js is not loaded; cello audio disabled.');
      setStatus('fallback');
      return;
    }

    try {
      setStatus('loading');

      celloSampler = new Tone.Sampler({
        urls: CELLO_SAMPLE_MAP,
        release: 1.2,
        baseUrl: REMOTE_BASE_URL,
        onload: () => {
          samplerLoaded = true;
          setStatus('ready');
        },
        onerror: () => {
          if (!samplerLoaded) setStatus('fallback');
        },
      }).toDestination();
      celloSampler.volume.value = 0;

      // Warm FMSynth fallback while samples finish loading (or if offline)
      const filter = new Tone.Filter(1800, 'lowpass').toDestination();
      fallbackSynth = new Tone.PolySynth(Tone.FMSynth, {
        harmonicity: 3.01,
        modulationIndex: 14,
        oscillator: { type: 'triangle' },
        envelope: { attack: 0.08, decay: 0.3, sustain: 0.6, release: 1.4 },
        modulation: { type: 'square' },
        modulationEnvelope: { attack: 0.08, decay: 0.2, sustain: 0.2, release: 0.2 },
      }).connect(filter);
      fallbackSynth.volume.value = -5;
    } catch (err) {
      console.error('CelloAudio init error:', err);
      setStatus('fallback');
    }
  }

  async function ensureStarted() {
    if (typeof Tone === 'undefined') return false;
    try {
      if (!audioStarted || Tone.context.state !== 'running') {
        await Tone.start();
        audioStarted = true;
      }
      init();
      return true;
    } catch (err) {
      console.error('Tone.start failed:', err);
      return false;
    }
  }

  function playNote(midi, durationSec = 0.6, velocity = 0.85) {
    if (typeof Tone === 'undefined' || !audioStarted) return;
    if (!celloSampler && !fallbackSynth) init();

    const toneName = midiToToneName(midi);
    const dur = Math.max(0.08, Math.min(12, durationSec));
    try {
      if (celloSampler && samplerLoaded) {
        celloSampler.triggerAttackRelease(toneName, dur, undefined, velocity);
      } else if (fallbackSynth) {
        fallbackSynth.triggerAttackRelease(toneName, dur, undefined, velocity * 0.75);
      }
    } catch (err) {
      console.error('CelloAudio playNote error:', err);
    }
  }

  function stopAll() {
    try {
      if (celloSampler && typeof celloSampler.releaseAll === 'function') {
        celloSampler.releaseAll();
      }
      if (fallbackSynth && typeof fallbackSynth.releaseAll === 'function') {
        fallbackSynth.releaseAll();
      }
    } catch (_) {}
  }

  function isLoaded() {
    return samplerLoaded;
  }

  return {
    init,
    ensureStarted,
    playNote,
    stopAll,
    isLoaded,
    onStatusChange,
  };
})();
