/**
 * tuner.js
 * Real-time cello-optimized pitch detection using Web Audio API + YIN algorithm.
 * Cello range: C2 (~65.4 Hz) through ~A5 (~880 Hz), extended to 55 Hz – 1200 Hz.
 *
 * Includes iOS / iPadOS Safari fixes:
 * - Creates & resumes AudioContext synchronously inside user gesture before getUserMedia()
 * - Connects AnalyserNode -> silent GainNode(0) -> destination so WebKit pulls mic frames
 * - Auto-recovers from 'suspended' / 'interrupted' AudioContext states
 * - DC-offset removal + sensitive RMS gate for acoustic cello & mobile mics
 */

const CelloTuner = (() => {
  const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

  const MIN_FREQ = 55;     // Below cello C2 (65.41 Hz)
  const MAX_FREQ = 1200;   // Well above high cello thumb position
  const RMS_THRESHOLD = 0.003; // Sensitive enough for iPad/mobile mic on a music stand (~ -50 dBFS)
  const YIN_THRESHOLD = 0.18;  // Tolerates bowed-string harmonics & rosin noise
  const YIN_FALLBACK_MAX = 0.32;

  // Intonation thresholds (in cents)
  const IN_TUNE_CENTS = 12;   // Green dot: within ±12 cents
  const CLOSE_CENTS = 45;     // Yellow + Flat/Sharp needle: ±12 to ±45 cents
                              // Red ("Off"): > 45 cents or wrong note

  const SAMPLE_INTERVAL_MS = 35; // ~28 Hz pitch updates (smooth UI, low CPU on iPad)

  let audioCtx = null;
  let analyser = null;
  let silentGain = null;
  let mediaStream = null;
  let sourceNode = null;
  let timeBuffer = null;
  let byteBuffer = null;
  let isRunning = false;

  // Short median buffer for glitch-free pitch reading
  const freqHistory = [];
  const HISTORY_SIZE = 4;

  // Cached last pitch reading for frame throttling
  let lastSampleTime = 0;
  let lastRawFreq = null;
  let lastRms = 0;

  function resumeIfNeeded() {
    if (!isRunning || !audioCtx) return;
    if (audioCtx.state === 'suspended' || audioCtx.state === 'interrupted') {
      try {
        const p = audioCtx.resume();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (_) {}
    }
  }

  async function requestMicStream() {
    // Prefer raw audio without speech processing (best for musical pitch detection)
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      });
    } catch (err) {
      // Fallback for browsers/devices that reject advanced audio constraints
      if (err && (err.name === 'OverconstrainedError' || err.name === 'TypeError' || err.name === 'NotSupportedError')) {
        return await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      }
      throw err;
    }
  }

  async function start() {
    if (isRunning) {
      resumeIfNeeded();
      return true;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Microphone access is not supported in this browser (HTTPS required on iPad/mobile).');
    }

    // CRITICAL for iOS / iPadOS Safari:
    // Create and resume the AudioContext synchronously INSIDE the click gesture,
    // BEFORE awaiting getUserMedia(), otherwise Safari expires the user gesture
    // and leaves the AudioContext permanently suspended.
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      throw new Error('Web Audio API is not supported in this browser.');
    }

    const ctx = new AudioContextClass();
    try {
      if (ctx.state === 'suspended') {
        // Fire resume immediately inside user gesture (do not block before getUserMedia)
        ctx.resume().catch(() => {});
      }
    } catch (_) {}

    try {
      mediaStream = await requestMicStream();
    } catch (err) {
      try { ctx.close(); } catch (_) {}
      throw err;
    }

    audioCtx = ctx;

    // Ensure context is running after getUserMedia resolves (iOS may switch AVAudioSession)
    if (audioCtx.state !== 'running') {
      try {
        await audioCtx.resume();
      } catch (_) {}
    }

    audioCtx.onstatechange = () => {
      if (isRunning && audioCtx && (audioCtx.state === 'suspended' || audioCtx.state === 'interrupted')) {
        resumeIfNeeded();
      }
    };

    // Detect if the OS/user revokes or ends the mic track externally
    mediaStream.getAudioTracks().forEach((track) => {
      track.onended = () => {
        if (isRunning) stop();
      };
    });

    sourceNode = audioCtx.createMediaStreamSource(mediaStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0;

    // CRITICAL for WebKit / iPadOS Safari:
    // Connect analyser through a 0-gain node to destination so Safari actually pulls
    // audio frames from the microphone without producing speaker feedback.
    silentGain = audioCtx.createGain();
    silentGain.gain.value = 0;

    sourceNode.connect(analyser);
    analyser.connect(silentGain);
    silentGain.connect(audioCtx.destination);

    timeBuffer = new Float32Array(analyser.fftSize);
    byteBuffer = new Uint8Array(analyser.fftSize);
    freqHistory.length = 0;
    lastSampleTime = 0;
    lastRawFreq = null;
    lastRms = 0;
    isRunning = true;
    return true;
  }

  function stop() {
    isRunning = false;
    freqHistory.length = 0;
    lastRawFreq = null;
    lastRms = 0;
    if (sourceNode) {
      try { sourceNode.disconnect(); } catch (_) {}
      sourceNode = null;
    }
    if (analyser) {
      try { analyser.disconnect(); } catch (_) {}
      analyser = null;
    }
    if (silentGain) {
      try { silentGain.disconnect(); } catch (_) {}
      silentGain = null;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
    if (audioCtx) {
      audioCtx.onstatechange = null;
      try { audioCtx.close(); } catch (_) {}
      audioCtx = null;
    }
    timeBuffer = null;
    byteBuffer = null;
  }

  function getActive() {
    return isRunning;
  }

  /**
   * Read time-domain samples into timeBuffer (with fallback for older WebKit)
   */
  function readTimeDomainData() {
    if (typeof analyser.getFloatTimeDomainData === 'function') {
      analyser.getFloatTimeDomainData(timeBuffer);
    } else {
      analyser.getByteTimeDomainData(byteBuffer);
      for (let i = 0; i < byteBuffer.length; i++) {
        timeBuffer[i] = (byteBuffer[i] - 128) / 128;
      }
    }
  }

  /**
   * YIN fundamental frequency estimator with DC-offset removal
   */
  function detectPitchYin(buffer, sampleRate) {
    const bufferSize = buffer.length;

    // 1. Remove DC offset & compute RMS
    let mean = 0;
    for (let i = 0; i < bufferSize; i++) {
      mean += buffer[i];
    }
    mean /= bufferSize;

    let sumSq = 0;
    for (let i = 0; i < bufferSize; i++) {
      const v = buffer[i] - mean;
      buffer[i] = v;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / bufferSize);
    lastRms = rms;
    if (rms < RMS_THRESHOLD) return null;

    const minTau = Math.max(2, Math.floor(sampleRate / MAX_FREQ));
    const maxTau = Math.min(Math.floor(bufferSize / 2), Math.ceil(sampleRate / MIN_FREQ));
    if (maxTau <= minTau) return null;

    const yinBuffer = new Float32Array(maxTau + 1);

    // 2. Difference function d(tau)
    const windowSize = Math.min(1536, bufferSize - maxTau);
    for (let tau = 1; tau <= maxTau; tau++) {
      let sum = 0;
      for (let i = 0; i < windowSize; i++) {
        const diff = buffer[i] - buffer[i + tau];
        sum += diff * diff;
      }
      yinBuffer[tau] = sum;
    }

    // 3. Cumulative mean normalized difference function d'(tau)
    yinBuffer[0] = 1;
    let runningSum = 0;
    for (let tau = 1; tau <= maxTau; tau++) {
      runningSum += yinBuffer[tau];
      yinBuffer[tau] = runningSum > 0 ? (yinBuffer[tau] * tau) / runningSum : 1;
    }

    // 4. Absolute threshold search
    let tauEstimate = -1;
    for (let tau = minTau; tau < maxTau; tau++) {
      if (yinBuffer[tau] < YIN_THRESHOLD) {
        while (tau + 1 < maxTau && yinBuffer[tau + 1] < yinBuffer[tau]) {
          tau++;
        }
        tauEstimate = tau;
        break;
      }
    }

    // Fallback: global minimum if still reasonably periodic
    if (tauEstimate === -1) {
      let minVal = YIN_FALLBACK_MAX;
      for (let tau = minTau; tau < maxTau; tau++) {
        if (yinBuffer[tau] < minVal) {
          minVal = yinBuffer[tau];
          tauEstimate = tau;
        }
      }
    }

    if (tauEstimate === -1) return null;

    // 5. Parabolic interpolation for sub-sample precision
    let betterTau = tauEstimate;
    if (tauEstimate > 1 && tauEstimate < maxTau) {
      const s0 = yinBuffer[tauEstimate - 1];
      const s1 = yinBuffer[tauEstimate];
      const s2 = yinBuffer[tauEstimate + 1];
      const denom = 2 * (2 * s1 - s2 - s0);
      if (Math.abs(denom) > 1e-9) {
        betterTau = tauEstimate + (s2 - s0) / denom;
      }
    }

    const freq = sampleRate / betterTau;
    if (freq < MIN_FREQ || freq > MAX_FREQ) return null;
    return freq;
  }

  function median(arr) {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function freqToNoteInfo(freq) {
    const midiFloat = 69 + 12 * Math.log2(freq / 440);
    const nearestMidi = Math.round(midiFloat);
    const centsFromNearest = (midiFloat - nearestMidi) * 100;
    const noteIndex = ((nearestMidi % 12) + 12) % 12;
    const octave = Math.floor(nearestMidi / 12) - 1;
    return {
      midi: nearestMidi,
      noteName: `${NOTE_NAMES[noteIndex]}${octave}`,
      centsFromNearest,
    };
  }

  /**
   * Convert RMS to a 0–100 perceptual meter percentage
   */
  function rmsToLevelPercent(rms) {
    if (rms <= 0.0005) return 0;
    const db = 20 * Math.log10(rms);
    // Map -58 dB .. -12 dB -> 0 .. 100%
    const pct = ((db + 58) / 46) * 100;
    return Math.max(0, Math.min(100, Math.round(pct)));
  }

  /**
   * Sample current microphone audio and evaluate against optional targetNote (or array of targetNotes for chords)
   */
  function sample(targetNoteOrNotes) {
    if (!isRunning || !analyser || !timeBuffer || !audioCtx) {
      return {
        micOn: false,
        state: 'idle',
        detectedFreq: null,
        detectedNoteName: '—',
        cents: 0,
        gaugePercent: 50,
        inputLevel: 0,
        audioState: 'closed',
      };
    }

    const audioState = audioCtx.state;
    if (audioState !== 'running') {
      resumeIfNeeded();
      return {
        micOn: true,
        state: 'suspended',
        detectedFreq: null,
        detectedNoteName: '—',
        cents: 0,
        gaugePercent: 50,
        inputLevel: 0,
        audioState,
      };
    }

    const now = performance.now();
    if (now - lastSampleTime >= SAMPLE_INTERVAL_MS) {
      lastSampleTime = now;
      readTimeDomainData();
      const rawFreq = detectPitchYin(timeBuffer, audioCtx.sampleRate);
      lastRawFreq = rawFreq;

      if (rawFreq) {
        freqHistory.push(rawFreq);
        if (freqHistory.length > HISTORY_SIZE) freqHistory.shift();
      } else if (freqHistory.length > 0) {
        freqHistory.shift();
      }
    }

    const inputLevel = rmsToLevelPercent(lastRms);

    if (!lastRawFreq || freqHistory.length === 0) {
      return {
        micOn: true,
        state: 'silent',
        detectedFreq: null,
        detectedNoteName: '—',
        cents: 0,
        gaugePercent: 50,
        inputLevel,
        audioState,
      };
    }

    const smoothFreq = median(freqHistory);
    const noteInfo = freqToNoteInfo(smoothFreq);

    // Pick target note (if array of chord tones, pick the closest pitch)
    let targetNote = null;
    if (Array.isArray(targetNoteOrNotes)) {
      const pitched = targetNoteOrNotes.filter((n) => n && !n.isRest && n.frequency);
      let bestAbs = Infinity;
      for (const n of pitched) {
        const c = Math.abs(1200 * Math.log2(smoothFreq / n.frequency));
        if (c < bestAbs) {
          bestAbs = c;
          targetNote = n;
        }
      }
    } else if (targetNoteOrNotes && !targetNoteOrNotes.isRest && targetNoteOrNotes.frequency) {
      targetNote = targetNoteOrNotes;
    }

    // Compare against targetNote.frequency if present, otherwise chromatic nearest semitone
    let cents;
    if (targetNote) {
      cents = 1200 * Math.log2(smoothFreq / targetNote.frequency);
    } else {
      cents = noteInfo.centsFromNearest;
    }

    const absCents = Math.abs(cents);
    let state;
    if (absCents <= IN_TUNE_CENTS) {
      state = 'intune';
    } else if (absCents <= CLOSE_CENTS) {
      state = cents < 0 ? 'flat' : 'sharp';
    } else {
      state = 'off';
    }

    // Map cents (-60 to +60) to gauge percentage (4% to 96%)
    const clamped = Math.max(-60, Math.min(60, cents));
    const gaugePercent = 50 + (clamped / 60) * 46;

    return {
      micOn: true,
      state,
      detectedFreq: smoothFreq,
      detectedNoteName: noteInfo.noteName,
      cents: Math.round(cents),
      gaugePercent,
      inputLevel,
      audioState,
    };
  }

  return {
    start,
    stop,
    getActive,
    resumeIfNeeded,
    sample,
  };
})();
