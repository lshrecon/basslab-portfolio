'use strict';
const path = require('node:path');
const { estimateKnees, SETTINGS_SHA256 } = require('./energy-knee.cjs');
const { classifyAllSchemes } = require('./onset-states.cjs');
const finite = x => typeof x === 'number' && Number.isFinite(x);
const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
function noteName(midi) { return finite(midi) ? names[((Math.round(midi) % 12) + 12) % 12] + (Math.floor(Math.round(midi) / 12) - 1) : null; }
function loadFrozen() {
  return require(path.join(__dirname, 'frozen-chain.cjs')).load();
}
function analyzeSignal(pcm, engine, execution) {
  if (!(pcm instanceof Float32Array) || !pcm.length || pcm.some(x => !Number.isFinite(x))) throw Error('finite-f32-mono-required');
  if (!execution) throw Error('explicit-call-ledger-required');
  execution.detectorCalls = (execution.detectorCalls || 0) + 1;
  const raw = engine.detector.analyze(pcm, 44100, { settings: engine.detector.settings, frames: true });
  if (!Array.isArray(raw.notes)) throw Error('detector-notes-missing');
  // Snapshot before evidence annotation so mutation cannot silently change candidate identity.
  const originalNotes = raw.notes.map(n => ({ ...n }));
  execution.evidenceCalls = (execution.evidenceCalls || 0) + 1;
  const labelled = engine.evidence.annotateEvidence(pcm, 44100, raw);
  if (labelled.notes.length !== originalNotes.length || labelled.notes.some((n,i) => ['startSeconds','endSeconds','midi'].some(k => n[k] !== originalNotes[i][k]))) throw Error('evidence-mutated-candidates');
  const timingNotes = labelled.notes.map(n => ({ midi: n.midi, medianMidi: n.medianMidi, evidence: { rhoTime: n.evidence?.rhoTime } }));
  const inputs = timingNotes.map(n => ({ rhoTime: n.evidence.rhoTime, midi: n.midi, medianMidi: n.medianMidi }));
  if (inputs.some(n => !finite(n.rhoTime))) throw Error('candidate-rho-missing');
  const knees = estimateKnees(pcm, inputs);
  execution.kneeCalls = (execution.kneeCalls || 0) + inputs.length;
  const candidates = labelled.notes.map((n, i) => {
    execution.pulseCalls = (execution.pulseCalls || 0) + 1;
    const r2 = engine.pulse.estimatePulse({ pcm, sampleRate: 44100, notes: timingNotes, index: i });
    return { id: i + 1, rhoTime: inputs[i].rhoTime, midi: n.midi ?? null, medianMidi: n.medianMidi ?? null,
      noteName: noteName(n.midi), pitchUncertain: !!n.uncertain, signalNote: n,
      r2, knee: knees[i], states: classifyAllSchemes({ r2, knee: knees[i], evidenceLabel: n.evidence?.label ?? null }),
      listeningFallbackTime: finite(r2.pulseOnsetTime) ? r2.pulseOnsetTime : finite(knees[i].time) ? knees[i].time : inputs[i].rhoTime,
      listeningFallbackIsMeasuredOnset: false
    };
  });
  return { candidates, rawDetector: raw, kneeSettingsSha256: SETTINGS_SHA256,
    selection: null, originalDetectorCalls: execution.detectorCalls,
    meaning: 'Three agreement rules retained; no rule selected, no time accuracy claim.' };
}
module.exports = { analyzeSignal, loadFrozen, noteName };
