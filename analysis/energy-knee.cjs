'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const SETTINGS_PATH = path.join(__dirname, 'settings.json');
const SETTINGS_BYTES = fs.readFileSync(SETTINGS_PATH);
function deepFreeze(x) { if (x && typeof x === 'object') { Object.values(x).forEach(deepFreeze); Object.freeze(x); } return x; }
const SETTINGS = deepFreeze(JSON.parse(SETTINGS_BYTES));
const SETTINGS_SHA256 = crypto.createHash('sha256').update(SETTINGS_BYTES).digest('hex');
const finite = value => typeof value === 'number' && Number.isFinite(value);

function createEnergyIndex(pcm, sampleRate = SETTINGS.sampleRate) {
  if (sampleRate !== SETTINGS.sampleRate) throw new Error('Frozen knee supports 44100 Hz only');
  if (!(pcm instanceof Float32Array || pcm instanceof Float64Array || Array.isArray(pcm))) throw new TypeError('PCM must be a numeric sample array');
  const prefix = new Float64Array(pcm.length + 1);
  for (let i = 0; i < pcm.length; i++) {
    if (!finite(pcm[i])) throw new TypeError('Non-finite PCM sample at ' + i);
    prefix[i + 1] = prefix[i] + pcm[i] * pcm[i];
  }
  return Object.freeze({ prefix, frameCount: pcm.length, sampleRate });
}

function pitchOf(candidate, legacyNullCoercion = false) {
  if (legacyNullCoercion) {
    const value = candidate.medianMidi ?? candidate.midi;
    return { value: value == null ? Number(value) : value, source: candidate.medianMidi != null ? 'medianMidi' : 'midi', legacyNullCoercion: value === null };
  }
  if (finite(candidate.medianMidi)) return { value: candidate.medianMidi, source: 'medianMidi', legacyNullCoercion: false };
  if (finite(candidate.midi)) return { value: candidate.midi, source: 'midi', legacyNullCoercion: false };
  return { value: null, source: null, legacyNullCoercion: false };
}

function estimateCore(index, candidate, legacyNullCoercion) {
  const sr = index.sampleRate;
  if (sr !== SETTINGS.sampleRate) throw new Error('Frozen knee supports 44100 Hz only');
  const pitch = pitchOf(candidate, legacyNullCoercion);
  const result = {
    version: SETTINGS.version, settingsSha256: SETTINGS_SHA256,
    time: null, frame: null, reason: null,
    rhoTime: finite(candidate.rhoTime) ? candidate.rhoTime : null,
    pitchMidi: pitch.value, periodSource: pitch.source,
    legacyNullCoercion: pitch.legacyNullCoercion,
    periodFrames: null, periodSeconds: null, search: null, nearSearchEdge: false
  };
  const fail = reason => ({ ...result, reason });
  if (!finite(candidate.rhoTime)) return fail('missing-rho');
  if (!finite(pitch.value)) return fail('missing-pitch');
  const T = Math.round(sr / (440 * 2 ** ((pitch.value - 69) / 12)));
  if (!(Number.isSafeInteger(T) && T >= 1)) return fail('invalid-period');
  result.periodFrames = T; result.periodSeconds = T / sr;
  const S = seconds => Math.round(seconds * sr);
  let w0 = S(candidate.rhoTime - SETTINGS.searchBackSeconds);
  let w1 = S(candidate.rhoTime + SETTINGS.searchForwardSeconds);
  if (finite(candidate.previousRhoTime)) w0 = Math.max(w0, S(candidate.previousRhoTime + SETTINGS.previousGuardSeconds));
  if (finite(candidate.nextRhoTime)) w1 = Math.min(w1, S(candidate.nextRhoTime - SETTINGS.nextGuardSeconds) - T);
  result.search = { lowerFrame: w0, upperFrame: w1, lowerSeconds: w0 / sr, upperSeconds: w1 / sr };
  if (w1 <= w0) return fail('no-room');
  const clamp = frame => Math.max(0, Math.min(index.frameCount, frame));
  const E = (a, b) => index.prefix[clamp(b)] - index.prefix[clamp(a)];
  let best = -Infinity, ts = -1;
  for (let t = w0; t <= w1; t += SETTINGS.maximumSearchStepFrames) {
    const rise = E(t, t + T) - E(t - T, t);
    if (rise > best) { best = rise; ts = t; }
  }
  const eb = E(ts - T, ts), ef = E(ts, ts + T);
  result.diagnostics = { tStarFrame: ts, maximumRiseEnergy: best, backEnergy: eb, forwardEnergy: ef, ratio: ef / (eb + 1e-18) };
  if (!(ef >= SETTINGS.energyRiseRatio * eb)) return fail('no-energy-rise');
  let minimumEnergy = Infinity, minimumFrame = Math.max(w0, ts - T);
  for (let t = Math.max(w0, ts - T); t <= ts; t += SETTINGS.minimumSearchStepFrames) {
    const energy = E(t - T, t);
    if (energy < minimumEnergy) { minimumEnergy = energy; minimumFrame = t; }
  }
  const threshold = minimumEnergy + SETTINGS.energyRiseFraction * (ef - minimumEnergy);
  Object.assign(result.diagnostics, { minimumEnergy, minimumFrame, threshold, scanEndFrame: ts + T });
  for (let t = minimumFrame; t <= ts + T; t += SETTINGS.crossingSearchStepFrames) {
    if (E(t - T, t) >= threshold) {
      const lowerDistanceSeconds = (t - w0) / sr, upperDistanceSeconds = (w1 - t) / sr;
      return { ...result, time: t / sr, frame: t, reason: 'energy-knee',
        nearSearchEdge: Math.min(lowerDistanceSeconds, upperDistanceSeconds) <= SETTINGS.searchEdgeHoldSeconds,
        boundaryDistanceSeconds: { lower: lowerDistanceSeconds, upper: upperDistanceSeconds }
      };
    }
  }
  return fail('no-crossing');
}

function estimateKnee(index, candidate) { return estimateCore(index, candidate, false); }
// Reproduction-only compatibility function. Never use this for new-take or benchmark analysis.
function estimateLegacyKneeForReproduction(index, candidate) { return estimateCore(index, candidate, true); }

function estimateKnees(pcm, candidates, sampleRate = SETTINGS.sampleRate) {
  const index = createEnergyIndex(pcm, sampleRate);
  return candidates.map((candidate, i) => estimateKnee(index, {
    ...candidate,
    previousRhoTime: i ? candidates[i - 1].rhoTime : null,
    nextRhoTime: i + 1 < candidates.length ? candidates[i + 1].rhoTime : null
  }));
}

module.exports = { SETTINGS, SETTINGS_SHA256, createEnergyIndex, estimateKnee, estimateKnees, estimateLegacyKneeForReproduction };
