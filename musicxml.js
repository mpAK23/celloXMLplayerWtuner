/**
 * musicxml.js
 * Parses .xml, .musicxml, and compressed .mxl files into a clean timeline of notes & measures
 * tailored for scrolling staff playback and real-time cello intonation evaluation.
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
    return parseXmlString(xmlText, fallbackTitle);
  }

  /**
   * Parse raw MusicXML text into a structured score object.
   */
  function parseXmlString(xmlText, fallbackTitle = 'Untitled Score') {
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

    const parts = partEls.map((partEl, idx) => {
      const id = partEl.getAttribute('id') || `P${idx + 1}`;
      const name = partNameMap.get(id) || `Part ${idx + 1}`;
      return parsePart(partEl, id, name, title);
    });

    // Prefer a Cello / Violoncello part if present
    let defaultPartIndex = parts.findIndex((p) => /cello|violoncello|vc\b/i.test(p.partName));
    if (defaultPartIndex === -1) defaultPartIndex = 0;

    return {
      title,
      parts,
      defaultPartIndex,
    };
  }

  function parsePart(partEl, partId, partName, title) {
    const measureEls = Array.from(partEl.querySelectorAll(':scope > measure'));
    let divisions = 1;
    let fifths = 0;
    let timeSig = { beats: 4, beatType: 4 };
    let clef = { sign: 'F', line: 4 }; // Default bass clef for cello
    let initialTempo = 72;
    let foundTempo = false;

    const notes = [];
    const measures = [];
    let currentMeasureStartBeat = 0;

    // Track ongoing tied notes by MIDI pitch
    const activeTies = new Map();

    measureEls.forEach((mEl, mIdx) => {
      const mNum = mEl.getAttribute('number') || String(mIdx + 1);
      let cursorDiv = 0;
      let lastNoteStartDiv = 0;
      let maxDivInMeasure = 0;

      // Active accidentals for this measure (keyed by `${step}${octave}`)
      const keyAccMap = keySignatureMap(fifths);
      const measureAccState = new Map();

      let measureClef = { ...clef };
      let measureFifths = fifths;
      let measureTimeSig = { ...timeSig };

      // Check children in document order
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

          const clefEl = child.querySelector('clef');
          if (clefEl) {
            const sign = clefEl.querySelector('sign')?.textContent?.trim() || 'F';
            const line = parseInt(clefEl.querySelector('line')?.textContent, 10) || (sign === 'F' ? 4 : sign === 'G' ? 2 : 4);
            clef = { sign, line };
            measureClef = { ...clef };
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

          // Focus on primary staff (staff 1) and primary voice if multi-voice
          if (staffNum !== '1') continue;

          const startBeat = currentMeasureStartBeat + noteStartDiv / divisions;
          const durationBeats = durDiv / divisions;
          if (durationBeats <= 0) continue;

          const type = child.querySelector('type')?.textContent?.trim() || guessNoteType(durationBeats);
          const dots = child.querySelectorAll('dot').length;

          if (isRest) {
            // Only keep rests from voice 1 to avoid clutter
            if (voice === '1') {
              notes.push({
                id: notes.length,
                isRest: true,
                startBeat,
                durationBeats,
                endBeat: startBeat + durationBeats,
                type,
                dots,
                measureNumber: mNum,
                clef: { ...clef },
                evalState: null,
              });
            }
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

          // Determine displayed accidental
          const pitchKey = `${step}${octave}`;
          const prevAlter = measureAccState.has(pitchKey)
            ? measureAccState.get(pitchKey)
            : keyAccMap[step];

          let displayAccidental = null;
          const explicitAcc = child.querySelector('accidental')?.textContent?.trim();
          if (explicitAcc) {
            displayAccidental = mapExplicitAccidental(explicitAcc);
            measureAccState.set(pitchKey, alter);
          } else if (alter !== prevAlter) {
            displayAccidental = alterToAccidentalSymbol(alter);
            measureAccState.set(pitchKey, alter);
          }

          // Check ties
          const tieEls = Array.from(child.querySelectorAll('tie'));
          const hasTieStart = tieEls.some((t) => t.getAttribute('type') === 'start');
          const hasTieStop = tieEls.some((t) => t.getAttribute('type') === 'stop');

          const noteObj = {
            id: notes.length,
            isRest: false,
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
            endBeat: startBeat + durationBeats,
            type,
            dots,
            voice,
            measureNumber: mNum,
            clef: { ...clef },
            tieFromPrev: hasTieStop,
            tieToNext: hasTieStart,
            evalState: null, // 'intune' | 'flat' | 'sharp' | 'off'
          };

          if (hasTieStop && activeTies.has(midi)) {
            const prevNote = activeTies.get(midi);
            noteObj.tiedRootId = prevNote.tiedRootId ?? prevNote.id;
            activeTies.delete(midi);
          }
          if (hasTieStart) {
            activeTies.set(midi, noteObj);
          }

          notes.push(noteObj);
        }
      }

      // Compute measure length in quarter-note beats
      const nominalMeasureBeats = measureTimeSig.beats * (4 / measureTimeSig.beatType);
      const actualMeasureBeats = maxDivInMeasure > 0 ? maxDivInMeasure / divisions : nominalMeasureBeats;

      measures.push({
        number: mNum,
        startBeat: currentMeasureStartBeat,
        durationBeats: actualMeasureBeats,
        endBeat: currentMeasureStartBeat + actualMeasureBeats,
        clef: measureClef,
        fifths: measureFifths,
        timeSig: measureTimeSig,
      });

      currentMeasureStartBeat += actualMeasureBeats;
    });

    // Sort notes by startBeat (keeping rests and pitches ordered)
    notes.sort((a, b) => a.startBeat - b.startBeat || (a.isRest ? 1 : 0) - (b.isRest ? 1 : 0));

    const firstMeasure = measures[0] || {
      clef: { sign: 'F', line: 4 },
      fifths: 0,
      timeSig: { beats: 4, beatType: 4 },
    };

    return {
      title,
      partId,
      partName,
      initialTempo,
      totalBeats: currentMeasureStartBeat,
      measures,
      notes,
      clef: firstMeasure.clef,
      fifths: firstMeasure.fifths,
      timeSig: firstMeasure.timeSig,
      subtitle: `${clefLabel(firstMeasure.clef)} · ${KEY_NAMES_MAJOR[String(firstMeasure.fifths)] || 'Key'} · ${firstMeasure.timeSig.beats}/${firstMeasure.timeSig.beatType}`,
    };
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

  /**
   * Built-in Sample 1: Bach Cello Suite No. 1 in G Major, BWV 1007 - Prelude (Opening 8 measures)
   */
  function getSampleBachXml() {
    const m = (num, attrs, notesXml) => `<measure number="${num}">${attrs}${notesXml}</measure>`;
    const n = (step, octave, dur = 1, type = '16th', alter = 0) => `
      <note>
        <pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${octave}</octave></pitch>
        <duration>${dur}</duration><voice>1</voice><type>${type}</type>
      </note>`;

    const attrs1 = `
      <attributes>
        <divisions>4</divisions>
        <key><fifths>1</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>F</sign><line>4</line></clef>
      </attributes>
      <direction><sound tempo="66"/></direction>`;

    // Measure 1: G2 D3 B3 A3 B3 D3 B3 D3 (x2)
    const m1Half = n('G',2) + n('D',3) + n('B',3) + n('A',3) + n('B',3) + n('D',3) + n('B',3) + n('D',3);
    // Measure 2: G2 E3 C4 B3 C4 E3 C4 E3 (x2)
    const m2Half = n('G',2) + n('E',3) + n('C',4) + n('B',3) + n('C',4) + n('E',3) + n('C',4) + n('E',3);
    // Measure 3: G2 F#3 C4 B3 C4 F#3 C4 F#3 (x2)
    const m3Half = n('G',2) + n('F',3,1,'16th',1) + n('C',4) + n('B',3) + n('C',4) + n('F',3,1,'16th',1) + n('C',4) + n('F',3,1,'16th',1);
    // Measure 4: G2 G3 B3 A3 B3 G3 B3 G3 (x2)
    const m4Half = n('G',2) + n('G',3) + n('B',3) + n('A',3) + n('B',3) + n('G',3) + n('B',3) + n('G',3);
    // Measure 5: G2 E3 B3 A3 B3 G3 F#3 G3 | E3 G3 F#3 G3 B2 D3 C#3 B2
    const m5 = n('G',2) + n('E',3) + n('B',3) + n('A',3) + n('B',3) + n('G',3) + n('F',3,1,'16th',1) + n('G',3)
             + n('E',3) + n('G',3) + n('F',3,1,'16th',1) + n('G',3) + n('B',2) + n('D',3) + n('C',3,1,'16th',1) + n('B',2);
    // Measure 6: C#3 G3 A3 G3 A3 G3 A3 G3 (x2)
    const m6Half = n('C',3,1,'16th',1) + n('G',3) + n('A',3) + n('G',3) + n('A',3) + n('G',3) + n('A',3) + n('G',3);
    // Measure 7: F#3 A3 D4 C#4 D4 A3 G3 A3 | F#3 A3 G3 A3 D3 F#3 E3 D3
    const m7 = n('F',3,1,'16th',1) + n('A',3) + n('D',4) + n('C',4,1,'16th',1) + n('D',4) + n('A',3) + n('G',3) + n('A',3)
             + n('F',3,1,'16th',1) + n('A',3) + n('G',3) + n('A',3) + n('D',3) + n('F',3,1,'16th',1) + n('E',3) + n('D',3);
    // Measure 8: G2 (whole note resolution for practice)
    const m8 = n('G',2,16,'whole');

    return `<?xml version="1.0" encoding="UTF-8"?>
      <score-partwise version="3.1">
        <work><work-title>Cello Suite No. 1 in G Major — Prelude (Excerpt)</work-title></work>
        <part-list><score-part id="P1"><part-name>Violoncello</part-name></score-part></part-list>
        <part id="P1">
          ${m(1, attrs1, m1Half + m1Half)}
          ${m(2, '', m2Half + m2Half)}
          ${m(3, '', m3Half + m3Half)}
          ${m(4, '', m4Half + m4Half)}
          ${m(5, '', m5)}
          ${m(6, '', m6Half + m6Half)}
          ${m(7, '', m7)}
          ${m(8, '', m8)}
        </part>
      </score-partwise>`;
  }

  /**
   * Built-in Sample 2: Cello G Major Warmup Scale (Slow, sustained notes for easy intonation practice)
   */
  function getSampleScaleXml() {
    const n = (step, octave, dur = 2, type = 'half', alter = 0) => `
      <note>
        <pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${octave}</octave></pitch>
        <duration>${dur}</duration><voice>1</voice><type>${type}</type>
      </note>`;

    return `<?xml version="1.0" encoding="UTF-8"?>
      <score-partwise version="3.1">
        <work><work-title>Cello G Major Intonation Warmup</work-title></work>
        <part-list><score-part id="P1"><part-name>Violoncello</part-name></score-part></part-list>
        <part id="P1">
          <measure number="1">
            <attributes>
              <divisions>1</divisions>
              <key><fifths>1</fifths></key>
              <time><beats>4</beats><beat-type>4</beat-type></time>
              <clef><sign>F</sign><line>4</line></clef>
            </attributes>
            <direction><sound tempo="60"/></direction>
            ${n('G',2,2,'half')}${n('A',2,2,'half')}
          </measure>
          <measure number="2">${n('B',2,2,'half')}${n('C',3,2,'half')}</measure>
          <measure number="3">${n('D',3,2,'half')}${n('E',3,2,'half')}</measure>
          <measure number="4">${n('F',3,2,'half',1)}${n('G',3,2,'half')}</measure>
          <measure number="5">${n('G',3,2,'half')}${n('F',3,2,'half',1)}</measure>
          <measure number="6">${n('E',3,2,'half')}${n('D',3,2,'half')}</measure>
          <measure number="7">${n('C',3,2,'half')}${n('B',2,2,'half')}</measure>
          <measure number="8">${n('A',2,2,'half')}${n('G',2,2,'half')}</measure>
        </part>
      </score-partwise>`;
  }

  return {
    parseFile,
    parseXmlString,
    getSampleBachXml,
    getSampleScaleXml,
    clefLabel,
  };
})();
