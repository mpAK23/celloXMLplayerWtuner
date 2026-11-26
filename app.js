/**
 * app.js
 * Main application controller connecting MusicXML loading (1-line solo & 2-line duets),
 * scrolling staff playback, per-line Tone.js cello audio playback, real-time cello tuner
 * against the selected line, tempo slider, and optional metronome.
 */

(() => {
  // DOM Elements
  const musicTitleEl = document.getElementById('music-title');
  const musicFilenameEl = document.getElementById('music-filename');
  const musicSubtitleEl = document.getElementById('music-subtitle');
  const recentSelectEl = document.getElementById('recent-select');
  const fileInputEl = document.getElementById('file-input');
  const browseBtn = document.getElementById('browse-btn');

  const micBtn = document.getElementById('mic-btn');
  const micBtnLabel = document.getElementById('mic-btn-label');
  const micLevelFillEl = document.getElementById('mic-level-fill');
  const micSelectEl = document.getElementById('mic-select');
  const targetNoteLabelEl = document.getElementById('target-note-label');
  const targetNoteEl = document.getElementById('target-note');
  const detectedNoteEl = document.getElementById('detected-note');

  const lightFlatEl = document.getElementById('light-flat');
  const lightInTuneEl = document.getElementById('light-intune');
  const lightSharpEl = document.getElementById('light-sharp');
  const lightOffEl = document.getElementById('light-off');
  const gaugeNeedleEl = document.getElementById('gauge-needle');
  const tunerStatusTextEl = document.getElementById('tuner-status-text');
  const centsReadoutEl = document.getElementById('cents-readout');

  const measureIndicatorEl = document.getElementById('measure-indicator');
  const audioStatusPillEl = document.getElementById('audio-status-pill');
  const toggleLabelsEl = document.getElementById('toggle-labels');
  const toggleMetronomeEl = document.getElementById('toggle-metronome');
  const staffStageEl = document.getElementById('staff-stage');
  const lineControlsRailEl = document.getElementById('line-controls-rail');
  const staffContainerEl = document.getElementById('staff-container');
  const staffCanvasEl = document.getElementById('staff-canvas');
  const progressSliderEl = document.getElementById('progress-slider');

  const restartBtn = document.getElementById('restart-btn');
  const playBtn = document.getElementById('play-btn');
  const playIcon = document.getElementById('play-icon');
  const pauseIcon = document.getElementById('pause-icon');
  const playBtnLabel = document.getElementById('play-btn-label');

  const tempoSliderEl = document.getElementById('tempo-slider');
  const tempoBpmDisplayEl = document.getElementById('tempo-bpm-display');
  const tempoResetBtn = document.getElementById('tempo-reset-btn');

  // State
  const staff = new StaffRenderer(staffCanvasEl, staffContainerEl);
  let currentScore = null;
  let currentLines = [];

  // Per-line toggles
  let lineSoundEnabled = [false, true];
  let tunerLineIndex = 0;

  // Playback state
  let isPlaying = false;
  let currentBeat = 0;
  let baseTempo = 72;
  let tempoPercent = 100;
  let lastFrameTime = null;
  let lastMetronomeBeat = -1;
  let needsInitialAudioTrigger = true;

  // 2-measure count-in state (plays clicks even when Metronome toggle is off)
  let isCountingIn = false;
  let countInElapsedBeats = 0;
  let countInTotalBeats = 8;
  let countInBeatsPerMeasure = 4;
  let lastCountInBeat = -1;

  // Lightweight Web Audio synth for metronome & count-in clicks
  let metroCtx = null;

  function ensureMetronomeContext() {
    try {
      if (!metroCtx) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        metroCtx = new AudioContextClass();
      }
      if (metroCtx.state === 'suspended' || metroCtx.state === 'interrupted') {
        metroCtx.resume().catch(() => {});
      }
    } catch (_) {}
  }

  function playMetronomeClick(isDownbeat) {
    try {
      ensureMetronomeContext();
      if (!metroCtx) return;
      const now = metroCtx.currentTime;
      const osc = metroCtx.createOscillator();
      const gain = metroCtx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(isDownbeat ? 1150 : 820, now);
      gain.gain.setValueAtTime(isDownbeat ? 0.22 : 0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
      osc.connect(gain);
      gain.connect(metroCtx.destination);
      osc.start(now);
      osc.stop(now + 0.055);
    } catch (_) {}
  }

  function getBeatsPerMeasure() {
    const primary = currentLines[0];
    const ts = primary && primary.timeSig;
    if (ts && ts.beats && ts.beatType) {
      const quarterBeats = ts.beats * (4 / ts.beatType);
      return Math.max(1, Math.round(quarterBeats));
    }
    return 4;
  }

  function cancelCountIn() {
    isCountingIn = false;
    countInElapsedBeats = 0;
    lastCountInBeat = -1;
  }

  // Subscribe to CelloAudio sample loading status
  CelloAudio.onStatusChange((status) => {
    if (!audioStatusPillEl) return;
    audioStatusPillEl.classList.remove('ready', 'loading');
    if (status === 'ready') {
      audioStatusPillEl.textContent = 'Cello Sound: Sampled Ready';
      audioStatusPillEl.classList.add('ready');
    } else if (status === 'loading') {
      audioStatusPillEl.textContent = 'Cello Sound: Loading Samples…';
      audioStatusPillEl.classList.add('loading');
    } else if (status === 'fallback') {
      audioStatusPillEl.textContent = 'Cello Sound: Synth Fallback';
    } else {
      audioStatusPillEl.textContent = 'Cello Sound: Ready';
    }
  });

  function getEffectiveBpm() {
    return Math.max(15, Math.round((baseTempo * tempoPercent) / 100));
  }

  function updateTempoDisplay() {
    const bpm = getEffectiveBpm();
    tempoBpmDisplayEl.textContent = `${bpm} BPM (${tempoPercent}%)`;
  }

  /**
   * Build the per-line Sound & Tuner tick cards in the left rail directly beside each staff line.
   */
  function renderLineControls() {
    lineControlsRailEl.innerHTML = '';

    currentLines.forEach((line, idx) => {
      const isTuner = idx === tunerLineIndex;
      const isSound = Boolean(lineSoundEnabled[idx]);

      const card = document.createElement('div');
      card.className = `line-control-card${isTuner ? ' tuner-selected' : ''}`;
      card.dataset.lineIndex = String(idx);

      const titleRow = document.createElement('div');
      titleRow.className = 'line-card-title';
      titleRow.innerHTML = `
        <span>${line.displayLabel || `Line ${idx + 1}`}</span>
        ${isTuner ? '<span class="line-card-badge">Active</span>' : ''}
      `;

      const tickGroup = document.createElement('div');
      tickGroup.className = 'line-tick-group';

      // Tick 1: Play Cello Sound (independent checkbox per line)
      const soundLabel = document.createElement('label');
      soundLabel.className = `line-tick sound-tick${isSound ? ' is-checked' : ''}`;
      soundLabel.title = `Play cello audio for ${line.displayLabel}`;
      const soundCb = document.createElement('input');
      soundCb.type = 'checkbox';
      soundCb.checked = isSound;
      soundCb.setAttribute('aria-label', `Play sound for ${line.displayLabel}`);
      soundCb.addEventListener('change', async () => {
        lineSoundEnabled[idx] = soundCb.checked;
        soundLabel.classList.toggle('is-checked', soundCb.checked);
        if (soundCb.checked) {
          await CelloAudio.ensureStarted();
          CelloTuner.resumeIfNeeded();
        } else if (!lineSoundEnabled.some(Boolean)) {
          CelloAudio.stopAll();
        }
      });
      const soundText = document.createElement('span');
      soundText.textContent = 'Sound';
      soundLabel.appendChild(soundCb);
      soundLabel.appendChild(soundText);

      // Tick 2: Check Accuracy with Tuner (mutually exclusive radio toggle)
      const tunerLabel = document.createElement('label');
      tunerLabel.className = `line-tick tuner-tick${isTuner ? ' is-checked' : ''}`;
      tunerLabel.title = `Check intonation accuracy against ${line.displayLabel}`;
      const tunerRadio = document.createElement('input');
      tunerRadio.type = 'radio';
      tunerRadio.name = 'tuner-line';
      tunerRadio.value = String(idx);
      tunerRadio.checked = isTuner;
      tunerRadio.setAttribute('aria-label', `Check tuner accuracy on ${line.displayLabel}`);
      tunerRadio.addEventListener('change', () => {
        if (tunerRadio.checked) {
          tunerLineIndex = idx;
          staff.setTunerLineIndex(tunerLineIndex);
          updateTargetLabel();
          renderLineControls();
        }
      });
      const tunerText = document.createElement('span');
      tunerText.textContent = 'Tuner';
      tunerLabel.appendChild(tunerRadio);
      tunerLabel.appendChild(tunerText);

      tickGroup.appendChild(soundLabel);
      tickGroup.appendChild(tunerLabel);

      card.appendChild(titleRow);
      card.appendChild(tickGroup);
      lineControlsRailEl.appendChild(card);
    });
  }

  function updateTargetLabel() {
    const line = currentLines[tunerLineIndex];
    const name = line ? (line.displayLabel || `Line ${tunerLineIndex + 1}`) : 'Line 1';
    if (targetNoteLabelEl) {
      targetNoteLabelEl.textContent = currentLines.length > 1 ? `Target (${name})` : 'Target';
    }
  }

  function loadScore(score) {
    currentScore = score;
    currentLines = score.lines || [];

    // Display title & filename clearly
    musicTitleEl.textContent = score.title || score.fileName || 'Untitled Score';
    if (score.fileName) {
      musicFilenameEl.textContent = score.fileName;
      musicFilenameEl.classList.remove('hidden');
    } else {
      musicFilenameEl.textContent = '';
      musicFilenameEl.classList.add('hidden');
    }
    musicSubtitleEl.textContent = score.subtitle || '';

    // Default per-line toggles:
    // - 2-line duet: Line 1 = Tuner (Sound OFF so you play it), Line 2 = Sound ON (accompaniment)
    // - 1-line solo: Line 1 = Tuner (Sound OFF so tuner hears you cleanly)
    tunerLineIndex = 0;
    if (currentLines.length >= 2) {
      lineSoundEnabled = [false, true];
    } else {
      lineSoundEnabled = [false];
    }

    // Adjust staff stage height for 1-line vs 2-line layout
    staffStageEl.classList.toggle('two-line', currentLines.length >= 2);
    staff.setLines(currentLines);
    staff.setTunerLineIndex(tunerLineIndex);
    staff.resize();

    renderLineControls();
    updateTargetLabel();

    baseTempo = score.initialTempo || 72;
    tempoPercent = 100;
    tempoSliderEl.value = '100';
    updateTempoDisplay();

    resetPlayback();
  }

  function clearNoteEvaluations() {
    for (const line of currentLines) {
      for (const n of line.notes) {
        n.evalState = null;
      }
    }
  }

  function resetPlayback() {
    setPlaying(false);
    CelloAudio.stopAll();
    currentBeat = 0;
    lastMetronomeBeat = -1;
    needsInitialAudioTrigger = true;
    clearNoteEvaluations();
    syncProgressUI();
  }

  function setPlaying(playing, withCountIn = false) {
    isPlaying = playing;
    lastFrameTime = null;
    if (playing) {
      needsInitialAudioTrigger = true;
      if (withCountIn) {
        countInBeatsPerMeasure = getBeatsPerMeasure();
        countInTotalBeats = countInBeatsPerMeasure * 2;
        countInElapsedBeats = 0;
        lastCountInBeat = -1;
        isCountingIn = true;
      } else {
        cancelCountIn();
      }
    } else {
      cancelCountIn();
      CelloAudio.stopAll();
    }
    playBtn.classList.toggle('playing', isPlaying);
    playIcon.classList.toggle('hidden', isPlaying);
    pauseIcon.classList.toggle('hidden', !isPlaying);
    playBtnLabel.textContent = isPlaying ? 'Pause' : 'Play';
  }

  /**
   * Returns all active notes at `beat` for a given line (supports chords / double-stops).
   */
  function findActiveNotesForLine(line, beat) {
    if (!line) return [];
    const pitched = [];
    let foundRest = null;
    for (const n of line.notes) {
      if (beat >= n.startBeat && beat < n.endBeat) {
        if (!n.isRest) pitched.push(n);
        else foundRest = n;
      }
      if (n.startBeat > beat) break;
    }
    if (pitched.length > 0) return pitched;
    return foundRest ? [foundRest] : [];
  }

  function findCurrentMeasure(beat) {
    const primary = currentLines[0];
    if (!primary || primary.measures.length === 0) {
      return { number: '1', index: 0, total: 1, measure: null };
    }
    for (let i = 0; i < primary.measures.length; i++) {
      const m = primary.measures[i];
      if (beat >= m.startBeat && beat < m.endBeat) {
        return { number: m.number, index: i, total: primary.measures.length, measure: m };
      }
    }
    const last = primary.measures[primary.measures.length - 1];
    return { number: last.number, index: primary.measures.length - 1, total: primary.measures.length, measure: last };
  }

  function syncProgressUI() {
    const totalBeats = currentScore ? currentScore.totalBeats : 0;
    if (totalBeats <= 0) {
      progressSliderEl.value = '0';
      measureIndicatorEl.textContent = 'Measure 1 / 1';
      return;
    }
    const pct = Math.max(0, Math.min(100, (currentBeat / totalBeats) * 100));
    progressSliderEl.value = pct.toFixed(2);

    const mInfo = findCurrentMeasure(currentBeat);
    measureIndicatorEl.textContent = `Measure ${mInfo.number} / ${mInfo.total}`;
  }

  /**
   * Trigger cello audio notes whose startBeat falls within [windowStart, windowEnd).
   */
  function triggerAudioInRange(windowStart, windowEnd, includeStartBoundary) {
    const secPerBeat = 60 / getEffectiveBpm();
    const eps = 1e-4;

    currentLines.forEach((line, idx) => {
      if (!lineSoundEnabled[idx]) return;
      for (const note of line.notes) {
        if (note.isRest || note.tieFromPrev) continue;
        const afterStart = includeStartBoundary
          ? note.startBeat >= windowStart - eps
          : note.startBeat > windowStart - eps;
        if (afterStart && note.startBeat < windowEnd - eps) {
          const beatsDur = note.tiedDurationBeats || note.durationBeats;
          const durSec = Math.max(0.08, beatsDur * secPerBeat * 0.94);
          CelloAudio.playNote(note.midi, durSec, 0.85);
        }
        if (note.startBeat >= windowEnd) break;
      }
    });
  }

  function updateTunerUI(tunerActiveNotes, res) {
    const pitched = tunerActiveNotes.filter((n) => !n.isRest);
    if (pitched.length > 0) {
      targetNoteEl.textContent = pitched.map((n) => n.noteName).join(' / ');
    } else if (tunerActiveNotes.length > 0 && tunerActiveNotes[0].isRest) {
      targetNoteEl.textContent = 'Rest';
    } else {
      targetNoteEl.textContent = '—';
    }

    detectedNoteEl.textContent = res.detectedNoteName;

    lightFlatEl.classList.remove('active');
    lightInTuneEl.classList.remove('active');
    lightSharpEl.classList.remove('active');
    lightOffEl.classList.remove('active');

    gaugeNeedleEl.className = 'gauge-needle';
    tunerStatusTextEl.className = 'tuner-status-text';

    if (!res.micOn) {
      if (micBtn.classList.contains('active')) {
        micBtn.classList.remove('active');
        micBtn.setAttribute('aria-pressed', 'false');
        micBtnLabel.textContent = 'Start Tuner';
      }
      if (micLevelFillEl) micLevelFillEl.style.width = '0%';
      gaugeNeedleEl.style.left = '50%';
      tunerStatusTextEl.textContent = 'Mic Off';
      centsReadoutEl.textContent = 'Click Start Tuner';
      return;
    }

    if (micLevelFillEl) {
      micLevelFillEl.style.width = `${res.inputLevel || 0}%`;
    }

    if (res.state === 'suspended') {
      gaugeNeedleEl.style.left = '50%';
      tunerStatusTextEl.textContent = 'Audio Paused';
      centsReadoutEl.textContent = 'Tap screen to resume';
      return;
    }

    if (res.state === 'nosignal') {
      gaugeNeedleEl.style.left = '50%';
      tunerStatusTextEl.textContent = 'No Mic Signal';
      centsReadoutEl.textContent = 'Check mic / try another input';
      return;
    }

    if (res.state === 'silent') {
      gaugeNeedleEl.style.left = '50%';
      if ((res.inputLevel || 0) >= 8) {
        tunerStatusTextEl.textContent = 'Hearing Sound…';
        centsReadoutEl.textContent = 'Hold a steady note';
      } else {
        tunerStatusTextEl.textContent = 'Listening…';
        centsReadoutEl.textContent = 'Play a note';
      }
      return;
    }

    gaugeNeedleEl.classList.add('active', `state-${res.state}`);
    gaugeNeedleEl.style.left = `${res.gaugePercent}%`;
    tunerStatusTextEl.classList.add(`state-${res.state}`);

    const sign = res.cents > 0 ? '+' : '';
    centsReadoutEl.textContent = `${sign}${res.cents} cents`;

    if (res.state === 'intune') {
      lightInTuneEl.classList.add('active');
      tunerStatusTextEl.textContent = 'In Tune!';
    } else if (res.state === 'flat') {
      lightFlatEl.classList.add('active');
      tunerStatusTextEl.textContent = 'Flat (Too Low)';
    } else if (res.state === 'sharp') {
      lightSharpEl.classList.add('active');
      tunerStatusTextEl.textContent = 'Sharp (Too High)';
    } else if (res.state === 'off') {
      lightOffEl.classList.add('active');
      tunerStatusTextEl.textContent = 'Off Pitch';
    }
  }

  /**
   * Sample tuner against the active note(s) on the selected tuner line.
   * If the tuner line has a chord (double-stop), CelloTuner evaluates against the closest chord tone.
   */
  function evaluateTunerForNotes(activeNotes) {
    return CelloTuner.sample(activeNotes && activeNotes.length > 0 ? activeNotes : null);
  }

  /**
   * Main animation loop
   */
  function tick(timestamp) {
    let countInInfo = null;

    if (isPlaying && currentScore && currentLines.length > 0) {
      if (lastFrameTime === null) lastFrameTime = timestamp;
      const dtSec = Math.min(0.1, (timestamp - lastFrameTime) / 1000);
      lastFrameTime = timestamp;
      const beatsPerSec = getEffectiveBpm() / 60;

      if (isCountingIn) {
        // Trigger beat 1 immediately at elapsed = 0, then on each integer beat crossing
        const prevElapsed = countInElapsedBeats;
        countInElapsedBeats += dtSec * beatsPerSec;

        const currentWhole = Math.floor(prevElapsed);
        if (currentWhole !== lastCountInBeat && currentWhole >= 0 && currentWhole < countInTotalBeats) {
          lastCountInBeat = currentWhole;
          const beatInBar = currentWhole % countInBeatsPerMeasure;
          playMetronomeClick(beatInBar === 0);
        }

        const nextWhole = Math.floor(countInElapsedBeats);
        if (nextWhole !== lastCountInBeat && nextWhole >= 0 && nextWhole < countInTotalBeats) {
          lastCountInBeat = nextWhole;
          const beatInBar = nextWhole % countInBeatsPerMeasure;
          playMetronomeClick(beatInBar === 0);
        }

        if (countInElapsedBeats >= countInTotalBeats) {
          // Seamless transition into the music with exact beat alignment
          const overshoot = countInElapsedBeats - countInTotalBeats;
          cancelCountIn();
          const prevBeat = currentBeat;
          currentBeat += overshoot;
          needsInitialAudioTrigger = true;
          lastMetronomeBeat = Math.floor(currentBeat) - 1;

          if (lineSoundEnabled.some(Boolean)) {
            triggerAudioInRange(prevBeat, currentBeat, true);
            needsInitialAudioTrigger = false;
          } else {
            needsInitialAudioTrigger = false;
          }

          if (toggleMetronomeEl.checked) {
            const wholeBeat = Math.floor(currentBeat);
            if (wholeBeat !== lastMetronomeBeat && wholeBeat >= 0) {
              lastMetronomeBeat = wholeBeat;
              const mInfo = findCurrentMeasure(currentBeat);
              const beatInMeasure = mInfo.measure ? Math.round(currentBeat - mInfo.measure.startBeat) : 0;
              playMetronomeClick(beatInMeasure === 0);
            }
          }
          syncProgressUI();
        } else {
          const activeWhole = Math.min(countInTotalBeats - 1, Math.floor(countInElapsedBeats));
          const bar = Math.floor(activeWhole / countInBeatsPerMeasure) + 1;
          const beat = (activeWhole % countInBeatsPerMeasure) + 1;
          countInInfo = {
            bar,
            totalBars: 2,
            beat,
            beatsPerMeasure: countInBeatsPerMeasure,
            beatProgress: countInElapsedBeats - activeWhole,
          };
          measureIndicatorEl.textContent = `Count-In · Bar ${bar} / 2 · Beat ${beat}`;
        }
      } else {
        const prevBeat = currentBeat;
        currentBeat += dtSec * beatsPerSec;

        // Trigger Tone.js cello audio for any lines with Sound enabled
        if (lineSoundEnabled.some(Boolean)) {
          triggerAudioInRange(prevBeat, currentBeat, needsInitialAudioTrigger);
          needsInitialAudioTrigger = false;
        } else {
          needsInitialAudioTrigger = false;
        }

        // Optional metronome click on integer beat crossings
        if (toggleMetronomeEl.checked) {
          const wholeBeat = Math.floor(currentBeat);
          if (wholeBeat !== lastMetronomeBeat && wholeBeat >= 0) {
            lastMetronomeBeat = wholeBeat;
            const mInfo = findCurrentMeasure(currentBeat);
            const beatInMeasure = mInfo.measure ? Math.round(currentBeat - mInfo.measure.startBeat) : 0;
            playMetronomeClick(beatInMeasure === 0);
          }
        }

        if (currentBeat >= currentScore.totalBeats) {
          currentBeat = currentScore.totalBeats;
          setPlaying(false);
        }

        syncProgressUI();
      }
    }

    const activeNotesByLine = currentLines.map((line) => findActiveNotesForLine(line, currentBeat));
    const safeTunerIdx = Math.min(tunerLineIndex, Math.max(0, currentLines.length - 1));
    const tunerActiveNotes = activeNotesByLine[safeTunerIdx] || [];
    const tunerResult = evaluateTunerForNotes(tunerActiveNotes);

    // Record intonation state onto the tuner-checked line's active notes (skip during count-in)
    if (!isCountingIn && tunerResult.micOn && tunerResult.state !== 'silent' && tunerResult.state !== 'suspended' && tunerResult.state !== 'nosignal') {
      for (const n of tunerActiveNotes) {
        if (!n.isRest) {
          if (n.evalState !== 'intune' || tunerResult.state === 'intune') {
            n.evalState = tunerResult.state;
          }
        }
      }
    }

    updateTunerUI(tunerActiveNotes, tunerResult);
    staff.render(currentBeat, activeNotesByLine, tunerResult, countInInfo);

    requestAnimationFrame(tick);
  }

  // ---------- Event Listeners ----------

  // Pre-warm audio context on first click & auto-resume tuner AudioContext on iOS/iPadOS taps
  document.body.addEventListener('click', () => {
    CelloAudio.init();
  }, { once: true });

  ['pointerdown', 'touchstart', 'click'].forEach((evt) => {
    window.addEventListener(evt, () => {
      CelloTuner.resumeIfNeeded();
    }, { passive: true });
  });

  // Local Browser FIFO Cache (up to 10 recently uploaded MusicXML files per user)
  const RECENT_STORAGE_KEY = 'celloPlayAlong.recentFiles.v1';
  const LAST_SELECTED_KEY = 'celloPlayAlong.lastSelectedId.v1';
  const MAX_RECENT_FILES = 10;

  function readRecentCache() {
    try {
      const raw = localStorage.getItem(RECENT_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  function writeRecentCache(entries) {
    const list = entries.slice(0, MAX_RECENT_FILES);
    while (list.length > 0) {
      try {
        localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(list));
        return list;
      } catch (_) {
        // Storage quota exceeded: evict oldest entry (FIFO) and retry
        list.pop();
      }
    }
    return [];
  }

  function saveUploadedScoreToCache(score) {
    if (!score || !score.rawXml) return null;
    const fileName = score.fileName || `${score.title || 'Untitled'}.xml`;
    const title = score.title || fileName;
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      fileName,
      title,
      xml: score.rawXml,
      uploadedAt: Date.now(),
    };

    // Remove existing entry with the same filename so re-uploads refresh its slot without duplicating
    const existing = readRecentCache().filter((item) => item.fileName !== fileName);
    existing.unshift(entry); // Newest at top; oldest evicted at index >= MAX_RECENT_FILES (FIFO)
    const saved = writeRecentCache(existing);
    const activeId = saved.some((item) => item.id === entry.id) ? entry.id : (saved[0]?.id || '');
    try {
      if (activeId) localStorage.setItem(LAST_SELECTED_KEY, activeId);
    } catch (_) {}
    renderRecentDropdown(activeId);
    return activeId;
  }

  function renderRecentDropdown(selectedId = '') {
    const entries = readRecentCache();
    recentSelectEl.innerHTML = '';

    if (entries.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No saved files yet';
      recentSelectEl.appendChild(opt);
      recentSelectEl.disabled = true;
      return;
    }

    recentSelectEl.disabled = false;
    entries.forEach((item) => {
      const opt = document.createElement('option');
      opt.value = item.id;
      const baseName = item.fileName.replace(/\.(musicxml|xml|mxl)$/i, '');
      opt.textContent = item.title && item.title !== baseName && item.title !== item.fileName
        ? `${item.title} (${item.fileName})`
        : item.fileName;
      recentSelectEl.appendChild(opt);
    });

    if (selectedId && entries.some((item) => item.id === selectedId)) {
      recentSelectEl.value = selectedId;
    } else {
      recentSelectEl.value = entries[0].id;
    }
  }

  function loadCachedEntryById(id) {
    const entries = readRecentCache();
    const entry = entries.find((item) => item.id === id) || entries[0];
    if (!entry) {
      showEmptyState();
      return false;
    }
    try {
      const fallbackTitle = entry.fileName.replace(/\.(musicxml|xml|mxl)$/i, '');
      const score = MusicXMLParser.parseXmlString(entry.xml, fallbackTitle, entry.fileName);
      loadScore(score);
      try { localStorage.setItem(LAST_SELECTED_KEY, entry.id); } catch (_) {}
      renderRecentDropdown(entry.id);
      return true;
    } catch (err) {
      console.error('Failed to parse cached MusicXML entry:', err);
      return false;
    }
  }

  function showEmptyState() {
    currentScore = null;
    currentLines = [];
    musicTitleEl.textContent = 'Upload a MusicXML File';
    musicFilenameEl.textContent = '';
    musicFilenameEl.classList.add('hidden');
    musicSubtitleEl.textContent = 'Browse or drag & drop a .xml, .musicxml, or .mxl file (last 10 saved locally)';
    staffStageEl.classList.remove('two-line');
    staff.setLines([]);
    staff.resize();
    lineControlsRailEl.innerHTML = `
      <div class="line-control-card">
        <div class="line-card-title"><span>No Score</span></div>
        <p style="font-size:0.78rem;color:var(--text-muted);line-height:1.4;">Upload a MusicXML file to see Line 1 &amp; Line 2 controls.</p>
      </div>
    `;
    renderRecentDropdown('');
    resetPlayback();
  }

  // Browse MusicXML file
  browseBtn.addEventListener('click', () => fileInputEl.click());

  fileInputEl.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const score = await MusicXMLParser.parseFile(file);
      loadScore(score);
      saveUploadedScoreToCache(score);
    } catch (err) {
      alert(err.message || 'Failed to load MusicXML file.');
    } finally {
      fileInputEl.value = '';
    }
  });

  // Drag & drop MusicXML file anywhere on the page
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (!/\.(xml|musicxml|mxl)$/i.test(file.name)) {
      alert('Please drop a .xml, .musicxml, or .mxl file.');
      return;
    }
    try {
      const score = await MusicXMLParser.parseFile(file);
      loadScore(score);
      saveUploadedScoreToCache(score);
    } catch (err) {
      alert(err.message || 'Failed to parse dropped MusicXML file.');
    }
  });

  // Recent cached files dropdown switcher
  recentSelectEl.addEventListener('change', () => {
    if (recentSelectEl.value) {
      loadCachedEntryById(recentSelectEl.value);
    }
  });

  async function refreshMicList() {
    if (!micSelectEl) return;
    const mics = await CelloTuner.listMicrophones();
    micSelectEl.innerHTML = '';
    if (mics.length === 0) {
      micSelectEl.classList.add('hidden');
      return;
    }
    mics.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m.deviceId;
      opt.textContent = m.label;
      micSelectEl.appendChild(opt);
    });
    const activeId = CelloTuner.getSelectedDeviceId();
    if (activeId && mics.some((m) => m.deviceId === activeId)) {
      micSelectEl.value = activeId;
    }
    micSelectEl.classList.remove('hidden');
  }

  // Mic / Tuner button
  micBtn.addEventListener('click', async () => {
    if (CelloTuner.getActive()) {
      CelloTuner.stop();
      micBtn.classList.remove('active');
      micBtn.setAttribute('aria-pressed', 'false');
      micBtnLabel.textContent = 'Start Tuner';
    } else {
      try {
        const chosenId = micSelectEl && !micSelectEl.classList.contains('hidden') ? micSelectEl.value : '';
        await CelloTuner.start(chosenId);
        micBtn.classList.add('active');
        micBtn.setAttribute('aria-pressed', 'true');
        micBtnLabel.textContent = 'Tuner Active';
        await refreshMicList();
      } catch (err) {
        alert(
          'Could not access microphone. Please allow microphone permission in your browser.\n\n' +
          (err.message || '')
        );
      }
    }
  });

  if (micSelectEl) {
    micSelectEl.addEventListener('change', async () => {
      if (!CelloTuner.getActive()) return;
      try {
        await CelloTuner.start(micSelectEl.value);
      } catch (err) {
        alert('Could not switch microphone.\n\n' + (err.message || ''));
      }
    });
  }

  if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === 'function') {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      if (CelloTuner.getActive()) refreshMicList();
    });
  }

  // Play / Pause & Restart
  playBtn.addEventListener('click', async () => {
    if (!currentScore || currentLines.length === 0) return;
    if (!isPlaying) {
      // Unlock click audio synchronously inside user gesture (critical for iPadOS Safari)
      ensureMetronomeContext();
      if (lineSoundEnabled.some(Boolean)) {
        await CelloAudio.ensureStarted();
        CelloTuner.resumeIfNeeded();
      }
      if (currentBeat >= currentScore.totalBeats) {
        currentBeat = 0;
        clearNoteEvaluations();
      }
      setPlaying(true, true);
    } else {
      setPlaying(false);
      syncProgressUI();
    }
  });

  restartBtn.addEventListener('click', () => {
    resetPlayback();
  });

  // Tempo slider
  tempoSliderEl.addEventListener('input', () => {
    tempoPercent = parseInt(tempoSliderEl.value, 10) || 100;
    updateTempoDisplay();
  });

  tempoResetBtn.addEventListener('click', () => {
    tempoPercent = 100;
    tempoSliderEl.value = '100';
    updateTempoDisplay();
  });

  // Progress slider scrubbing
  progressSliderEl.addEventListener('input', () => {
    if (!currentScore) return;
    cancelCountIn();
    const pct = parseFloat(progressSliderEl.value) || 0;
    currentBeat = (pct / 100) * currentScore.totalBeats;
    lastMetronomeBeat = Math.floor(currentBeat);
    needsInitialAudioTrigger = true;
    CelloAudio.stopAll();
    syncProgressUI();
  });

  // Note Labels toggle
  toggleLabelsEl.addEventListener('change', () => {
    staff.setShowNoteLabels(toggleLabelsEl.checked);
  });

  // Drag-to-scrub directly on the staff canvas
  let isDraggingStaff = false;
  let dragStartX = 0;
  let dragStartBeat = 0;

  staffContainerEl.addEventListener('pointerdown', (e) => {
    if (!currentScore) return;
    cancelCountIn();
    isDraggingStaff = true;
    dragStartX = e.clientX;
    dragStartBeat = currentBeat;
    CelloAudio.stopAll();
    staffContainerEl.setPointerCapture(e.pointerId);
  });

  staffContainerEl.addEventListener('pointermove', (e) => {
    if (!isDraggingStaff || !currentScore) return;
    const dx = e.clientX - dragStartX;
    const deltaBeats = -dx / staff.PIXELS_PER_BEAT;
    currentBeat = Math.max(0, Math.min(currentScore.totalBeats, dragStartBeat + deltaBeats));
    lastMetronomeBeat = Math.floor(currentBeat);
    needsInitialAudioTrigger = true;
    syncProgressUI();
  });

  staffContainerEl.addEventListener('pointerup', (e) => {
    if (isDraggingStaff) {
      isDraggingStaff = false;
      try { staffContainerEl.releasePointerCapture(e.pointerId); } catch (_) {}
    }
  });

  // Keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    if (e.target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
    if (e.code === 'Space') {
      e.preventDefault();
      playBtn.click();
    } else if (e.key === 'r' || e.key === 'R') {
      restartBtn.click();
    }
  });

  // Responsive canvas resize
  window.addEventListener('resize', () => staff.resize());

  // Initialize from local browser cache (if any), otherwise show clean upload state
  CelloAudio.init();
  const cachedEntries = readRecentCache();
  if (cachedEntries.length > 0) {
    let lastId = '';
    try { lastId = localStorage.getItem(LAST_SELECTED_KEY) || ''; } catch (_) {}
    loadCachedEntryById(lastId || cachedEntries[0].id);
  } else {
    showEmptyState();
  }
  requestAnimationFrame(tick);
})();
