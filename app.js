/**
 * app.js
 * Main application controller connecting MusicXML loading, scrolling staff playback,
 * real-time cello tuner UI, tempo slider, and optional metronome.
 */

(() => {
  // DOM Elements
  const musicTitleEl = document.getElementById('music-title');
  const musicSubtitleEl = document.getElementById('music-subtitle');
  const partSelectEl = document.getElementById('part-select');
  const sampleSelectEl = document.getElementById('sample-select');
  const fileInputEl = document.getElementById('file-input');
  const browseBtn = document.getElementById('browse-btn');

  const micBtn = document.getElementById('mic-btn');
  const micBtnLabel = document.getElementById('mic-btn-label');
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
  const toggleLabelsEl = document.getElementById('toggle-labels');
  const toggleMetronomeEl = document.getElementById('toggle-metronome');
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
  let currentPart = null;

  let isPlaying = false;
  let currentBeat = 0;
  let baseTempo = 72;
  let tempoPercent = 100;
  let lastFrameTime = null;
  let lastMetronomeBeat = -1;

  // Lightweight Web Audio synth for optional metronome click
  let metroCtx = null;

  function playMetronomeClick(isDownbeat) {
    try {
      if (!metroCtx) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        metroCtx = new AudioContextClass();
      }
      if (metroCtx.state === 'suspended') metroCtx.resume();
      const now = metroCtx.currentTime;
      const osc = metroCtx.createOscillator();
      const gain = metroCtx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(isDownbeat ? 1150 : 820, now);
      gain.gain.setValueAtTime(0.14, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.045);
      osc.connect(gain);
      gain.connect(metroCtx.destination);
      osc.start(now);
      osc.stop(now + 0.05);
    } catch (_) {}
  }

  function getEffectiveBpm() {
    return Math.max(15, Math.round((baseTempo * tempoPercent) / 100));
  }

  function updateTempoDisplay() {
    const bpm = getEffectiveBpm();
    tempoBpmDisplayEl.textContent = `${bpm} BPM (${tempoPercent}%)`;
  }

  function loadScore(score) {
    currentScore = score;
    musicTitleEl.textContent = score.title || 'Untitled Score';

    // Populate part selector if multi-part
    if (score.parts.length > 1) {
      partSelectEl.innerHTML = '';
      score.parts.forEach((p, i) => {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = p.partName;
        partSelectEl.appendChild(opt);
      });
      partSelectEl.value = String(score.defaultPartIndex);
      partSelectEl.classList.remove('hidden');
    } else {
      partSelectEl.classList.add('hidden');
    }

    selectPart(score.defaultPartIndex);
  }

  function selectPart(index) {
    if (!currentScore || !currentScore.parts[index]) return;
    currentPart = currentScore.parts[index];
    staff.setPart(currentPart);

    musicSubtitleEl.textContent = `${currentPart.partName} · ${currentPart.subtitle}`;
    baseTempo = currentPart.initialTempo || 72;
    tempoPercent = 100;
    tempoSliderEl.value = '100';
    updateTempoDisplay();

    resetPlayback();
  }

  function clearNoteEvaluations() {
    if (!currentPart) return;
    for (const n of currentPart.notes) {
      n.evalState = null;
    }
  }

  function resetPlayback() {
    setPlaying(false);
    currentBeat = 0;
    lastMetronomeBeat = -1;
    clearNoteEvaluations();
    syncProgressUI();
  }

  function setPlaying(playing) {
    isPlaying = playing;
    lastFrameTime = null;
    playBtn.classList.toggle('playing', isPlaying);
    playIcon.classList.toggle('hidden', isPlaying);
    pauseIcon.classList.toggle('hidden', !isPlaying);
    playBtnLabel.textContent = isPlaying ? 'Pause' : 'Play';
  }

  function findActiveNote(beat) {
    if (!currentPart) return null;
    // Prefer pitched notes over rests if overlapping
    let foundRest = null;
    for (const n of currentPart.notes) {
      if (beat >= n.startBeat && beat < n.endBeat) {
        if (!n.isRest) return n;
        foundRest = n;
      }
      if (n.startBeat > beat) break;
    }
    return foundRest;
  }

  function findCurrentMeasure(beat) {
    if (!currentPart || currentPart.measures.length === 0) return { number: '1', index: 0, total: 1 };
    for (let i = 0; i < currentPart.measures.length; i++) {
      const m = currentPart.measures[i];
      if (beat >= m.startBeat && beat < m.endBeat) {
        return { number: m.number, index: i, total: currentPart.measures.length, measure: m };
      }
    }
    const last = currentPart.measures[currentPart.measures.length - 1];
    return { number: last.number, index: currentPart.measures.length - 1, total: currentPart.measures.length, measure: last };
  }

  function syncProgressUI() {
    if (!currentPart || currentPart.totalBeats <= 0) {
      progressSliderEl.value = '0';
      measureIndicatorEl.textContent = 'Measure 1 / 1';
      return;
    }
    const pct = Math.max(0, Math.min(100, (currentBeat / currentPart.totalBeats) * 100));
    progressSliderEl.value = pct.toFixed(2);

    const mInfo = findCurrentMeasure(currentBeat);
    measureIndicatorEl.textContent = `Measure ${mInfo.number} / ${mInfo.total}`;
  }

  function updateTunerUI(activeNote, res) {
    // Target note display
    if (activeNote && !activeNote.isRest) {
      targetNoteEl.textContent = activeNote.noteName;
    } else if (activeNote && activeNote.isRest) {
      targetNoteEl.textContent = 'Rest';
    } else {
      targetNoteEl.textContent = '—';
    }

    // Detected note display
    detectedNoteEl.textContent = res.detectedNoteName;

    // Reset all lights
    lightFlatEl.classList.remove('active');
    lightInTuneEl.classList.remove('active');
    lightSharpEl.classList.remove('active');
    lightOffEl.classList.remove('active');

    gaugeNeedleEl.className = 'gauge-needle';
    tunerStatusTextEl.className = 'tuner-status-text';

    if (!res.micOn) {
      gaugeNeedleEl.style.left = '50%';
      tunerStatusTextEl.textContent = 'Mic Off';
      centsReadoutEl.textContent = 'Click Start Tuner';
      return;
    }

    if (res.state === 'silent') {
      gaugeNeedleEl.style.left = '50%';
      tunerStatusTextEl.textContent = 'Listening…';
      centsReadoutEl.textContent = 'Play a note';
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
   * Main animation loop
   */
  function tick(timestamp) {
    if (isPlaying && currentPart) {
      if (lastFrameTime === null) lastFrameTime = timestamp;
      const dtSec = Math.min(0.1, (timestamp - lastFrameTime) / 1000);
      lastFrameTime = timestamp;

      const beatsPerSec = getEffectiveBpm() / 60;
      currentBeat += dtSec * beatsPerSec;

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

      if (currentBeat >= currentPart.totalBeats) {
        currentBeat = currentPart.totalBeats;
        setPlaying(false);
      }

      syncProgressUI();
    }

    const activeNote = findActiveNote(currentBeat);
    const tunerResult = CelloTuner.sample(activeNote);

    // Record intonation state onto the note while it crosses the evaluation line
    if (activeNote && !activeNote.isRest && tunerResult.micOn && tunerResult.state !== 'silent') {
      // Upgrade to 'intune' if the player locks in on the note, otherwise keep latest reading
      if (activeNote.evalState !== 'intune' || tunerResult.state === 'intune') {
        activeNote.evalState = tunerResult.state;
      }
    }

    updateTunerUI(activeNote, tunerResult);
    staff.render(currentBeat, activeNote, tunerResult);

    requestAnimationFrame(tick);
  }

  // ---------- Event Listeners ----------

  // Browse MusicXML file
  browseBtn.addEventListener('click', () => fileInputEl.click());

  fileInputEl.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const score = await MusicXMLParser.parseFile(file);
      loadScore(score);
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
    } catch (err) {
      alert(err.message || 'Failed to parse dropped MusicXML file.');
    }
  });

  // Sample switcher
  sampleSelectEl.addEventListener('change', () => {
    loadBuiltInSample(sampleSelectEl.value);
  });

  // Multi-part switcher
  partSelectEl.addEventListener('change', () => {
    selectPart(parseInt(partSelectEl.value, 10));
  });

  // Mic / Tuner button
  micBtn.addEventListener('click', async () => {
    if (CelloTuner.getActive()) {
      CelloTuner.stop();
      micBtn.classList.remove('active');
      micBtn.setAttribute('aria-pressed', 'false');
      micBtnLabel.textContent = 'Start Tuner';
    } else {
      try {
        await CelloTuner.start();
        micBtn.classList.add('active');
        micBtn.setAttribute('aria-pressed', 'true');
        micBtnLabel.textContent = 'Tuner Active';
      } catch (err) {
        alert(
          'Could not access microphone. Please allow microphone permission in your browser.\n\n' +
          (err.message || '')
        );
      }
    }
  });

  // Play / Pause & Restart
  playBtn.addEventListener('click', () => {
    if (!currentPart) return;
    if (currentBeat >= currentPart.totalBeats) {
      currentBeat = 0;
      clearNoteEvaluations();
    }
    setPlaying(!isPlaying);
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
    if (!currentPart) return;
    const pct = parseFloat(progressSliderEl.value) || 0;
    currentBeat = (pct / 100) * currentPart.totalBeats;
    lastMetronomeBeat = Math.floor(currentBeat);
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
    if (!currentPart) return;
    isDraggingStaff = true;
    dragStartX = e.clientX;
    dragStartBeat = currentBeat;
    staffContainerEl.setPointerCapture(e.pointerId);
  });

  staffContainerEl.addEventListener('pointermove', (e) => {
    if (!isDraggingStaff || !currentPart) return;
    const dx = e.clientX - dragStartX;
    const deltaBeats = -dx / staff.PIXELS_PER_BEAT;
    currentBeat = Math.max(0, Math.min(currentPart.totalBeats, dragStartBeat + deltaBeats));
    lastMetronomeBeat = Math.floor(currentBeat);
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

  // Load built-in sample
  function loadBuiltInSample(key) {
    const xml = key === 'scale'
      ? MusicXMLParser.getSampleScaleXml()
      : MusicXMLParser.getSampleBachXml();
    const score = MusicXMLParser.parseXmlString(xml);
    loadScore(score);
  }

  // Initialize!
  loadBuiltInSample('bach');
  requestAnimationFrame(tick);
})();
