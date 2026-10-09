'use strict';

const { SETTINGS, SETTINGS_SHA256 } = require('./energy-knee.cjs');
const finite = value => typeof value === 'number' && Number.isFinite(value);

function atBoundary(time, bounds) {
  if (!finite(time) || !bounds) return false;
  const lo = finite(bounds.lowerSeconds) ? bounds.lowerSeconds : finite(bounds.lowerFrame) ? bounds.lowerFrame / SETTINGS.sampleRate : null;
  const hi = finite(bounds.upperSeconds) ? bounds.upperSeconds : finite(bounds.upperFrame) ? bounds.upperFrame / SETTINGS.sampleRate : null;
  return (finite(lo) && time - lo <= SETTINGS.searchEdgeHoldSeconds + 1e-12) ||
    (finite(hi) && hi - time <= SETTINGS.searchEdgeHoldSeconds + 1e-12);
}

function classifyOnset({ r2, knee, schemeId, evidenceLabel = null, relativeLevelDb = null }) {
  const scheme = SETTINGS.schemeCandidates.find(s => s.id === schemeId);
  if (!scheme) throw new Error('Explicit frozen agreement scheme required');
  const r2Time = finite(r2?.pulseOnsetTime) ? r2.pulseOnsetTime : finite(r2?.time) ? r2.time : null;
  const kneeTime = finite(knee?.time) ? knee.time : null;
  const correctedKneeTime = kneeTime == null ? null : kneeTime - scheme.kneeCorrectionMs / 1000;
  const maximumDifferenceMs = scheme.maximumPeriodFraction == null ? scheme.maximumDifferenceMs :
    finite(knee?.periodSeconds) ? Math.min(scheme.maximumDifferenceMs, 1000 * scheme.maximumPeriodFraction * knee.periodSeconds) : null;
  const differenceMs = r2Time == null || correctedKneeTime == null ? null : (correctedKneeTime - r2Time) * 1000;
  const both = r2Time != null && kneeTime != null;
  const matches = both && maximumDifferenceMs != null && Math.abs(differenceMs) <= maximumDifferenceMs + 1e-9;
  const comparison = both ? matches ? 'agree' : 'disagree' : r2Time != null ? 'r2-only' : kneeTime != null ? 'knee-only' : 'none';
  const edge = { r2: atBoundary(r2Time, r2?.diagnostics?.window ?? r2?.search), knee: Boolean(knee?.nearSearchEdge) || atBoundary(kneeTime, knee?.search) };
  let state, reason;
  if (comparison === 'none') {
    state = 'unmeasured';
    const errors = [r2?.reason, knee?.reason].filter(Boolean);
    if (errors.some(e => /missing-(pitch|rho)|no-room|invalid-period|search|range|no-space/.test(e))) reason = 'missing-pitch-or-range';
    else if (evidenceLabel === 'pitch-change-only' || evidenceLabel === 'pitch-change') reason = 'pitch-change-only';
    else reason = 'energy-rise-unresolved';
  } else if (edge.r2 || edge.knee) { state = 'hold'; reason = 'search-edge-within-10ms'; }
  else if (matches) { state = 'agree'; reason = 'within-frozen-agreement-limit'; }
  else { state = 'hold'; reason = comparison === 'disagree' ? 'estimator-disagreement' : comparison; }
  return {
    state, comparison, reason, label: state === 'agree' ? '두 값 일치' : state === 'hold' ? '시작 불분명' : '재지 못함',
    time: state === 'agree' ? r2Time : null, r2Time, kneeTime, correctedKneeTime,
    schemeId, settingsSha256: SETTINGS_SHA256, maximumDifferenceMs, differenceMs,
    boundaryHold: edge, uncertainMetadataOnly: Boolean(r2?.uncertain),
    r2ReasonsMetadataOnly: Array.isArray(r2?.reasons) ? [...r2.reasons] : [],
    periodSeconds: finite(knee?.periodSeconds) ? knee.periodSeconds : null,
    periodSource: knee?.periodSource ?? null,
    relativeLevelDb: finite(relativeLevelDb) ? relativeLevelDb : null,
    provisional: true,
    interpretation: 'Shared PCM/candidate/pitch; agreement is not independent ground truth'
  };
}

function classifyAllSchemes(input) { return Object.fromEntries(SETTINGS.schemeCandidates.map(s => [s.id, classifyOnset({ ...input, schemeId: s.id })])); }
module.exports = { classifyOnset, classifyAllSchemes, atBoundary };
