'use strict';
// Pure, deterministic, read-only candidate timing. No I/O, user marks, labels or identifiers.
const VERSION = 'first-pulse-onset-r2';
const PARAMS = Object.freeze({
  sampleRate: 44100, searchBackSeconds: 0.050, searchForwardSeconds: 0.075,
  previousGuardSeconds: 0.030, nextGuardSeconds: 0.015,
  anchorStartSeconds: 0.020, anchorEndSeconds: 0.110, anchorLeadSeconds: 0.004, anchorLeadPeriodFraction: 0.30,
  minPeriodSeconds: 0.0025, maxPeriodSeconds: 0.050,
  lagToleranceFraction: 0.15, lagToleranceSeconds: 0.0025,
  oldLookBackSeconds: 0.120, oldLookEndSeconds: 0.030,
  oldMinPeriodSeconds: 0.008, oldMaxPeriodSeconds: 0.030, oldReliableCorrelation: 0.50, oldNearBestCorrelationFraction: 0.92,
  noveltyHalfWindowSeconds: 0.004, oldExplainedCorrelation: 0.75, oldExplainedEnergyGrowth: 1.69,
  strongFraction: 0.40, contactMaxFraction: 0.75, narrowRunPeriodFraction: 0.12,
  compoundMaxPeakSeparationPeriods: 0.50, compoundPeakToPeakFraction: 1.0,
  largeReleaseFraction: 0.85, releaseLookBackPeriods: 1.10, maxReleaseGapPeriods: 0.70,
  followingCorrelation: 0.60, followingMinEnergyRatio: 0.25, followingMaxEnergyRatio: 4.0,
  followingEarliestStartPeriods: 0.60,
  regularCorrelation: 0.70, regularMinEnergyRatio: 0.35, regularMaxEnergyRatio: 3.0,
  firstCycleCorrelation: 0.25, firstCycleMinEnergyRatio: 0.20,
  supportEnergyFraction: 0.18, edgeHalfWidthSeconds: 0.0005,
  edgeSearchSeconds: 0.004, edgeMaxBackSeconds: 0.012, edgeFootFraction: 0.15,
  minimumReferencePeak: 1e-5, minimumReferenceRms: 2e-6,
  gradualCorrelation: 0.85, gradualCycleGrowthFraction: 0.20, gradualBaselineFraction: 0.05,
  disagreementSeconds: 0.005, maxChainSteps: 40
});
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const rho = note => note && note.evidence && note.evidence.rhoTime;
function makePath(reason, footprint = null, extra = {}) {
  return { available: false, time: null, frame: null, reason, footprint, ...extra };
}
function output(forward, backward, diagnostics, forcedReason = null) {
  const f = forward.available, b = backward.available;
  const disagreementMs = f && b ? Math.abs(forward.frame - backward.frame) / PARAMS.sampleRate * 1000 : null;
  const reasons = [], uncertainty = [];
  let frame = null, reason = forcedReason;
  if (forcedReason) reasons.push(forcedReason);
  else if (backward.reason === 'periodic-through-search-boundary') {
    reason = 'no-resolved-new-event'; reasons.push(backward.reason);
    if (f) uncertainty.push('forward-event-on-continuous-periodic-chain');
  } else if (f && b && disagreementMs <= PARAMS.disagreementSeconds * 1000) {
    frame = Math.min(forward.frame, backward.frame); reason = 'directional-agreement';
  } else if (f && b) {
    reason = 'directional-disagreement'; reasons.push(reason); uncertainty.push('directions-more-than-5ms-apart');
  } else if (f || b) {
    const accepted = f ? forward : backward;
    frame = accepted.frame; reason = f ? 'forward-only' : 'backward-only';
    uncertainty.push(reason); reasons.push(f ? 'backward:' + backward.reason : 'forward:' + forward.reason);
  } else {
    reason = reason || 'no-supported-first-pulse'; reasons.push('forward:' + forward.reason, 'backward:' + backward.reason);
  }
  if (f && forward.relaxedFirstCycle || b && backward.relaxedFirstCycle) uncertainty.push('initial-cycle-shape-relaxed');
  if (f && forward.release || b && backward.release) reasons.push('large-pre-cycle-release');
  const uncertain = frame === null || uncertainty.length > 0;
  return { pulseOnsetTime: frame === null ? null : frame / PARAMS.sampleRate, pulseOnsetFrame: frame,
    reason, forwardTime: f ? forward.time : null, backwardTime: b ? backward.time : null,
    disagreementMs, uncertain, reasons: [...new Set([...reasons, ...uncertainty])],
    diagnostics: { version: VERSION, parameters: PARAMS, ...diagnostics, forward, backward } };
}
function invalid(reason, details = {}) { return output(makePath(reason), makePath(reason), details, reason); }
function estimatePulse({ pcm, sampleRate, notes, index } = {}) {
  if (!(pcm instanceof Float32Array)) return invalid('pcm-must-be-float32array');
  if (sampleRate !== PARAMS.sampleRate) return invalid('unsupported-sample-rate');
  if (!Array.isArray(notes) || !Number.isSafeInteger(index) || index < 0 || index >= notes.length) return invalid('invalid-note-index');
  if (!notes.every((note, i) => finite(rho(note)) && rho(note) >= 0 && (i === 0 || rho(notes[i - 1]) < rho(note)))) return invalid('notes-must-be-strictly-rho-sorted');
  const note = notes[index], tc = rho(note), midi = finite(note.medianMidi) ? note.medianMidi : note.midi;
  if (!finite(midi)) return invalid('missing-period-pitch');
  const periodSeconds = 1 / (440 * Math.pow(2, (midi - 69) / 12));
  if (!finite(periodSeconds) || periodSeconds < PARAMS.minPeriodSeconds || periodSeconds > PARAMS.maxPeriodSeconds) return invalid('period-out-of-range');
  const S = seconds => Math.round(seconds * sampleRate), T = Math.max(2, S(periodSeconds)), length = pcm.length;
  const duration = length / sampleRate;
  if (tc >= duration || length < T * 3) return invalid('insufficient-pcm-context', { nominalPeriodFrames: T });
  const previous = index ? rho(notes[index - 1]) : null, next = index + 1 < notes.length ? rho(notes[index + 1]) : null;
  const lower = Math.max(0, S(tc - PARAMS.searchBackSeconds), previous === null ? 0 : S(previous + PARAMS.previousGuardSeconds));
  const upper = Math.min(length, S(tc + PARAMS.searchForwardSeconds), next === null ? length : S(next - PARAMS.nextGuardSeconds));
  const supportEnd = Math.min(length, next === null ? length : S(next - PARAMS.nextGuardSeconds));
  const anchorStart = Math.max(lower, S(tc + PARAMS.anchorStartSeconds));
  const anchorEnd = Math.min(S(tc + PARAMS.anchorEndSeconds), supportEnd - T * 2);
  const oldStart = Math.max(0, S(tc - PARAMS.oldLookBackSeconds)), oldEnd = Math.max(0, Math.min(lower, S(tc - PARAMS.oldLookEndSeconds)));
  const tolerance = Math.max(2, Math.min(S(PARAMS.lagToleranceSeconds), Math.round(T * PARAMS.lagToleranceFraction)));
  const edgeH = Math.max(1, S(PARAMS.edgeHalfWidthSeconds)), lead = Math.min(S(PARAMS.anchorLeadSeconds), Math.round(T * PARAMS.anchorLeadPeriodFraction));
  const accessLow = Math.max(0, Math.min(oldStart, lower - 2 * T - tolerance, lower - S(PARAMS.oldMaxPeriodSeconds) - S(PARAMS.noveltyHalfWindowSeconds) - S(PARAMS.lagToleranceSeconds)));
  const accessHigh = Math.min(length, supportEnd, Math.max(upper + 3 * T + tolerance, anchorEnd + 2 * T + tolerance));
  const footprint = { startFrame: accessLow, endFrame: accessHigh, startTime: accessLow / sampleRate, endTime: accessHigh / sampleRate };
  const base = { window: { lowerFrame: lower, upperFrame: upper, supportEndFrame: supportEnd, anchorStartFrame: anchorStart, anchorEndFrame: anchorEnd }, period: { nominalFrames: T, nominalSeconds: periodSeconds, lagToleranceFrames: tolerance }, footprint };
  if (upper <= lower || anchorEnd <= anchorStart) return output(makePath('insufficient-neighbor-room', footprint), makePath('insufficient-neighbor-room', footprint), base, 'insufficient-neighbor-room');
  for (let n = accessLow; n < accessHigh; n++) if (!Number.isFinite(pcm[n])) return output(makePath('nonfinite-pcm', footprint), makePath('nonfinite-pcm', footprint), base, 'nonfinite-pcm');
  const x = n => n >= 0 && n < supportEnd ? pcm[n] : 0;
  function peak(a, b) { a = clamp(Math.floor(a), 0, length); b = clamp(Math.ceil(b), a, length); let value = 0, frame = a; for (let n = a; n < b; n++) if (Math.abs(pcm[n]) > value) { value = Math.abs(pcm[n]); frame = n; } return { value, frame }; }
  function energy(a, b) { a = clamp(Math.floor(a), 0, length); b = clamp(Math.ceil(b), a, length); let sum = 0; for (let n = a; n < b; n += 2) sum += pcm[n] * pcm[n]; return sum / Math.max(1, Math.ceil((b - a) / 2)); }
  function correlation(a, b, count, stride = 2) {
    if (a < 0 || b < 0 || a + count > length || b + count > length) return { corr: 0, ratio: 0, energyA: 0, energyB: 0 };
    let aa = 0, bb = 0, ab = 0;
    for (let n = 0; n < count; n += stride) { const v = pcm[a + n], w = pcm[b + n]; aa += v * v; bb += w * w; ab += v * w; }
    return { corr: aa > 1e-20 && bb > 1e-20 ? ab / Math.sqrt(aa * bb) : 0, ratio: aa / Math.max(bb, 1e-20), energyA: aa, energyB: bb };
  }
  function pair(start, minimumFirstFrame = -Infinity) {
    let best = { corr: -1, ratio: 0, lag: T };
    for (let lag = T - tolerance; lag <= T + tolerance; lag += 3) { if (start - lag < minimumFirstFrame) continue; const check = correlation(start - lag, start, T); if (check.corr > best.corr) best = { corr: check.corr, ratio: check.ratio, lag }; }
    return best;
  }
  function oldPeriod() {
    let best = null;
    const values = [];
    for (let lag = S(PARAMS.oldMinPeriodSeconds); lag <= S(PARAMS.oldMaxPeriodSeconds); lag += 3) {
      const count = oldEnd - oldStart - lag; if (count < lag * 2) continue;
      const result = correlation(oldStart, oldStart + lag, count, 3), entry = { lag, corr: result.corr };
      values.push(entry); if (!best || result.corr > best.corr) best = entry;
    }
    if (best && best.corr >= PARAMS.oldReliableCorrelation) {
      for (let i = 0; i < values.length; i++) if (values[i].corr >= best.corr * PARAMS.oldNearBestCorrelationFraction) { while (i + 1 < values.length && values[i + 1].corr > values[i].corr) i++; return { ...values[i], reliable: true }; }
    }
    return { lag: T, corr: best ? best.corr : null, reliable: false };
  }
  const old = oldPeriod(); base.period.old = old;
  let anchor = null;
  const anchorStep = Math.max(3, Math.floor(T / 10));
  for (let p = anchorStart; p <= anchorEnd; p += anchorStep) {
    const established = pair(p + T);
    if (established.corr < PARAMS.regularCorrelation || established.ratio < PARAMS.followingMinEnergyRatio || established.ratio > PARAMS.followingMaxEnergyRatio) continue;
    const pk = peak(p, p + T), rms = Math.sqrt(energy(p, p + 2 * T));
    if (!anchor || pk.value > anchor.peak) anchor = { frame: pk.frame, startFrame: p, peak: pk.value, rms, corr: established.corr, ratio: established.ratio };
  }
  if (!anchor || anchor.peak < PARAMS.minimumReferencePeak || anchor.rms < PARAMS.minimumReferenceRms) return output(makePath('no-stable-periodic-reference', footprint), makePath('no-stable-periodic-reference', footprint), { ...base, reference: anchor }, 'no-stable-periodic-reference');
  const A = anchor.peak, referenceEnergy = anchor.rms * anchor.rms, threshold = PARAMS.strongFraction * A;
  base.reference = anchor;
  function novel(frame) {
    const half = S(PARAMS.noveltyHalfWindowSeconds), count = half * 2 + 1, a = Math.max(0, frame - half);
    const oldTol = S(PARAMS.lagToleranceSeconds); let best = null;
    for (let shift = -oldTol; shift <= oldTol; shift += 4) {
      const predicted = a - old.lag + shift; if (predicted < 0) continue;
      const result = correlation(a, predicted, count);
      if (!best || result.corr > best.corr) best = result;
      if (result.corr >= PARAMS.oldExplainedCorrelation && result.ratio <= PARAMS.oldExplainedEnergyGrowth) return { novel: false, corr: result.corr, energyRatio: result.ratio };
    }
    return { novel: true, corr: best ? best.corr : null, energyRatio: best ? best.ratio : null };
  }
  function edgeFoot(crossing) {
    const polarity = Math.sign(x(crossing)) || 1, derivative = n => polarity * (x(n + edgeH) - x(n - edgeH));
    const low = Math.max(lower, crossing - S(PARAMS.edgeSearchSeconds));
    // Keep refinement on this rise; a separate preceding spike cannot steal its edge.
    let connectedLow = low;
    for (let n = crossing - 1; n >= low; n--) if (derivative(n) <= 0) { connectedLow = n + 1; break; }
    let maximum = 0, steep = crossing;
    for (let n = connectedLow; n <= crossing; n++) if (derivative(n) > maximum) { maximum = derivative(n); steep = n; }
    if (!(maximum > 0)) return { frame: crossing, derivative: 0 };
    const limit = Math.max(lower, crossing - S(PARAMS.edgeMaxBackSeconds)); let frame = steep;
    while (frame > limit && derivative(frame) > PARAMS.edgeFootFraction * maximum) frame--;
    return { frame, derivative: maximum, steepFrame: steep };
  }
  function strongRuns(a, b) {
    const runs = []; a = Math.max(lower, Math.floor(a)); b = Math.min(upper, Math.ceil(b));
    for (let n = a; n < b;) {
      if (Math.abs(x(n)) < threshold) { n++; continue; }
      const crossing = n; let maximum = Math.abs(x(n)), peakFrame = n;
      while (n < Math.min(supportEnd, b + T) && Math.abs(x(n)) >= threshold) { if (Math.abs(x(n)) > maximum) { maximum = Math.abs(x(n)); peakFrame = n; } n++; }
      runs.push({ crossing, endFrame: n, peak: maximum, peakFrame, width: n - crossing });
    }
    return runs;
  }
  function bipolarSupport(run) {
    const polarity = Math.sign(x(run.peakFrame)), limit = Math.min(supportEnd, run.peakFrame + Math.round(T * PARAMS.compoundMaxPeakSeparationPeriods));
    let n = run.endFrame;
    while (n < limit) {
      if (Math.abs(x(n)) < threshold || Math.sign(x(n)) === polarity) { n++; continue; }
      const crossing = n; let secondPeak = Math.abs(x(n)), secondPeakFrame = n, secondEnergy = 0;
      const scanEnd = Math.min(supportEnd, limit + T);
      while (n < scanEnd && Math.abs(x(n)) >= threshold && Math.sign(x(n)) !== polarity) { const value = Math.abs(x(n)); secondEnergy += value * value; if (value > secondPeak) { secondPeak = value; secondPeakFrame = n; } n++; }
      if (n >= scanEnd) return { supported: false, reason: 'opposite-lobe-truncated' };
      if (secondPeakFrame > limit) break;
      let firstEnergy = 0; for (let k = run.crossing; k < run.endFrame; k++) firstEnergy += x(k) * x(k);
      const fraction = firstEnergy / Math.max(firstEnergy + secondEnergy, 1e-20), excursion = run.peak + secondPeak;
      if (excursion >= A * PARAMS.compoundPeakToPeakFraction && fraction >= PARAMS.firstCycleMinEnergyRatio) return { supported: true, firstStartFrame: run.crossing, firstEndFrame: run.endFrame, secondStartFrame: crossing, secondEndFrame: n, secondPeakFrame, firstLobeEnergyFraction: fraction, peakToPeakFraction: excursion / A };
      // Only the adjacent opposite lobe can form this first-cycle event; do not shop for a later pair.
      break;
    }
    return { supported: false };
  }
  function quality(run) {
    const foot = edgeFoot(run.crossing), frame = foot.frame;
    if (frame < lower || frame >= upper) return { ok: false, reason: 'edge-out-of-search-window' };
    const followingEnd = Math.min(frame + 3 * T, supportEnd), secondStart = followingEnd - T;
    const earliestSupport = frame + Math.ceil(T * PARAMS.followingEarliestStartPeriods);
    if (secondStart - (T - tolerance) < earliestSupport) return { ok: false, reason: 'insufficient-following-cycles' };
    const novelty = novel(run.crossing); if (!novelty.novel) return { ok: false, reason: 'explained-by-old-period', novelty };
    const nextPair = pair(secondStart, earliestSupport);
    const firstStart = secondStart - nextPair.lag, e1 = energy(firstStart, firstStart + T), e2 = energy(secondStart, followingEnd);
    const followingSupport = { firstStartFrame: firstStart, firstEndFrame: firstStart + T, secondStartFrame: secondStart, secondEndFrame: followingEnd, clippedByNeighbor: followingEnd < frame + 3 * T, earliestAllowedFrame: earliestSupport };
    if (nextPair.corr < PARAMS.followingCorrelation || nextPair.ratio < PARAMS.followingMinEnergyRatio || nextPair.ratio > PARAMS.followingMaxEnergyRatio || Math.min(e1, e2) < referenceEnergy * PARAMS.supportEnergyFraction) return { ok: false, reason: 'no-periodic-sustain-after-edge', nextPair };
    const firstPair = pair(frame + T), firstEnergy = energy(frame, frame + T);
    const narrow = run.width < T * PARAMS.narrowRunPeriodFraction, compound = bipolarSupport(run);
    if (narrow && run.peak < A * PARAMS.contactMaxFraction && !compound.supported) return { ok: false, reason: 'small-isolated-contact', peakFraction: run.peak / A, runWidthPeriods: run.width / T };
    const broad = !narrow && firstEnergy >= referenceEnergy * PARAMS.firstCycleMinEnergyRatio;
    const shapeSupported = firstPair.corr >= (narrow ? PARAMS.regularCorrelation : PARAMS.firstCycleCorrelation) && firstPair.ratio >= PARAMS.firstCycleMinEnergyRatio;
    let release = false;
    if (!broad && !shapeSupported && !compound.supported) {
      if (run.peak < A * PARAMS.largeReleaseFraction) return { ok: false, reason: 'unsupported-first-cycle-shape', firstPair };
      let nextStrong = run.endFrame;
      while (nextStrong < Math.min(supportEnd, run.crossing + Math.round(T * PARAMS.releaseLookBackPeriods)) && Math.abs(x(nextStrong)) < threshold) nextStrong++;
      if (nextStrong - run.endFrame > T * PARAMS.maxReleaseGapPeriods || nextStrong >= run.crossing + T * PARAMS.releaseLookBackPeriods) return { ok: false, reason: 'isolated-release-without-close-sustain' };
      release = true;
    }
    const prior = pair(frame + T), beforePeak = peak(frame - T, frame).value, nowPeak = peak(frame, frame + T).value;
    const laterPeak = peak(frame + T, frame + 2 * T).value;
    // A smooth amplitude ramp with preserved phase is not a localized release edge.
    if (prior.corr >= PARAMS.gradualCorrelation && beforePeak > A * PARAMS.gradualBaselineFraction && nowPeak >= beforePeak && laterPeak >= nowPeak && (nowPeak - beforePeak) / A < PARAMS.gradualCycleGrowthFraction && (laterPeak - nowPeak) / A < PARAMS.gradualCycleGrowthFraction) return { ok: false, reason: 'gradual-phase-coherent-rise' };
    return { ok: true, frame, time: frame / sampleRate, run, release, compound, relaxedFirstCycle: firstPair.corr < PARAMS.regularCorrelation, foot, novelty, firstPair, nextPair, followingSupport, firstEnergyFraction: firstEnergy / referenceEnergy };
  }
  function accept(candidate, extra) { return { available: true, time: candidate.time, frame: candidate.frame, reason: candidate.release ? 'large-release-before-sustain' : candidate.compound.supported ? 'supported-bipolar-first-cycle' : candidate.relaxedFirstCycle ? 'supported-distorted-first-cycle' : 'supported-first-pulse', footprint, release: candidate.release, compound: candidate.compound, relaxedFirstCycle: candidate.relaxedFirstCycle, crossingFrame: candidate.run.crossing, peakFrame: candidate.run.peakFrame, peakFraction: candidate.run.peak / A, runWidthPeriods: candidate.run.width / T, novelty: candidate.novelty, firstPair: candidate.firstPair, followingPair: candidate.nextPair, followingSupport: candidate.followingSupport, firstEnergyFraction: candidate.firstEnergyFraction, ...extra }; }
  const rejectedForward = {}, rejectedBackward = {};
  let forward = null;
  for (const run of strongRuns(lower, upper)) {
    const candidate = quality(run); if (candidate.ok) { forward = accept(candidate, { localSearch: { startFrame: lower, endFrame: upper }, rejected: rejectedForward }); break; }
    rejectedForward[candidate.reason] = (rejectedForward[candidate.reason] || 0) + 1;
  }
  if (!forward) forward = makePath('no-supported-forward-edge', footprint, { localSearch: { startFrame: lower, endFrame: upper }, rejected: rejectedForward });
  let p = Math.max(lower, anchor.frame - lead), steps = 0, stop = null, periodicThrough = false;
  while (steps < PARAMS.maxChainSteps) {
    const check = pair(p);
    if (check.corr < PARAMS.regularCorrelation || check.ratio < PARAMS.regularMinEnergyRatio || check.ratio > PARAMS.regularMaxEnergyRatio) { stop = check; break; }
    if (p - check.lag < lower - T) { periodicThrough = true; break; }
    p -= check.lag; steps++;
  }
  let backward;
  if (periodicThrough) backward = makePath('periodic-through-search-boundary', footprint, { steps, firstPeriodFrame: p });
  else if (steps >= PARAMS.maxChainSteps) backward = makePath('backward-chain-limit', footprint, { steps, firstPeriodFrame: p });
  else {
    // Search one extra first cycle independently of the regular whole-cycle threshold.
    // A distorted initial cycle and a large nearby isolated release are tested by quality().
    const first = Math.max(lower, p - Math.round(T * PARAMS.releaseLookBackPeriods));
    const last = Math.min(upper, p + T + lead);
    for (const run of strongRuns(first, last)) {
      const candidate = quality(run); if (candidate.ok) { backward = accept(candidate, { steps, firstPeriodFrame: p, stop, localSearch: { startFrame: first, endFrame: last }, rejected: rejectedBackward }); break; }
      rejectedBackward[candidate.reason] = (rejectedBackward[candidate.reason] || 0) + 1;
    }
    if (!backward) backward = makePath('no-supported-backward-edge', footprint, { steps, firstPeriodFrame: p, stop, localSearch: { startFrame: first, endFrame: last }, rejected: rejectedBackward });
  }
  return output(forward, backward, base);
}
module.exports = { estimatePulse, PARAMS, VERSION };
