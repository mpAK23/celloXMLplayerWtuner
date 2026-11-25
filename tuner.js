/**
 * tuner.js
 * Real-time cello-optimized pitch detection using Web Audio API + YIN algorithm.
 * Cello range: C2 (~65.4 Hz) through ~A5 (~880 Hz), extended to 55 Hz – 1200 Hz.
 */

const CelloTuner = (() => {
  const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

  const MIN_FREQ = 55;     // Below cello C2 (65.41 Hz)
  const MAX_FREQ = 1200;   // Well above high cello thumb position
  const RMS_THRESHOLD = 0.012;
  const YIN_THRESHOLD = 0.14;

  // Intonation thresholds (in cents)
  const IN_TUNE_CENTS = 12;   // Green dot: within ±12 cents
  const CLOSE_CENTS = 45;     // Yellow + Flat/Sharp needle: ±12 to ±45 cents
                              // Red ("Off"): > 45 cents or wrong note

  let audioCtx = null;
  let analyser = null;
  let mediaStream = null;
  let sourceNode = null;
  let timeBuffer = null;
  let isRunning = false;

  // Short median buffer for glitch-free pitch reading
  const freqHistory = [];
  const HISTORY_SIZE = 4;

  async function start() {
    if (isRunning) return true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Microphone access is not supported in this browser.');
    }

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioContextClass();
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }

    sourceNode = audioCtx.createMediaStreamSource(mediaStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0;

    sourceNode.connect(analyser);
    timeBuffer = new Float32Array(analyser.fftSize);
    freqHistory.length = 0;
    isRunning = true;
    return true;
  }

  function stop() {
    isRunning = false;
    freqHistory.length = 0;
    if (sourceNode) {
      try { sourceNode.disconnect(); } catch (_) {}
      sourceNode = null;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
    if (audioCtx) {
      try { audioCtx.close(); } catch (_) {}
      audioCtx = null;
    }
    analyser = null;
    timeBuffer = null;
  }

  function getActive() {
    return isRunning;
  }

  /**
   * YIN fundamental frequency estimator
   */
  function detectPitchYin(buffer, sampleRate) {
    const bufferSize = buffer.length;

    // 1. RMS gate to ignore room noise
    let sumSq = 0;
    for (let i = 0; i < bufferSize; i++) {
      sumSq += buffer[i] * buffer[i];
    }
    const rms = Math.sqrt(sumSq / bufferSize);
    if (rms < RMS_THRESHOLD) return null;

    const minTau = Math.max(2, Math.floor(sampleRate / MAX_FREQ));
    const maxTau = Math.min(Math.floor(bufferSize / 2), Math.ceil(sampleRate / MIN_FREQ));
    const yinBuffer = new Float32Array(maxTau + 1);

    // 2. Difference function d(tau)
    const halfLen = Math.floor(bufferSize / 2);
    for (let tau = 1; tau <= maxTau; tau++) {
      let sum = 0;
      for (let i = 0; i < halfLen; i++) {
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
      let minVal = 0.25;
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
   * Sample current microphone audio and evaluate against optional targetNote
   */
  function sample(targetNote) {
    if (!isRunning || !analyser || !timeBuffer) {
      return {
        micOn: false,
        state: 'idle',
        detectedFreq: null,
        detectedNoteName: '—',
        cents: 0,
        gaugePercent: 50,
      };
    }

    analyser.getFloatTimeDomainData(timeBuffer);
    const rawFreq = detectPitchYin(timeBuffer, audioCtx.sampleRate);

    if (!rawFreq) {
      if (freqHistory.length > 0) freqHistory.shift();
      return {
        micOn: true,
        state: 'silent',
        detectedFreq: null,
        detectedNoteName: '—',
        cents: 0,
        gaugePercent: 50,
      };
    }

    freqHistory.push(rawFreq);
    if (freqHistory.length > HISTORY_SIZE) freqHistory.shift();
    const smoothFreq = median(freqHistory);
    const noteInfo = freqToNoteInfo(smoothFreq);

    // If there is a target note (not a rest), compare directly against targetNote.frequency.
    // Otherwise act as a chromatic tuner against the nearest semitone.
    let cents;
    if (targetNote && !targetNote.isRest && targetNote.frequency) {
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
    };
  }

  return {
    start,
    stop,
    getActive,
    sample,
  };
})();
