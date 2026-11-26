/**
 * staff.js
 * High-DPI HTML5 Canvas scrolling musical staff renderer supporting 1-line (solo)
 * and 2-line (duet) synchronized scores with an evaluation playhead line.
 * Supports Bass, Tenor, Alto, and Treble clefs, key signatures, ledger lines, accidentals,
 * rests, chords, ties, duration ribbons, and live intonation color feedback on the
 * tuner-selected line.
 */

class StaffRenderer {
  constructor(canvas, container) {
    this.canvas = canvas;
    this.container = container;
    this.ctx = canvas.getContext('2d');

    this.LINE_SPACING = 15;
    this.HALF_STEP = this.LINE_SPACING / 2;
    this.PIXELS_PER_BEAT = 140;

    this.width = 900;
    this.height = 440;
    this.dpr = window.devicePixelRatio || 1;

    this.showNoteLabels = true;
    this.lines = [];
    this.tunerLineIndex = 0;

    this.resize();
  }

  resize() {
    const rect = this.container.getBoundingClientRect();
    this.width = Math.max(320, rect.width);
    this.height = Math.max(240, rect.height);
    this.dpr = window.devicePixelRatio || 1;

    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  setLines(lines) {
    this.lines = Array.isArray(lines) ? lines : [];
    this.LINE_SPACING = this.lines.length >= 2 ? 15 : 18;
    this.HALF_STEP = this.LINE_SPACING / 2;
  }

  setTunerLineIndex(idx) {
    this.tunerLineIndex = idx;
  }

  setShowNoteLabels(show) {
    this.showNoteLabels = Boolean(show);
  }

  getLeftMargin(fifths) {
    const accCount = Math.min(Math.abs(fifths || 0), 7);
    return 72 + accCount * 12 + 26;
  }

  getPlayheadX(fifths) {
    const leftMargin = this.getLeftMargin(fifths);
    return Math.max(leftMargin + 150, Math.round(this.width * 0.34));
  }

  /**
   * Bottom staff line (line 1) diatonic index for a given clef.
   * Diatonic index = octave * 7 + stepIndex (C=0..B=6).
   */
  bottomLineDiatonic(clef) {
    if (!clef) return 18; // Bass clef G2
    if (clef.sign === 'F' && clef.line === 4) return 18; // G2
    if (clef.sign === 'C' && clef.line === 4) return 22; // Tenor: D3
    if (clef.sign === 'C' && clef.line === 3) return 24; // Alto: F3
    if (clef.sign === 'G' && clef.line === 2) return 30; // Treble: E4
    return 18;
  }

  /**
   * Convert a diatonic pitch index to Y coordinate on the canvas.
   */
  diatonicToY(diatonic, clef, staffBottomY) {
    const stepsAboveBottom = diatonic - this.bottomLineDiatonic(clef);
    return staffBottomY - stepsAboveBottom * this.HALF_STEP;
  }

  /**
   * Compute vertical geometry for each staff row so rows align with the left control rail.
   */
  getRowLayouts() {
    const count = Math.max(1, this.lines.length);
    const staffHeight = this.LINE_SPACING * 4;
    const rowHeight = this.height / count;
    const layouts = [];
    for (let i = 0; i < count; i++) {
      const rowTop = i * rowHeight;
      const rowBottom = rowTop + rowHeight;
      const centerY = rowTop + rowHeight / 2;
      const staffTopY = Math.round(centerY - staffHeight / 2);
      const staffBottomY = staffTopY + staffHeight;
      layouts.push({
        index: i,
        rowTop,
        rowBottom,
        rowHeight,
        staffTopY,
        staffBottomY,
      });
    }
    return layouts;
  }

  /**
   * Main render pass for a given beat position, active notes per line, and live tuner result.
   * activeNotesByLine: Array<Array<Note>> (active pitched notes or rest per line)
   */
  render(currentBeat, activeNotesByLine, tunerResult, countInInfo = null) {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;

    // Paper background
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#fbf9f3';
    ctx.fillRect(0, 0, w, h);

    const layouts = this.getRowLayouts();
    const lines = this.lines;
    const primaryLine = lines[0] || null;
    const maxFifths = lines.reduce((m, l) => Math.max(m, Math.abs(l.fifths || 0)), 0);
    const leftMargin = this.getLeftMargin(maxFifths);
    const playheadX = this.getPlayheadX(maxFifths);

    const tunerLineIdx = Math.min(this.tunerLineIndex, Math.max(0, lines.length - 1));
    const tunerActiveNotes = (activeNotesByLine && activeNotesByLine[tunerLineIdx]) || [];
    const primaryTunerNote = tunerActiveNotes.find((n) => !n.isRest) || tunerActiveNotes[0] || null;

    // 1. Subtle row highlight behind the tuner-checked line (in 2-line mode)
    if (lines.length >= 2 && layouts[tunerLineIdx]) {
      const rl = layouts[tunerLineIdx];
      ctx.fillStyle = 'rgba(217, 155, 67, 0.065)';
      ctx.fillRect(0, rl.rowTop, w, rl.rowHeight);

      // Subtle divider between top and bottom row
      ctx.strokeStyle = 'rgba(120, 113, 108, 0.16)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, layouts[0].rowBottom);
      ctx.lineTo(w, layouts[0].rowBottom);
      ctx.stroke();
    }

    // 2. Evaluation zone band behind the playhead line
    for (let i = 0; i < layouts.length; i++) {
      const rl = layouts[i];
      const isTunerRow = i === tunerLineIdx;
      const zoneColor = isTunerRow
        ? this.evalZoneColor(tunerResult, primaryTunerNote)
        : 'rgba(100, 116, 139, 0.07)';
      const grad = ctx.createLinearGradient(playheadX - 24, 0, playheadX + 24, 0);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(0.5, zoneColor);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(playheadX - 24, rl.rowTop, 48, rl.rowHeight);
    }

    // 3. Five staff lines per row across full width
    ctx.strokeStyle = '#57534e';
    ctx.lineWidth = 1.2;
    for (const rl of layouts) {
      for (let s = 0; s < 5; s++) {
        const y = rl.staffTopY + s * this.LINE_SPACING;
        ctx.beginPath();
        ctx.moveTo(14, y);
        ctx.lineTo(w - 14, y);
        ctx.stroke();
      }
    }

    if (primaryLine) {
      const beatToX = (beat) => playheadX + (beat - currentBeat) * this.PIXELS_PER_BEAT;
      const topStaffTopY = layouts[0].staffTopY;
      const bottomStaffBottomY = layouts[layouts.length - 1].staffBottomY;

      // Clip scrolling content to the right of leftMargin
      ctx.save();
      ctx.beginPath();
      ctx.rect(leftMargin - 8, 0, w - (leftMargin - 8), h);
      ctx.clip();

      // 4. Shared measure barlines, beat ticks, and measure numbers
      for (const m of primaryLine.measures) {
        const xStart = beatToX(m.startBeat);
        const xEnd = beatToX(m.endBeat);
        if (xEnd < leftMargin - 40 || xStart > w + 60) continue;

        // Subtle beat subdivisions on each staff
        ctx.strokeStyle = 'rgba(120, 113, 108, 0.13)';
        ctx.lineWidth = 1;
        for (let b = 1; b < m.durationBeats; b++) {
          const bx = beatToX(m.startBeat + b);
          if (bx > leftMargin && bx < w) {
            for (const rl of layouts) {
              ctx.beginPath();
              ctx.moveTo(bx, rl.staffTopY);
              ctx.lineTo(bx, rl.staffBottomY);
              ctx.stroke();
            }
          }
        }

        // Measure barline connecting all staves in the system
        if (xStart >= leftMargin - 4 && xStart <= w + 20) {
          ctx.strokeStyle = '#44403c';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(xStart, topStaffTopY);
          ctx.lineTo(xStart, bottomStaffBottomY);
          ctx.stroke();

          // Measure number above top staff
          ctx.fillStyle = '#78716c';
          ctx.font = '600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
          ctx.textAlign = 'left';
          ctx.fillText(`m.${m.number}`, xStart + 5, Math.max(15, topStaffTopY - 22));
        }
      }

      // Final double barline
      const totalBeats = lines.reduce((mx, l) => Math.max(mx, l.totalBeats), 0);
      const endX = beatToX(totalBeats);
      if (endX >= leftMargin && endX <= w + 20) {
        ctx.strokeStyle = '#1c1917';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(endX - 6, topStaffTopY);
        ctx.lineTo(endX - 6, bottomStaffBottomY);
        ctx.stroke();

        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(endX, topStaffTopY);
        ctx.lineTo(endX, bottomStaffBottomY);
        ctx.stroke();
      }

      // 5. Draw notes and rests for each line
      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        const rl = layouts[lineIdx];
        const isTunerLine = lineIdx === tunerLineIdx;
        const activeIds = new Set(((activeNotesByLine && activeNotesByLine[lineIdx]) || []).map((n) => n.id));

        // Track chord stacking at identical startBeat so note labels don't collide
        let lastChordBeat = -999;
        let chordStackIdx = 0;

        for (const note of line.notes) {
          const x = beatToX(note.startBeat);
          const xEnd = beatToX(note.endBeat);
          if (xEnd < leftMargin - 40 || x > w + 60) continue;

          const isActive = activeIds.has(note.id);

          if (note.isRest) {
            this.drawRest(ctx, x, rl.staffTopY, note, isActive, isTunerLine);
          } else {
            if (Math.abs(note.startBeat - lastChordBeat) < 0.001) {
              chordStackIdx++;
            } else {
              lastChordBeat = note.startBeat;
              chordStackIdx = 0;
            }
            this.drawNote(
              ctx,
              x,
              xEnd,
              rl,
              note,
              isActive,
              isTunerLine,
              isTunerLine ? tunerResult : null,
              chordStackIdx
            );
          }
        }
      }

      ctx.restore();
    }

    // 6. Left fixed mask for Clefs, Key Signatures, and Time Signatures
    const maskGrad = ctx.createLinearGradient(leftMargin - 14, 0, leftMargin + 12, 0);
    maskGrad.addColorStop(0, '#fbf9f3');
    maskGrad.addColorStop(0.75, '#fbf9f3');
    maskGrad.addColorStop(1, 'rgba(251, 249, 243, 0)');
    ctx.fillStyle = maskGrad;
    ctx.fillRect(0, 0, leftMargin + 12, h);

    // Re-apply subtle row tint in left margin for tuner row
    if (lines.length >= 2 && layouts[tunerLineIdx]) {
      const rl = layouts[tunerLineIdx];
      ctx.fillStyle = 'rgba(217, 155, 67, 0.065)';
      ctx.fillRect(0, rl.rowTop, leftMargin + 4, rl.rowHeight);
    }

    // Re-draw staff lines cleanly inside left header
    ctx.strokeStyle = '#57534e';
    ctx.lineWidth = 1.2;
    for (const rl of layouts) {
      for (let s = 0; s < 5; s++) {
        const y = rl.staffTopY + s * this.LINE_SPACING;
        ctx.beginPath();
        ctx.moveTo(14, y);
        ctx.lineTo(leftMargin + 4, y);
        ctx.stroke();
      }
    }

    // Left vertical system bar connecting staves
    ctx.strokeStyle = '#292524';
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.moveTo(14, layouts[0].staffTopY);
    ctx.lineTo(14, layouts[layouts.length - 1].staffBottomY);
    ctx.stroke();

    // Draw bracket tips for 2-line duet system
    if (layouts.length >= 2) {
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(8, layouts[0].staffTopY - 4);
      ctx.lineTo(15, layouts[0].staffTopY);
      ctx.moveTo(8, layouts[layouts.length - 1].staffBottomY + 4);
      ctx.lineTo(15, layouts[layouts.length - 1].staffBottomY);
      ctx.stroke();
    }

    // Draw Clef, Key Signature, and Time Signature for each line
    for (let i = 0; i < layouts.length; i++) {
      const rl = layouts[i];
      const line = lines[i];
      const activeClef = line ? line.clef : { sign: 'F', line: 4 };
      const fifths = line ? line.fifths : 0;

      this.drawClef(ctx, 22, rl.staffTopY, activeClef);
      this.drawKeySignature(ctx, 64, rl.staffBottomY, fifths, activeClef);
      if (line && line.timeSig) {
        const timeX = 64 + Math.min(Math.abs(fifths), 7) * 12 + 12;
        this.drawTimeSignature(ctx, timeX, rl.staffTopY, line.timeSig);
      }
    }

    // 7. Prominent Vertical Evaluation Line ("Playhead")
    this.drawPlayhead(ctx, playheadX, h, tunerResult, primaryTunerNote);

    // 8. Optional 2-Measure Count-In Visual Badge over the playhead
    if (countInInfo) {
      this.drawCountInBadge(ctx, playheadX, h, countInInfo);
    }
  }

