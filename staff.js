/**
 * staff.js
 * High-DPI HTML5 Canvas scrolling musical staff renderer with an evaluation playhead line.
 * Supports Bass, Tenor, Alto, and Treble clefs, key signatures, ledger lines, accidentals,
 * rests, ties, duration ribbons, and live intonation color feedback.
 */

class StaffRenderer {
  constructor(canvas, container) {
    this.canvas = canvas;
    this.container = container;
    this.ctx = canvas.getContext('2d');

    this.LINE_SPACING = 18;
    this.HALF_STEP = this.LINE_SPACING / 2;
    this.PIXELS_PER_BEAT = 115;

    this.width = 900;
    this.height = 310;
    this.dpr = window.devicePixelRatio || 1;

    this.showNoteLabels = true;
    this.part = null;

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

  setPart(part) {
    this.part = part;
  }

  setShowNoteLabels(show) {
    this.showNoteLabels = Boolean(show);
  }

  getLeftMargin(fifths) {
    const accCount = Math.min(Math.abs(fifths || 0), 7);
    return 76 + accCount * 13 + 26;
  }

  getPlayheadX(fifths) {
    const leftMargin = this.getLeftMargin(fifths);
    return Math.max(leftMargin + 72, Math.round(this.width * 0.28));
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
   * Main render pass for a given beat position, active note, and live tuner result.
   */
  render(currentBeat, activeNote, tunerResult) {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;

    // Paper background
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#fbf9f3';
    ctx.fillRect(0, 0, w, h);

    const staffHeight = this.LINE_SPACING * 4;
    const staffTopY = Math.round((h - staffHeight) / 2) - 4;
    const staffBottomY = staffTopY + staffHeight;

    const part = this.part;
    const activeClef = part ? part.clef : { sign: 'F', line: 4 };
    const fifths = part ? part.fifths : 0;
    const leftMargin = this.getLeftMargin(fifths);
    const playheadX = this.getPlayheadX(fifths);

    // 1. Subtle evaluation zone band behind the playhead line
    const zoneColor = this.evalZoneColor(tunerResult, activeNote);
    const grad = ctx.createLinearGradient(playheadX - 24, 0, playheadX + 24, 0);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.5, zoneColor);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(playheadX - 24, 0, 48, h);

    // 2. Five staff lines across full width
    ctx.strokeStyle = '#57534e';
    ctx.lineWidth = 1.25;
    for (let i = 0; i < 5; i++) {
      const y = staffTopY + i * this.LINE_SPACING;
      ctx.beginPath();
      ctx.moveTo(14, y);
      ctx.lineTo(w - 14, y);
      ctx.stroke();
    }

    if (part) {
      const beatToX = (beat) => playheadX + (beat - currentBeat) * this.PIXELS_PER_BEAT;

      // Clip scrolling content to the right of leftMargin
      ctx.save();
      ctx.beginPath();
      ctx.rect(leftMargin - 8, 0, w - (leftMargin - 8), h);
      ctx.clip();

      // 3. Measure barlines, beat ticks, and measure numbers
      for (const m of part.measures) {
        const xStart = beatToX(m.startBeat);
        const xEnd = beatToX(m.endBeat);
        if (xEnd < leftMargin - 40 || xStart > w + 60) continue;

        // Subtle beat subdivisions
        ctx.strokeStyle = 'rgba(120, 113, 108, 0.14)';
        ctx.lineWidth = 1;
        for (let b = 1; b < m.durationBeats; b++) {
          const bx = beatToX(m.startBeat + b);
          if (bx > leftMargin && bx < w) {
            ctx.beginPath();
            ctx.moveTo(bx, staffTopY);
            ctx.lineTo(bx, staffBottomY);
            ctx.stroke();
          }
        }

        // Measure barline
        if (xStart >= leftMargin - 4 && xStart <= w + 20) {
          ctx.strokeStyle = '#44403c';
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo(xStart, staffTopY);
          ctx.lineTo(xStart, staffBottomY);
          ctx.stroke();

          // Measure number
          ctx.fillStyle = '#78716c';
          ctx.font = '600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
          ctx.textAlign = 'left';
          ctx.fillText(`m.${m.number}`, xStart + 5, staffTopY - 26);
        }
      }

      // Final double barline
      const endX = beatToX(part.totalBeats);
      if (endX >= leftMargin && endX <= w + 20) {
        ctx.strokeStyle = '#1c1917';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(endX - 6, staffTopY);
        ctx.lineTo(endX - 6, staffBottomY);
        ctx.stroke();

        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(endX, staffTopY);
        ctx.lineTo(endX, staffBottomY);
        ctx.stroke();
      }

      // 4. Draw notes and rests
      for (const note of part.notes) {
        const x = beatToX(note.startBeat);
        const xEnd = beatToX(note.endBeat);
        if (xEnd < leftMargin - 40 || x > w + 60) continue;

        const isActive = activeNote && note.id === activeNote.id;

        if (note.isRest) {
          this.drawRest(ctx, x, staffTopY, note, isActive);
        } else {
          this.drawNote(ctx, x, xEnd, staffTopY, staffBottomY, note, isActive, tunerResult);
        }
      }

      ctx.restore();
    }

    // 5. Left fixed mask for Clef, Key Signature, and Time Signature
    const maskGrad = ctx.createLinearGradient(leftMargin - 16, 0, leftMargin + 12, 0);
    maskGrad.addColorStop(0, '#fbf9f3');
    maskGrad.addColorStop(0.75, '#fbf9f3');
    maskGrad.addColorStop(1, 'rgba(251, 249, 243, 0)');
    ctx.fillStyle = maskGrad;
    ctx.fillRect(0, 0, leftMargin + 12, h);

    // Re-draw staff lines cleanly inside left header
    ctx.strokeStyle = '#57534e';
    ctx.lineWidth = 1.25;
    for (let i = 0; i < 5; i++) {
      const y = staffTopY + i * this.LINE_SPACING;
      ctx.beginPath();
      ctx.moveTo(14, y);
      ctx.lineTo(leftMargin + 4, y);
      ctx.stroke();
    }

    // Left vertical brace bar
    ctx.strokeStyle = '#292524';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(14, staffTopY);
    ctx.lineTo(14, staffBottomY);
    ctx.stroke();

    // Draw Clef, Key Signature, and Time Signature
    this.drawClef(ctx, 26, staffTopY, activeClef);
    this.drawKeySignature(ctx, 72, staffBottomY, fifths, activeClef);
    if (part && part.timeSig) {
      const timeX = 72 + Math.min(Math.abs(fifths), 7) * 13 + 12;
      this.drawTimeSignature(ctx, timeX, staffTopY, part.timeSig);
    }

    // 6. Prominent Vertical Evaluation Line ("Playhead")
    this.drawPlayhead(ctx, playheadX, h, tunerResult, activeNote);
  }

  evalZoneColor(tunerResult, activeNote) {
    if (!activeNote || activeNote.isRest) return 'rgba(59, 130, 246, 0.08)';
    if (!tunerResult || !tunerResult.micOn || tunerResult.state === 'silent') {
      return 'rgba(59, 130, 246, 0.12)';
    }
    if (tunerResult.state === 'intune') return 'rgba(34, 197, 94, 0.22)';
    if (tunerResult.state === 'flat' || tunerResult.state === 'sharp') return 'rgba(234, 179, 8, 0.22)';
    if (tunerResult.state === 'off') return 'rgba(239, 68, 68, 0.22)';
    return 'rgba(59, 130, 246, 0.12)';
  }

  stateToInkColor(state, isActive) {
    if (state === 'intune') return '#15803d';
    if (state === 'flat' || state === 'sharp') return '#b45309';
    if (state === 'off') return '#dc2626';
    return isActive ? '#1d4ed8' : '#1c1917';
  }

  drawPlayhead(ctx, x, h, tunerResult, activeNote) {
    let lineColor = '#2563eb';
    if (activeNote && !activeNote.isRest && tunerResult && tunerResult.micOn) {
      if (tunerResult.state === 'intune') lineColor = '#16a34a';
      else if (tunerResult.state === 'flat' || tunerResult.state === 'sharp') lineColor = '#d97706';
      else if (tunerResult.state === 'off') lineColor = '#dc2626';
    }

    ctx.save();
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(x, 18);
    ctx.lineTo(x, h - 14);
    ctx.stroke();

    // Top diamond/pointer marker
    ctx.fillStyle = lineColor;
    ctx.beginPath();
    ctx.moveTo(x, 22);
    ctx.lineTo(x - 7, 10);
    ctx.lineTo(x + 7, 10);
    ctx.closePath();
    ctx.fill();

    // Bottom small cap
    ctx.beginPath();
    ctx.arc(x, h - 14, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  drawNote(ctx, x, xEnd, staffTopY, staffBottomY, note, isActive, tunerResult) {
    const y = this.diatonicToY(note.diatonic, note.clef, staffBottomY);

    let effectiveState = note.evalState;
    if (isActive && tunerResult && tunerResult.micOn && tunerResult.state !== 'silent') {
      effectiveState = tunerResult.state;
    }

    const ink = this.stateToInkColor(effectiveState, isActive);

    // Duration sustain ribbon (helps visualize how long to hold the bow!)
    const ribbonW = Math.max(0, xEnd - x - 12);
    if (ribbonW > 6) {
      ctx.save();
      ctx.fillStyle = isActive
        ? this.hexWithAlpha(ink, 0.22)
        : effectiveState
          ? this.hexWithAlpha(ink, 0.12)
          : 'rgba(28, 25, 23, 0.08)';
      ctx.beginPath();
      ctx.roundRect(x + 6, y - 5, ribbonW, 10, 5);
      ctx.fill();
      ctx.restore();
    }

    // Active glow halo behind the notehead
    if (isActive) {
      ctx.save();
      ctx.fillStyle = this.hexWithAlpha(ink, 0.22);
      ctx.beginPath();
      ctx.arc(x, y, 16, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Ledger lines above or below the 5-line staff
    ctx.strokeStyle = '#44403c';
    ctx.lineWidth = 1.4;
    if (y < staffTopY - this.HALF_STEP) {
      for (let ly = staffTopY - this.LINE_SPACING; ly >= y - 1; ly -= this.LINE_SPACING) {
        ctx.beginPath();
        ctx.moveTo(x - 14, ly);
        ctx.lineTo(x + 14, ly);
        ctx.stroke();
      }
    } else if (y > staffBottomY + this.HALF_STEP) {
      for (let ly = staffBottomY + this.LINE_SPACING; ly <= y + 1; ly += this.LINE_SPACING) {
        ctx.beginPath();
        ctx.moveTo(x - 14, ly);
        ctx.lineTo(x + 14, ly);
        ctx.stroke();
      }
    }

    // Accidental to the left of notehead
    if (note.displayAccidental) {
      this.drawAccidental(ctx, x - 19, y, note.displayAccidental, ink);
    }

    // Notehead (hollow for whole/half, filled for quarter and shorter)
    const isHollow = note.type === 'whole' || note.type === 'half';
    const hasStem = note.type !== 'whole';

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-0.24);
    ctx.beginPath();
    ctx.ellipse(0, 0, 8.2, 6.2, 0, 0, Math.PI * 2);
    if (isHollow) {
      ctx.fillStyle = '#fbf9f3';
      ctx.fill();
      ctx.lineWidth = 2.3;
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
      const dotY = onLine ? y - 4 : y;
      ctx.fillStyle = ink;
      for (let d = 0; d < note.dots; d++) {
        ctx.beginPath();
        ctx.arc(x + 13 + d * 6, dotY, 2.3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Stem and Flags
    if (hasStem) {
      const midStaffY = staffTopY + this.LINE_SPACING * 2;
      const stemUp = y >= midStaffY;
      const stemLen = 44;
      const stemX = stemUp ? x + 7.2 : x - 7.2;
      const stemEndY = stemUp ? y - stemLen : y + stemLen;

      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(stemX, y);
      ctx.lineTo(stemX, stemEndY);
      ctx.stroke();

      // Flags for eighth / 16th / 32nd
      const flagCount = note.type === 'eighth' ? 1 : note.type === '16th' ? 2 : note.type === '32nd' ? 3 : 0;
      if (flagCount > 0) {
        ctx.strokeStyle = ink;
        ctx.lineWidth = 2.4;
        for (let f = 0; f < flagCount; f++) {
          const offset = f * 7 * (stemUp ? 1 : -1);
          const fy = stemEndY + offset;
          ctx.beginPath();
          ctx.moveTo(stemX, fy);
          if (stemUp) {
            ctx.quadraticCurveTo(stemX + 11, fy + 6, stemX + 7, fy + 16);
          } else {
            ctx.quadraticCurveTo(stemX + 11, fy - 6, stemX + 7, fy - 16);
          }
          ctx.stroke();
        }
      }
    }

    // Tie arc to next note
    if (note.tieToNext) {
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc((x + xEnd) / 2, y + 8, Math.max(10, (xEnd - x) / 2), 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
    }

    // Optional note name label below the staff
    if (this.showNoteLabels) {
      ctx.fillStyle = isActive ? ink : '#57534e';
      ctx.font = isActive
        ? '700 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
        : '600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      const labelY = Math.max(staffBottomY + 26, y + 24);
      ctx.fillText(note.noteName, x, Math.min(this.height - 10, labelY));
    }
  }

  drawRest(ctx, x, staffTopY, note, isActive) {
    const midY = staffTopY + this.LINE_SPACING * 2;
    ctx.save();
    ctx.fillStyle = isActive ? '#2563eb' : '#57534e';
    ctx.strokeStyle = isActive ? '#2563eb' : '#57534e';

    if (note.type === 'whole') {
      // Hangs from 4th line (staffTopY + LINE_SPACING)
      ctx.fillRect(x - 7, staffTopY + this.LINE_SPACING, 14, 6);
    } else if (note.type === 'half') {
      // Sits on 3rd line (midY)
      ctx.fillRect(x - 7, midY - 6, 14, 6);
    } else if (note.type === 'eighth' || note.type === '16th') {
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x - 3, midY - 6, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x - 1, midY - 6);
      ctx.quadraticCurveTo(x + 6, midY - 4, x + 5, midY - 10);
      ctx.lineTo(x - 2, midY + 12);
      ctx.stroke();
    } else {
      // Quarter rest squiggle
      ctx.lineWidth = 2.4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(x - 3, midY - 14);
      ctx.lineTo(x + 4, midY - 5);
      ctx.lineTo(x - 4, midY + 2);
      ctx.lineTo(x + 3, midY + 10);
      ctx.quadraticCurveTo(x - 4, midY + 11, x - 2, midY + 16);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawAccidental(ctx, x, y, symbol, color) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.font = '700 18px Georgia, "Times New Roman", serif';
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

  /**
   * Draw clean vector Bass, Tenor/Alto, or Treble clef
   */
  drawClef(ctx, x, staffTopY, clef) {
    ctx.save();
    ctx.strokeStyle = '#1c1917';
    ctx.fillStyle = '#1c1917';

    if (!clef || clef.sign === 'F') {
      // Bass Clef: dot on 4th line (staffTopY + LINE_SPACING), curve down, two dots around 4th line
      const fLineY = staffTopY + this.LINE_SPACING;
      ctx.beginPath();
      ctx.arc(x + 7, fLineY + 2, 4.2, 0, Math.PI * 2);
      ctx.fill();

      ctx.lineWidth = 3.2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x + 4, fLineY + 2);
      ctx.bezierCurveTo(x + 2, staffTopY - 4, x + 28, staffTopY - 4, x + 27, fLineY + 8);
      ctx.bezierCurveTo(x + 26, staffTopY + this.LINE_SPACING * 2.7, x + 12, staffTopY + this.LINE_SPACING * 3.5, x + 3, staffTopY + this.LINE_SPACING * 3.85);
      ctx.stroke();

      // Two dots straddling line 4
      ctx.beginPath();
      ctx.arc(x + 34, fLineY - 5.5, 2.5, 0, Math.PI * 2);
      ctx.arc(x + 34, fLineY + 5.5, 2.5, 0, Math.PI * 2);
      ctx.fill();
    } else if (clef.sign === 'C') {
      // Tenor (line 4) or Alto (line 3) C-Clef
      const cY = clef.line === 4
        ? staffTopY + this.LINE_SPACING
        : staffTopY + this.LINE_SPACING * 2;
      ctx.fillRect(x + 4, staffTopY, 4.5, this.LINE_SPACING * 4);
      ctx.fillRect(x + 11, staffTopY, 1.8, this.LINE_SPACING * 4);

      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.moveTo(x + 13, cY);
      ctx.bezierCurveTo(x + 26, cY - 12, x + 28, staffTopY, x + 15, staffTopY + 3);
      ctx.moveTo(x + 13, cY);
      ctx.bezierCurveTo(x + 26, cY + 12, x + 28, staffTopY + this.LINE_SPACING * 4, x + 15, staffTopY + this.LINE_SPACING * 4 - 3);
      ctx.stroke();
    } else {
      // Treble Clef (G clef)
      ctx.font = '76px Georgia, "Times New Roman", serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText('𝄞', x + 2, staffTopY + this.LINE_SPACING * 3.9);
    }

    ctx.restore();
  }

  drawKeySignature(ctx, startX, staffBottomY, fifths, clef) {
    if (!fifths) return;
    const isSharp = fifths > 0;
    const count = Math.min(Math.abs(fifths), 7);

    // Diatonic positions for sharps (F C G D A E B) and flats (B E A D G C F) per clef
    let positions;
    if (!clef || clef.sign === 'F') {
      positions = isSharp
        ? [24, 21, 25, 22, 19, 23, 20] // F3 C3 G3 D3 A2 E3 B2
        : [20, 23, 19, 22, 18, 21, 17]; // B2 E3 A2 D3 G2 C3 F2
    } else if (clef.sign === 'C' && clef.line === 4) {
      positions = isSharp
        ? [24, 28, 25, 29, 26, 30, 27]
        : [27, 30, 26, 29, 25, 28, 24];
    } else {
      // Treble clef
      positions = isSharp
        ? [38, 35, 39, 36, 33, 37, 34] // F5 C5 G5 D5 A4 E5 B4
        : [34, 37, 33, 36, 32, 35, 31]; // B4 E5 A4 D5 G4 C5 F4
    }

    for (let i = 0; i < count; i++) {
      const y = this.diatonicToY(positions[i], clef, staffBottomY);
      this.drawAccidental(ctx, startX + i * 13, y, isSharp ? '#' : 'b', '#1c1917');
    }
  }

  drawTimeSignature(ctx, x, staffTopY, timeSig) {
    ctx.save();
    ctx.fillStyle = '#1c1917';
    ctx.font = '800 26px Georgia, "Times New Roman", serif';
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
