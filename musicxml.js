/**
 * musicxml.js
 * Parses .xml, .musicxml, and compressed .mxl files into structured lines (1-line solo or 2-line duets)
 * supporting both single-part multi-staff (<staves>2</staves>, e.g., Soundslice Piatti exports)
 * and multi-part (<part id="P1">, <part id="P2">) MusicXML scores.
 */

const MusicXMLParser = (() => {
  const STEP_TO_SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const STEP_TO_DIATONIC = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };

  const KEY_NAMES_MAJOR = {
    '-7': 'Cb Major', '-6': 'Gb Major', '-5': 'Db Major', '-4': 'Ab Major',
    '-3': 'Eb Major', '-2': 'Bb Major', '-1': 'F Major', '0': 'C Major',
    '1': 'G Major', '2': 'D Major', '3': 'A Major', '4': 'E Major',
    '5': 'B Major', '6': 'F# Major', '7': 'C# Major',
  };

  // Sharp order: F C G D A E B ; Flat order: B E A D G C F
  const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
  const FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];

  function keySignatureMap(fifths) {
    const map = { C: 0, D: 0, E: 0, F: 0, G: 0, A: 0, B: 0 };
    if (fifths > 0) {
      for (let i = 0; i < Math.min(fifths, 7); i++) map[SHARP_ORDER[i]] = 1;
    } else if (fifths < 0) {
      for (let i = 0; i < Math.min(-fifths, 7); i++) map[FLAT_ORDER[i]] = -1;
    }
    return map;
  }

  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  function formatNoteName(step, alter, octave) {
    let acc = '';
    if (alter === 1) acc = '#';
    else if (alter === 2) acc = '##';
    else if (alter === -1) acc = 'b';
    else if (alter === -2) acc = 'bb';
    return `${step}${acc}${octave}`;
  }

  function clefLabel(clef) {
    if (!clef) return 'Bass Clef';
    if (clef.sign === 'F' && clef.line === 4) return 'Bass Clef';
    if (clef.sign === 'C' && clef.line === 4) return 'Tenor Clef';
    if (clef.sign === 'C' && clef.line === 3) return 'Alto Clef';
    if (clef.sign === 'G' && clef.line === 2) return 'Treble Clef';
    return `${clef.sign} Clef`;
  }

  /**
   * Minimal ZIP extractor for .mxl (compressed MusicXML) files using native DecompressionStream.
   */
  async function extractMxlToXmlString(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    const bytes = new Uint8Array(arrayBuffer);
    const decoder = new TextDecoder('utf-8');
    const entries = new Map();

    // Locate End of Central Directory (EOCD) signature 0x06054b50
    let eocdOffset = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset === -1) {
      throw new Error('Invalid .mxl archive (missing ZIP directory).');
    }

    const cdOffset = view.getUint32(eocdOffset + 16, true);
    const cdCount = view.getUint16(eocdOffset + 10, true);
    let pos = cdOffset;

    for (let i = 0; i < cdCount; i++) {
      if (view.getUint32(pos, true) !== 0x02014b50) break;
      const compressionMethod = view.getUint16(pos + 10, true);
      const compSize = view.getUint32(pos + 20, true);
      const nameLen = view.getUint16(pos + 28, true);
      const extraLen = view.getUint16(pos + 30, true);
      const commentLen = view.getUint16(pos + 32, true);
      const localHeaderOffset = view.getUint32(pos + 42, true);
      const fileName = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));

      const lhNameLen = view.getUint16(localHeaderOffset + 26, true);
      const lhExtraLen = view.getUint16(localHeaderOffset + 28, true);
      const dataStart = localHeaderOffset + 30 + lhNameLen + lhExtraLen;
      const rawData = bytes.subarray(dataStart, dataStart + compSize);

      entries.set(fileName, { compressionMethod, rawData });
      pos += 46 + nameLen + extraLen + commentLen;
    }

    async function readEntryText(name) {
      const entry = entries.get(name);
      if (!entry) return null;
      if (entry.compressionMethod === 0) {
        return decoder.decode(entry.rawData);
      }
      if (entry.compressionMethod === 8) {
        if (typeof DecompressionStream === 'undefined') {
          throw new Error('Your browser does not support .mxl decompression. Please export as uncompressed .musicxml or .xml.');
        }
        const ds = new DecompressionStream('deflate-raw');
        const stream = new Blob([entry.rawData]).stream().pipeThrough(ds);
        return await new Response(stream).text();
      }
      throw new Error(`Unsupported ZIP compression method (${entry.compressionMethod}) in .mxl file.`);
    }

    // Check META-INF/container.xml for rootfile path
    const containerXml = await readEntryText('META-INF/container.xml');
    if (containerXml) {
      const containerDoc = new DOMParser().parseFromString(containerXml, 'application/xml');
      const rootfile = containerDoc.querySelector('rootfile');
      const fullPath = rootfile && rootfile.getAttribute('full-path');
      if (fullPath && entries.has(fullPath)) {
        return await readEntryText(fullPath);
      }
    }

    // Fallback: first .xml or .musicxml file not in META-INF
    for (const key of entries.keys()) {
      if (!key.startsWith('META-INF/') && /\.(musicxml|xml)$/i.test(key)) {
        return await readEntryText(key);
      }
    }
    throw new Error('No MusicXML score found inside .mxl archive.');
  }

  /**
   * Parse a File object (.xml, .musicxml, or .mxl)
   */
  async function parseFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    let xmlText;
    if (ext === 'mxl') {
      const buffer = await file.arrayBuffer();
      xmlText = await extractMxlToXmlString(buffer);
    } else {
      xmlText = await file.text();
    }
    const fallbackTitle = file.name.replace(/\.(musicxml|xml|mxl)$/i, '');
    const score = parseXmlString(xmlText, fallbackTitle, file.name);
    score.rawXml = xmlText;
    return score;
  }

  /**
   * Parse raw MusicXML text into a structured score object with 1 or 2 (or more) lines.
   */
  function parseXmlString(xmlText, fallbackTitle = 'Untitled Score', fileName = null) {
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    const parseErr = doc.querySelector('parsererror');
    if (parseErr) {
      throw new Error('Could not parse MusicXML file. Please verify it is a valid MusicXML document.');
    }

    // Title detection
    const workTitle = doc.querySelector('work > work-title')?.textContent?.trim();
    const movementTitle = doc.querySelector('movement-title')?.textContent?.trim();
    const creditTitle = doc.querySelector('credit > credit-words')?.textContent?.trim();
    const title = [workTitle, movementTitle].filter(Boolean).join(' — ') || creditTitle || fallbackTitle;

    // Collect parts metadata
    const scoreParts = Array.from(doc.querySelectorAll('part-list > score-part'));
    const partNameMap = new Map();
    scoreParts.forEach((sp) => {
      const id = sp.getAttribute('id');
      const name = sp.querySelector('part-name')?.textContent?.trim() || id;
      partNameMap.set(id, name);
    });

    const partEls = Array.from(doc.querySelectorAll('score-partwise > part'));
    if (partEls.length === 0) {
      throw new Error('No <part> elements found. Only score-partwise MusicXML files are supported.');
    }

    // Extract all lines across all parts (expanding multi-staff parts like <staves>2</staves>)
    const allLines = [];
    partEls.forEach((partEl, idx) => {
      const id = partEl.getAttribute('id') || `P${idx + 1}`;
      const name = partNameMap.get(id) || `Part ${idx + 1}`;
      const partLines = parsePartIntoLines(partEl, id, name, title);
      allLines.push(...partLines);
    });

    // Pick up to 2 primary lines to display (preferring Cello lines if >2 exist)
    let displayLines = allLines;
    if (allLines.length > 2) {
      const celloLines = allLines.filter((l) => /cello|violoncello|vc\b/i.test(l.partName));
      displayLines = celloLines.length >= 2 ? celloLines.slice(0, 2) : allLines.slice(0, 2);
    }

    // Assign clean short labels for UI
    displayLines.forEach((line, idx) => {
      line.lineIndex = idx;
      if (displayLines.length === 1) {
        line.displayLabel = line.shortLabel || 'Line 1';
      } else {
        line.displayLabel = line.shortLabel || `Line ${idx + 1}`;
      }
    });

    const totalBeats = displayLines.reduce((max, l) => Math.max(max, l.totalBeats), 0);
    const initialTempo = displayLines[0]?.initialTempo || 72;
    const primary = displayLines[0];
    const lineCountLabel = displayLines.length === 2 ? 'Duet (2 Lines)' : 'Solo (1 Line)';
    const subtitle = primary
      ? `${lineCountLabel} · ${primary.subtitle}`
      : lineCountLabel;

    return {
      title,
      fileName,
      lines: displayLines,
      allLines,
      totalBeats,
      initialTempo,
      subtitle,
    };
  }

  /**
   * Parses a single <part> element into 1 or more line objects (one per staff if <staves> > 1).
   */
  function parsePartIntoLines(partEl, partId, partName, title) {
    const measureEls = Array.from(partEl.querySelectorAll(':scope > measure'));

    // Detect how many staves this part uses
    let staffCount = 1;
    const stavesEl = partEl.querySelector('attributes > staves');
    if (stavesEl) {
      staffCount = Math.max(1, parseInt(stavesEl.textContent, 10) || 1);
    }
    if (staffCount === 1) {
      const hasStaff2 = Boolean(partEl.querySelector('note > staff'));
      if (hasStaff2) {
        for (const sEl of partEl.querySelectorAll('note > staff')) {
          const n = parseInt(sEl.textContent, 10);
          if (n > staffCount) staffCount = n;
        }
      }
    }
    // Cap at 2 staves per part for duet rendering
    staffCount = Math.min(2, staffCount);

    let divisions = 1;
    let fifths = 0;
    let timeSig = { beats: 4, beatType: 4 };
    const clefByStaff = {};
    for (let s = 1; s <= staffCount; s++) {
      clefByStaff[String(s)] = { sign: 'F', line: 4 }; // Default bass clef for cello
    }

    let initialTempo = 72;
    let foundTempo = false;

    const notesByStaff = {};
    const measuresByStaff = {};
    const activeTiesByStaff = {};
    for (let s = 1; s <= staffCount; s++) {
      const key = String(s);
      notesByStaff[key] = [];
      measuresByStaff[key] = [];
      activeTiesByStaff[key] = new Map();
    }

    let currentMeasureStartBeat = 0;

    measureEls.forEach((mEl, mIdx) => {
      const mNum = mEl.getAttribute('number') || String(mIdx + 1);
      let cursorDiv = 0;
      let lastNoteStartDiv = 0;
      let maxDivInMeasure = 0;

      const keyAccMap = keySignatureMap(fifths);
      const measureAccStateByStaff = {};
      const measureClefByStaff = {};
      const primaryVoiceByStaff = {};
      const rawRestsByStaff = {};
      const pitchedIntervalsByStaff = {};

      for (let s = 1; s <= staffCount; s++) {
        const key = String(s);
        measureAccStateByStaff[key] = new Map();
        measureClefByStaff[key] = { ...clefByStaff[key] };
        primaryVoiceByStaff[key] = null;
        rawRestsByStaff[key] = [];
        pitchedIntervalsByStaff[key] = [];
      }

      let measureFifths = fifths;
      let measureTimeSig = { ...timeSig };

      const children = Array.from(mEl.children);
      for (const child of children) {
        const tag = child.tagName;

        if (tag === 'attributes') {
          const divEl = child.querySelector('divisions');
          if (divEl) divisions = Math.max(1, parseFloat(divEl.textContent) || 1);

          const fifthsEl = child.querySelector('key > fifths');
          if (fifthsEl) {
            fifths = parseInt(fifthsEl.textContent, 10) || 0;
            measureFifths = fifths;
            Object.assign(keyAccMap, keySignatureMap(fifths));
          }

          const beatsEl = child.querySelector('time > beats');
          const beatTypeEl = child.querySelector('time > beat-type');
          if (beatsEl && beatTypeEl) {
            timeSig = {
              beats: parseInt(beatsEl.textContent, 10) || 4,
              beatType: parseInt(beatTypeEl.textContent, 10) || 4,
            };
            measureTimeSig = { ...timeSig };
          }

          const clefEls = Array.from(child.querySelectorAll('clef'));
          for (const clefEl of clefEls) {
            const cNum = clefEl.getAttribute('number') || '1';
            const sign = clefEl.querySelector('sign')?.textContent?.trim() || 'F';
            const line = parseInt(clefEl.querySelector('line')?.textContent, 10) ||
              (sign === 'F' ? 4 : sign === 'G' ? 2 : 4);
            if (clefByStaff[cNum]) {
              clefByStaff[cNum] = { sign, line };
              measureClefByStaff[cNum] = { sign, line };
            }
          }
        } else if (tag === 'direction') {
          const soundEl = child.querySelector('sound[tempo]');
          if (soundEl && !foundTempo) {
            const t = parseFloat(soundEl.getAttribute('tempo'));
            if (t > 15 && t < 320) {
              initialTempo = Math.round(t);
              foundTempo = true;
            }
          }
          const perMin = child.querySelector('metronome > per-minute');
          if (perMin && !foundTempo) {
            const t = parseFloat(perMin.textContent);
            if (t > 15 && t < 320) {
              initialTempo = Math.round(t);
              foundTempo = true;
            }
          }
        } else if (tag === 'sound') {
          const t = parseFloat(child.getAttribute('tempo'));
          if (t > 15 && t < 320 && !foundTempo) {
            initialTempo = Math.round(t);
            foundTempo = true;
          }
        } else if (tag === 'backup') {
          const dur = parseFloat(child.querySelector('duration')?.textContent) || 0;
          cursorDiv = Math.max(0, cursorDiv - dur);
        } else if (tag === 'forward') {
          const dur = parseFloat(child.querySelector('duration')?.textContent) || 0;
          cursorDiv += dur;
          if (cursorDiv > maxDivInMeasure) maxDivInMeasure = cursorDiv;
        } else if (tag === 'note') {
          // Skip grace notes
          if (child.querySelector('grace')) continue;

          const isChord = Boolean(child.querySelector('chord'));
          const isRest = Boolean(child.querySelector('rest'));
          const voice = child.querySelector('voice')?.textContent?.trim() || '1';
          const staffNum = child.querySelector('staff')?.textContent?.trim() || '1';
          const durDiv = parseFloat(child.querySelector('duration')?.textContent) || 0;
          const noteStartDiv = isChord ? lastNoteStartDiv : cursorDiv;

          if (!isChord) {
            lastNoteStartDiv = cursorDiv;
            cursorDiv += durDiv;
            if (cursorDiv > maxDivInMeasure) maxDivInMeasure = cursorDiv;
          }

          if (!notesByStaff[staffNum]) continue;

          if (!primaryVoiceByStaff[staffNum]) {
            primaryVoiceByStaff[staffNum] = voice;
          }

          const startBeat = currentMeasureStartBeat + noteStartDiv / divisions;
          const durationBeats = durDiv / divisions;
          if (durationBeats <= 0) continue;

          const type = child.querySelector('type')?.textContent?.trim() || guessNoteType(durationBeats);
          const dots = child.querySelectorAll('dot').length;
          const staffClef = clefByStaff[staffNum];

          if (isRest) {
            rawRestsByStaff[staffNum].push({
              isRest: true,
              startBeat,
              durationBeats,
              endBeat: startBeat + durationBeats,
              type,
              dots,
              voice,
              measureNumber: mNum,
              clef: { ...staffClef },
              evalState: null,
            });
            continue;
          }

          const pitchEl = child.querySelector('pitch');
          if (!pitchEl) continue;

          const step = pitchEl.querySelector('step')?.textContent?.trim() || 'C';
          const octave = parseInt(pitchEl.querySelector('octave')?.textContent, 10);
          const alter = parseInt(pitchEl.querySelector('alter')?.textContent, 10) || 0;
          if (Number.isNaN(octave)) continue;

          const midi = (octave + 1) * 12 + STEP_TO_SEMITONE[step] + alter;
          const frequency = midiToFreq(midi);
          const diatonic = octave * 7 + STEP_TO_DIATONIC[step];
          const noteName = formatNoteName(step, alter, octave);

          // Determine displayed accidental per staff
          const accState = measureAccStateByStaff[staffNum];
          const pitchKey = `${step}${octave}`;
          const prevAlter = accState.has(pitchKey) ? accState.get(pitchKey) : keyAccMap[step];

          let displayAccidental = null;
          const explicitAcc = child.querySelector('accidental')?.textContent?.trim();
          if (explicitAcc) {
            displayAccidental = mapExplicitAccidental(explicitAcc);
            accState.set(pitchKey, alter);
          } else if (alter !== prevAlter) {
            displayAccidental = alterToAccidentalSymbol(alter);
            accState.set(pitchKey, alter);
          }

          // Check ties
          const tieEls = Array.from(child.querySelectorAll('tie'));
          const hasTieStart = tieEls.some((t) => t.getAttribute('type') === 'start');
          const hasTieStop = tieEls.some((t) => t.getAttribute('type') === 'stop');

          const staffNotes = notesByStaff[staffNum];
          const activeTies = activeTiesByStaff[staffNum];

          const noteObj = {
            id: staffNotes.length,
            isRest: false,
            isChord,
            step,
            alter,
            octave,
            midi,
            frequency,
            diatonic,
            noteName,
            displayAccidental,
            startBeat,
            durationBeats,
            tiedDurationBeats: durationBeats,
            endBeat: startBeat + durationBeats,
            type,
            dots,
            voice,
            measureNumber: mNum,
            clef: { ...staffClef },
            tieFromPrev: hasTieStop,
            tieToNext: hasTieStart,
            evalState: null, // 'intune' | 'flat' | 'sharp' | 'off'
          };

          if (hasTieStop && activeTies.has(midi)) {
            const rootNote = activeTies.get(midi);
            noteObj.tiedRootId = rootNote.id;
            rootNote.tiedDurationBeats += durationBeats;
            if (!hasTieStart) {
              activeTies.delete(midi);
            }
          } else if (hasTieStart) {
            activeTies.set(midi, noteObj);
          }

          staffNotes.push(noteObj);
          pitchedIntervalsByStaff[staffNum].push({ start: startBeat, end: startBeat + durationBeats });
        }
      }

      // Add non-overlapping rests for each staff (avoid clutter when secondary voice has filler rests)
      for (let s = 1; s <= staffCount; s++) {
        const key = String(s);
        const primaryV = primaryVoiceByStaff[key];
        const pitched = pitchedIntervalsByStaff[key];
        const staffNotes = notesByStaff[key];

        for (const r of rawRestsByStaff[key]) {
          const isPrimaryVoice = r.voice === primaryV;
          const overlapsPitched = pitched.some((p) => p.start < r.endBeat - 0.01 && p.end > r.startBeat + 0.01);
          if (isPrimaryVoice || !overlapsPitched) {
            r.id = staffNotes.length;
            staffNotes.push(r);
          }
        }
      }

      // Compute measure length in quarter-note beats
      const nominalMeasureBeats = measureTimeSig.beats * (4 / measureTimeSig.beatType);
      const actualMeasureBeats = maxDivInMeasure > 0 ? maxDivInMeasure / divisions : nominalMeasureBeats;

      for (let s = 1; s <= staffCount; s++) {
        const key = String(s);
        measuresByStaff[key].push({
          number: mNum,
          startBeat: currentMeasureStartBeat,
          durationBeats: actualMeasureBeats,
          endBeat: currentMeasureStartBeat + actualMeasureBeats,
          clef: measureClefByStaff[key],
          fifths: measureFifths,
          timeSig: measureTimeSig,
        });
      }

      currentMeasureStartBeat += actualMeasureBeats;
    });

    // Build line objects
    const lines = [];
    for (let s = 1; s <= staffCount; s++) {
      const key = String(s);
      const staffNotes = notesByStaff[key];
      const staffMeasures = measuresByStaff[key];

      // Sort notes by startBeat, pitched before rests, lower pitch before higher in chords
      staffNotes.sort((a, b) =>
        a.startBeat - b.startBeat ||
        (a.isRest ? 1 : 0) - (b.isRest ? 1 : 0) ||
        (a.midi || 0) - (b.midi || 0)
      );
      // Re-index ids cleanly
      staffNotes.forEach((n, i) => { n.id = i; });

      const firstMeasure = staffMeasures[0] || {
        clef: { sign: 'F', line: 4 },
        fifths: 0,
        timeSig: { beats: 4, beatType: 4 },
      };

      const shortLabel = staffCount > 1
        ? `Line ${s}`
        : partName;

      lines.push({
        title,
        partId: staffCount > 1 ? `${partId}-S${s}` : partId,
        partName: staffCount > 1 ? `${partName} — Line ${s}` : partName,
        shortLabel,
        initialTempo,
        totalBeats: currentMeasureStartBeat,
        measures: staffMeasures,
        notes: staffNotes,
        clef: firstMeasure.clef,
        fifths: firstMeasure.fifths,
        timeSig: firstMeasure.timeSig,
        subtitle: `${clefLabel(firstMeasure.clef)} · ${KEY_NAMES_MAJOR[String(firstMeasure.fifths)] || 'Key'} · ${firstMeasure.timeSig.beats}/${firstMeasure.timeSig.beatType}`,
      });
    }

    return lines;
  }

  function guessNoteType(beats) {
    if (beats >= 3.5) return 'whole';
    if (beats >= 1.75) return 'half';
    if (beats >= 0.85) return 'quarter';
    if (beats >= 0.42) return 'eighth';
    return '16th';
  }

  function mapExplicitAccidental(acc) {
    switch (acc) {
      case 'sharp': return '#';
      case 'flat': return 'b';
      case 'natural': return 'n';
      case 'double-sharp': return '##';
      case 'flat-flat': return 'bb';
      default: return null;
    }
  }

  function alterToAccidentalSymbol(alter) {
    if (alter === 1) return '#';
    if (alter === -1) return 'b';
    if (alter === 0) return 'n';
    if (alter === 2) return '##';
    if (alter === -2) return 'bb';
    return null;
  }

  return {
    parseFile,
    parseXmlString,
    clefLabel,
  };
})();