  drawCountInBadge(ctx, playheadX, h, info) {
    ctx.save();
    const boxW = 166;
    const boxH = 66;
    const cx = Math.max(boxW / 2 + 12, Math.min(this.width - boxW / 2 - 12, playheadX));
    const cy = Math.round(h * 0.5);
    const x = Math.round(cx - boxW / 2);
    const y = Math.round(cy - boxH / 2);

    // Subtle pulse on each beat
    const pulse = Math.max(0, 1 - (info.beatProgress || 0) * 2.5);
    const isDownbeat = info.beat === 1;

    ctx.shadowColor = 'rgba(0, 0, 0, 0.28)';
    ctx.shadowBlur = 16;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = 'rgba(17, 19, 25, 0.92)';
    ctx.beginPath();
    ctx.roundRect(x, y, boxW, boxH, 14);
    ctx.fill();

    ctx.shadowColor = 'transparent';
    ctx.lineWidth = isDownbeat ? 2.5 : 1.8;
    ctx.strokeStyle = isDownbeat
      ? `rgba(217, 155, 67, ${0.7 + 0.3 * pulse})`
      : `rgba(59, 130, 246, ${0.55 + 0.35 * pulse})`;
    ctx.stroke();

    // Header: COUNT-IN · BAR 1 OF 2
    ctx.fillStyle = isDownbeat ? '#f5c26b' : '#93c5fd';
    ctx.font = '700 10.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`COUNT-IN · BAR ${info.bar} OF ${info.totalBars}`, cx, y + 18);

    // Big beat number + beat dots
    ctx.fillStyle = '#ffffff';
    ctx.font = `800 ${Math.round(24 + pulse * 3)}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx.fillText(String(info.beat), cx - 34, y + 45);

    const dotsCount = Math.min(8, Math.max(1, info.beatsPerMeasure || 4));
    const dotSpacing = 14;
    const dotsStartX = cx - 4;
    for (let i = 1; i <= dotsCount; i++) {
      const dx = dotsStartX + (i - 1) * dotSpacing;
      const dy = y + 45;
      ctx.beginPath();
      ctx.arc(dx, dy, i === info.beat ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = i === info.beat
        ? (isDownbeat ? '#f59e0b' : '#3b82f6')
        : i < info.beat
          ? 'rgba(255, 255, 255, 0.45)'
          : 'rgba(255, 255, 255, 0.16)';
      ctx.fill();
    }
    ctx.restore();
  }

  evalZoneColor(tunerResult, activeNote) {
    if (!activeNote || activeNote.isRest) return 'rgba(59, 130, 246, 0.08)';
    if (!tunerResult || !tunerResult.micOn || tunerResult.state === 'silent' || tunerResult.state === 'suspended' || tunerResult.state === 'nosignal') {
      return 'rgba(59, 130, 246, 0.13)';
    }
    if (tunerResult.state === 'intune') return 'rgba(34, 197, 94, 0.26)';
    if (tunerResult.state === 'flat') return 'rgba(250, 204, 21, 0.34)';
    if (tunerResult.state === 'sharp') return 'rgba(249, 115, 22, 0.28)';
    if (tunerResult.state === 'off') return 'rgba(239, 68, 68, 0.26)';
    return 'rgba(59, 130, 246, 0.12)';
  }

  stateToHighlightColor(state) {
    if (state === 'intune') return '#22c55e'; // Green
    if (state === 'flat') return '#facc15';   // Yellow
    if (state === 'sharp') return '#f97316';  // Orange
    if (state === 'off') return '#ef4444';    // Red
    return null;
  }

  stateToInkColor(state, isActive, isTunerLine) {
    if (isTunerLine) {
      if (state === 'intune') return '#15803d'; // Rich green
      if (state === 'flat') return '#a16207';   // Crisp golden-yellow outline/stem
      if (state === 'sharp') return '#c2410c';  // Deep orange outline/stem
      if (state === 'off') return '#dc2626';    // Vivid red
      return isActive ? '#1d4ed8' : '#1c1917';
    }
    // Non-tuner accompaniment line: calm highlight when active
    return isActive ? '#9a5b13' : '#3f3b37';
  }

  drawPlayhead(ctx, x, h, tunerResult, activeNote) {
    let lineColor = '#2563eb';
    if (activeNote && !activeNote.isRest && tunerResult && tunerResult.micOn) {
      if (tunerResult.state === 'intune') lineColor = '#16a34a';
      else if (tunerResult.state === 'flat') lineColor = '#eab308';
      else if (tunerResult.state === 'sharp') lineColor = '#f97316';
      else if (tunerResult.state === 'off') lineColor = '#dc2626';
    }

    ctx.save();
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(x, 16);
    ctx.lineTo(x, h - 12);
    ctx.stroke();

    // Top pointer marker
    ctx.fillStyle = lineColor;
    ctx.beginPath();
    ctx.moveTo(x, 20);
    ctx.lineTo(x - 7, 8);
    ctx.lineTo(x + 7, 8);
    ctx.closePath();
    ctx.fill();

    // Bottom cap
    ctx.beginPath();
    ctx.arc(x, h - 12, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  drawNote(ctx, x, xEnd, rl, note, isActive, isTunerLine, tunerResult, chordStackIdx) {
    const { staffTopY, staffBottomY, rowBottom } = rl;
    const y = this.diatonicToY(note.diatonic, note.clef, staffBottomY);

    let effectiveState = isTunerLine ? note.evalState : null;
    if (
      isTunerLine &&
      isActive &&
      tunerResult &&
      tunerResult.micOn &&
      tunerResult.state !== 'silent' &&
      tunerResult.state !== 'suspended' &&
      tunerResult.state !== 'nosignal'
    ) {
      effectiveState = tunerResult.state;
    }

    const ink = this.stateToInkColor(effectiveState, isActive, isTunerLine);
    const highlight = isTunerLine ? this.stateToHighlightColor(effectiveState) : null;
    const scale = this.LINE_SPACING / 18;

    // Duration sustain ribbon (extends nearly the full duration up to the next note)
    const ribbonW = Math.max(0, xEnd - x - 2);
    if (ribbonW > 6) {
      ctx.save();
      const ribbonBase = highlight || ink;
      const ribbonAlpha = isActive
        ? (effectiveState === 'flat' ? 0.58 : 0.42)
        : effectiveState
          ? (effectiveState === 'flat' ? 0.42 : 0.28)
          : 0.085;
      ctx.fillStyle = (isActive || effectiveState)
        ? this.hexWithAlpha(ribbonBase, ribbonAlpha)
        : 'rgba(28, 25, 23, 0.085)';
      ctx.beginPath();
      ctx.roundRect(x + 4, y - 6.5, ribbonW, 13, 6.5);
      ctx.fill();
      ctx.restore();
    }

    // Prominent intonation highlight halo around the notehead (green / yellow / orange / red)
    if (isActive || highlight) {
      ctx.save();
      const haloColor = highlight || ink;
      const haloRadius = isActive ? (17 * scale + 3) : (12.5 * scale + 1.5);
      const fillAlpha = isActive
        ? (effectiveState === 'flat' ? 0.56 : highlight ? 0.36 : (isTunerLine ? 0.22 : 0.14))
        : (effectiveState === 'flat' ? 0.36 : 0.22);

      ctx.fillStyle = this.hexWithAlpha(haloColor, fillAlpha);
      ctx.beginPath();
      ctx.arc(x, y, haloRadius, 0, Math.PI * 2);
      ctx.fill();

      // Crisp colored ring on active evaluated note so it's unmistakable in peripheral vision
      if (isActive && highlight) {
        ctx.strokeStyle = effectiveState === 'flat' ? '#eab308' : highlight;
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.arc(x, y, haloRadius, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Ledger lines above or below the 5-line staff
    ctx.strokeStyle = '#44403c';
    ctx.lineWidth = 1.3;
    if (y < staffTopY - this.HALF_STEP) {
      for (let ly = staffTopY - this.LINE_SPACING; ly >= y - 1; ly -= this.LINE_SPACING) {
        ctx.beginPath();
        ctx.moveTo(x - 13, ly);
        ctx.lineTo(x + 13, ly);
        ctx.stroke();
      }
    } else if (y > staffBottomY + this.HALF_STEP) {
      for (let ly = staffBottomY + this.LINE_SPACING; ly <= y + 1; ly += this.LINE_SPACING) {
        ctx.beginPath();
        ctx.moveTo(x - 13, ly);
        ctx.lineTo(x + 13, ly);
        ctx.stroke();
      }
    }

    // Accidental to the left of notehead
    if (note.displayAccidental) {
      this.drawAccidental(ctx, x - 17, y, note.displayAccidental, ink);
    }

    // Notehead
    const isHollow = note.type === 'whole' || note.type === 'half';
    const hasStem = note.type !== 'whole';

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-0.24);
    ctx.beginPath();
    ctx.ellipse(0, 0, 7.6 * scale + 0.5, 5.6 * scale + 0.5, 0, 0, Math.PI * 2);
    if (isHollow) {
      ctx.fillStyle = highlight
        ? this.hexWithAlpha(highlight, effectiveState === 'flat' ? 0.62 : 0.34)
        : '#fbf9f3';
      ctx.fill();
      ctx.lineWidth = highlight ? 2.4 : 2.1;
      ctx.strokeStyle = ink;
      ctx.stroke();
    } else if (highlight) {
      ctx.fillStyle = highlight;
      ctx.fill();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = ink;
      ctx.stroke();
    } else {
      ctx.fillStyle = ink;
      ctx.fill();
    }
    ctx.restore();

    // Augmentation dot(s)
    if (note.dots > 0) {
      const onLine = Math.abs(Math.round((staffBottomY - y) / this.HALF_STEP)) % 2 === 0;
      const dotY = onLine ? y - 3.5 : y;
      ctx.fillStyle = ink;
      for (let d = 0; d < note.dots; d++) {
        ctx.beginPath();
        ctx.arc(x + 12 + d * 5.5, dotY, 2.1, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Stem and Flags (skip duplicate stem on chord siblings)
    if (hasStem && !note.isChord) {
      const midStaffY = staffTopY + this.LINE_SPACING * 2;
      const stemUp = y >= midStaffY;
      const stemLen = Math.round(38 * scale + 4);
      const stemX = stemUp ? x + 6.6 : x - 6.6;
      const stemEndY = stemUp ? y - stemLen : y + stemLen;

      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.7;
      ctx.beginPath();
      ctx.moveTo(stemX, y);
      ctx.lineTo(stemX, stemEndY);
      ctx.stroke();

      const flagCount = note.type === 'eighth' ? 1 : note.type === '16th' ? 2 : note.type === '32nd' ? 3 : 0;
      if (flagCount > 0) {
        ctx.strokeStyle = ink;
        ctx.lineWidth = 2.2;
        for (let f = 0; f < flagCount; f++) {
          const offset = f * 6.5 * (stemUp ? 1 : -1);
          const fy = stemEndY + offset;
          ctx.beginPath();
          ctx.moveTo(stemX, fy);
          if (stemUp) {
            ctx.quadraticCurveTo(stemX + 10, fy + 5, stemX + 6, fy + 14);
          } else {
            ctx.quadraticCurveTo(stemX + 10, fy - 5, stemX + 6, fy - 14);
          }
          ctx.stroke();
        }
      }
    }

    // Tie arc to next note
    if (note.tieToNext) {
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc((x + xEnd) / 2, y + 7, Math.max(9, (xEnd - x) / 2), 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
    }

    // Optional note name label below the staff
    if (this.showNoteLabels) {
      ctx.fillStyle = isActive ? ink : '#57534e';
      ctx.font = isActive
        ? '700 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
        : '600 10.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      const baseLabelY = Math.max(staffBottomY + 22, y + 19);
      const labelY = Math.min(rowBottom - 8 - chordStackIdx * 12, baseLabelY + chordStackIdx * 12);
      ctx.fillText(note.noteName, x, labelY);
    }
  }

  drawRest(ctx, x, staffTopY, note, isActive, isTunerLine) {
    const midY = staffTopY + this.LINE_SPACING * 2;
    ctx.save();
    const color = isActive ? (isTunerLine ? '#2563eb' : '#9a5b13') : '#57534e';
    ctx.fillStyle = color;
    ctx.strokeStyle = color;

    if (note.type === 'whole') {
      ctx.fillRect(x - 7, staffTopY + this.LINE_SPACING, 14, 5.5);
    } else if (note.type === 'half') {
      ctx.fillRect(x - 7, midY - 5.5, 14, 5.5);
    } else if (note.type === 'eighth' || note.type === '16th') {
      ctx.lineWidth = 1.9;
      ctx.beginPath();
      ctx.arc(x - 3, midY - 5, 2.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x - 1, midY - 5);
      ctx.quadraticCurveTo(x + 5, midY - 3, x + 4.5, midY - 9);
      ctx.lineTo(x - 2, midY + 10);
      ctx.stroke();
    } else {
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(x - 3, midY - 12);
      ctx.lineTo(x + 3.5, midY - 4);
      ctx.lineTo(x - 3.5, midY + 2);
      ctx.lineTo(x + 3, midY + 9);
      ctx.quadraticCurveTo(x - 3.5, midY + 10, x - 2, midY + 14);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawAccidental(ctx, x, y, symbol, color) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.font = '700 16px Georgia, "Times New Roman", serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const glyph = symbol === '#' ? '♯'
      : symbol === 'b' ? '♭'
      : symbol === 'n' ? '♮'
      : symbol === '##' ? '𝄪'
      : symbol === 'bb' ? '♭♭'
      : '';
    ctx.fillText(glyph, x, y + 1);
    ctx.restore();
  }

  drawClef(ctx, x, staffTopY, clef) {
    ctx.save();
    ctx.strokeStyle = '#1c1917';
    ctx.fillStyle = '#1c1917';
    const sp = this.LINE_SPACING;

    if (!clef || clef.sign === 'F') {
      const fLineY = staffTopY + sp;
      ctx.beginPath();
      ctx.arc(x + 6, fLineY + 1.5, 3.6, 0, Math.PI * 2);
      ctx.fill();

      ctx.lineWidth = 2.9;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x + 3.5, fLineY + 1.5);
      ctx.bezierCurveTo(x + 2, staffTopY - 3, x + 24, staffTopY - 3, x + 23, fLineY + 7);
      ctx.bezierCurveTo(x + 22, staffTopY + sp * 2.7, x + 11, staffTopY + sp * 3.5, x + 3, staffTopY + sp * 3.85);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(x + 29, fLineY - 4.8, 2.2, 0, Math.PI * 2);
      ctx.arc(x + 29, fLineY + 4.8, 2.2, 0, Math.PI * 2);
      ctx.fill();
    } else if (clef.sign === 'C') {
      const cY = clef.line === 4 ? staffTopY + sp : staffTopY + sp * 2;
      ctx.fillRect(x + 3, staffTopY, 4, sp * 4);
      ctx.fillRect(x + 9.5, staffTopY, 1.6, sp * 4);

      ctx.lineWidth = 2.3;
      ctx.beginPath();
      ctx.moveTo(x + 11, cY);
      ctx.bezierCurveTo(x + 22, cY - 10, x + 24, staffTopY, x + 13, staffTopY + 3);
      ctx.moveTo(x + 11, cY);
      ctx.bezierCurveTo(x + 22, cY + 10, x + 24, staffTopY + sp * 4, x + 13, staffTopY + sp * 4 - 3);
      ctx.stroke();
    } else {
      ctx.font = `${Math.round(sp * 4.2)}px Georgia, "Times New Roman", serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText('𝄞', x + 2, staffTopY + sp * 3.9);
    }

    ctx.restore();
  }

  drawKeySignature(ctx, startX, staffBottomY, fifths, clef) {
    if (!fifths) return;
    const isSharp = fifths > 0;
    const count = Math.min(Math.abs(fifths), 7);

    let positions;
    if (!clef || clef.sign === 'F') {
      positions = isSharp
        ? [24, 21, 25, 22, 19, 23, 20]
        : [20, 23, 19, 22, 18, 21, 17];
    } else if (clef.sign === 'C' && clef.line === 4) {
      positions = isSharp
        ? [24, 28, 25, 29, 26, 30, 27]
        : [27, 30, 26, 29, 25, 28, 24];
    } else {
      positions = isSharp
        ? [38, 35, 39, 36, 33, 37, 34]
        : [34, 37, 33, 36, 32, 35, 31];
    }

    for (let i = 0; i < count; i++) {
      const y = this.diatonicToY(positions[i], clef, staffBottomY);
      this.drawAccidental(ctx, startX + i * 12, y, isSharp ? '#' : 'b', '#1c1917');
    }
  }

  drawTimeSignature(ctx, x, staffTopY, timeSig) {
    ctx.save();
    ctx.fillStyle = '#1c1917';
    ctx.font = `800 ${Math.round(this.LINE_SPACING * 1.45)}px Georgia, "Times New Roman", serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(timeSig.beats), x, staffTopY + this.LINE_SPACING * 1.05);
    ctx.fillText(String(timeSig.beatType), x, staffTopY + this.LINE_SPACING * 3.05);
    ctx.restore();
  }

  hexWithAlpha(hex, alpha) {
    const clean = hex.replace('#', '');
    const r = parseInt(clean.substring(0, 2), 16);
    const g = parseInt(clean.substring(2, 4), 16);
    const b = parseInt(clean.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
}
