'use strict';

// Pure derived observations. No PCM, detector calls, file I/O or score/grade.
const VERSION = 'evenness-v2-11r2-20260930';
const finite = x => typeof x === 'number' && Number.isFinite(x);
const median = xs => { if (!xs.length) return null; const a = xs.slice().sort((x, y) => x - y), m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const mean = xs => xs.reduce((s, x) => s + x, 0) / xs.length;
const populationSd = xs => { if (!xs.length) return null; const m = mean(xs); return Math.sqrt(mean(xs.map(x => (x - m) ** 2))); };
const round5 = x => finite(x) ? (Math.abs(x) < 1e-8 ? 0 : Math.sign(x) * Math.round(Math.abs(x) / 5) * 5) : null;
const integerRange = x => !finite(x) ? null : Math.abs(x) < 1e-8 ? [0, 0] : [Math.floor(x), Math.ceil(x)];

function proportion(numerator, denominator) {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator < 0 || numerator > denominator) throw new RangeError('invalid proportion');
  if (!denominator) return { numerator, denominator, ratio: null, ci95: null, method: 'Wilson-score' };
  const z = 1.959963984540054, p = numerator / denominator, q = 1 + z * z / denominator;
  const center = (p + z * z / (2 * denominator)) / q;
  const half = z * Math.sqrt(p * (1 - p) / denominator + z * z / (4 * denominator * denominator)) / q;
  return { numerator, denominator, ratio: p, ci95: [Math.max(0, center - half), Math.min(1, center + half)], method: 'Wilson-score' };
}

function robustLine(points) {
  if (points.length < 2) return null;
  const slopes = [];
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    const dx = points[j].index - points[i].index;
    if (dx) slopes.push((points[j].time - points[i].time) / dx);
  }
  const slope = median(slopes);
  if (!finite(slope) || slope <= 0) return null;
  return { interceptSeconds: median(points.map(p => p.time - slope * p.index)), stepSeconds: slope, method: 'Theil-Sen-pairwise-median-slope-and-median-intercept', fittedCount: points.length };
}

// This is a provisional temporal alignment, never a played-note ground truth.
// A missing event consumes its lattice position. We never zip detections to 0..N.
function inferPositions(rows, planned, nominalStep) {
  const timed = rows.filter(r => r.inWindow && finite(r.locatorTime)).sort((a, b) => a.locatorTime - b.locatorTime);
  if (!planned.length || !timed.length) return { available: false, method: 'no-scope-or-timed-candidates', provisional: true };
  const explicit = timed.filter(r => r.positionReliable && Number.isSafeInteger(r.positionIndex));
  const explicitFit = robustLine(explicit.filter(r => r.state === 'agreement' && finite(r.onsetTime)).map(r => ({ index: r.positionIndex, time: r.onsetTime })));
  let step = explicitFit ? explicitFit.stepSeconds : nominalStep;
  if (!explicitFit) {
    const gapSteps = [];
    for (let i = 1; i < timed.length; i++) {
      const dt = timed[i].locatorTime - timed[i - 1].locatorTime;
      // Very near extra candidates cannot set the beat spacing.
      if (dt >= nominalStep * 0.55) gapSteps.push(dt / Math.max(1, Math.round(dt / nominalStep)));
    }
    if (gapSteps.length >= 2) step = median(gapSteps);
  }
  let anchor = explicit[0] || timed[0];
  // Absolute ordinal cannot be inferred from an uncalibrated capture/metronome offset.
  // Start a provisional relative lattice at the first observed candidate, preserving
  // subsequent gaps; a late entry must not push the entire take beyond planned scope.
  let anchorIndex = explicit.length ? anchor.positionIndex : planned[0].index;
  let intercept = explicitFit ? explicitFit.interceptSeconds : anchor.locatorTime - step * anchorIndex;
  for (let iteration = 0; iteration < 3; iteration++) {
    for (const r of timed) {
      if (r.positionReliable && Number.isSafeInteger(r.positionIndex)) { r.mapping = 'supplied-reliable-position'; continue; }
      const relative = (r.locatorTime - intercept) / step;
      const rounded = Math.round(relative);
      r.assignmentAmbiguous = Math.abs(Math.abs(relative - rounded) - 0.5) < 0.02;
      r.positionIndex = r.assignmentAmbiguous ? null : rounded;
      r.mapping = r.assignmentAmbiguous ? 'ambiguous-lattice-position' : 'provisional-lattice-position';
    }
    const occupancy = new Map();
    for (const r of timed) if (Number.isSafeInteger(r.positionIndex)) occupancy.set(r.positionIndex, (occupancy.get(r.positionIndex) || 0) + 1);
    const points = timed.filter(r => r.state === 'agreement' && finite(r.onsetTime) && occupancy.get(r.positionIndex) === 1).map(r => ({ index: r.positionIndex, time: r.onsetTime }));
    const next = robustLine(points);
    if (!next) break;
    step = next.stepSeconds; intercept = next.interceptSeconds;
  }
  return { available: true, method: explicitFit ? 'reliable-position-anchored-robust-line' : 'provisional-gap-preserving-relative-lattice', provisional: timed.some(r => r.mapping !== 'supplied-reliable-position'), initialSpacingReference: 'metronome', inferredStepSeconds: step, absoluteOrdinalConfirmed: timed.every(r => r.mapping === 'supplied-reliable-position'), leadingMissingUnknown: !explicit.length, warning: '첫 후보부터 센 임시 상대 자리입니다. 시작 전 누락 여부와 실제 몇 번째 음인지 확인한 정답이 아닙니다.' };
}

function tempoDriftWords(driftNotes) {
  if (!finite(driftNotes)) return null;
  const n = Math.abs(driftNotes);
  if (n < 1e-8) return '간격 누적 차이 없음';
  const magnitude = n < 0.25 ? '조금' : n < 0.75 ? '음 하나의 절반쯤' : n < 1.5 ? '한 음쯤' : `약 ${Math.round(n)} 음`;
  return `끝에서는 ${magnitude} ${driftNotes > 0 ? '뒤' : '앞'}`;
}

function comparisonEligibility(a, b) {
  const reasons = [];
  const gap = finite(a.coverage?.ratio) && finite(b.coverage?.ratio) ? Math.abs(a.coverage.ratio - b.coverage.ratio) * 100 : null;
  if (gap === null) reasons.push('coverage-unavailable');
  else if (gap > 15 + 1e-10) reasons.push('coverage-gap-over-15-percentage-points');
  if (!a.details?.numericDispersionAvailable || !b.details?.numericDispersionAvailable) reasons.push('fewer-than-10-valid-adjacent-pairs');
  const am = a.metadata || {}, bm = b.metadata || {};
  if (!am.clickKind || !bm.clickKind || am.clickKind !== bm.clickKind) reasons.push('click-kind-different-or-unknown');
  if (!am.taskComparable || !bm.taskComparable) reasons.push('task-correspondence-unconfirmed');
  if (!am.taskPatternKey || !bm.taskPatternKey || am.taskPatternKey !== bm.taskPatternKey) reasons.push('task-pattern-different-or-unknown');
  const differentDays = am.recordedDate && bm.recordedDate && am.recordedDate !== bm.recordedDate;
  const sameOrder = Number.isSafeInteger(am.sessionOrder) && Number.isSafeInteger(bm.sessionOrder) && am.sessionOrder === bm.sessionOrder;
  if (!differentDays && !sameOrder) reasons.push('session-order-not-comparable');
  const sameKnownRoute = am.monitoringRoute !== 'unknown' && bm.monitoringRoute !== 'unknown' && am.monitoringRoute === bm.monitoringRoute;
  return { dispersionComparable: reasons.length === 0, reasons, coverageGapPercentagePoints: gap,
    offsetComparisonAllowed: false, offsetComparisonReason: sameKnownRoute ? 'fitted-intercept-stored-only-never-displayed' : 'monitoring-route-different-or-unknown',
    monitoringRouteAffectsWithinTakeTempoCalculation: false, differentDays: !!differentDays, sameSessionOrder: sameOrder };
}

function analyzeEvenness(input = {}) {
  const { candidates, plannedPositions, playStartSeconds, playEndSeconds } = input;
  const bpm = input.metronomeBpm ?? input.bpm, subdivisions = input.subdivisionsPerBeat ?? 4;
  if (!finite(bpm) || bpm <= 0 || !finite(subdivisions) || subdivisions <= 0) throw new RangeError('positive BPM and subdivisions required');
  if (!finite(playStartSeconds) || !finite(playEndSeconds) || playEndSeconds <= playStartSeconds) throw new RangeError('explicit half-open play window required');
  if (!Array.isArray(candidates) || !Array.isArray(plannedPositions)) throw new TypeError('candidates and plannedPositions arrays required');
  const nominalStep = 60 / bpm / subdivisions;
  const planned = plannedPositions.map(p => ({ ...p })).sort((a, b) => a.index - b.index);
  planned.forEach((p, i) => { if (!Number.isSafeInteger(p.index) || !finite(p.timeSeconds) || (i && (p.index === planned[i - 1].index || p.timeSeconds <= planned[i - 1].timeSeconds))) throw new TypeError('unique ordered planned indices and strictly increasing times required'); });
  const scope = planned.filter(p => p.timeSeconds >= playStartSeconds && p.timeSeconds < playEndSeconds);
  const scopeByIndex = new Map(scope.map(p => [p.index, p]));
  const ids = new Set();
  const rows = candidates.map((c, ordinal) => {
    const id = c.id ?? c.candidateId ?? ordinal + 1;
    if (ids.has(id)) throw new TypeError('duplicate candidate ID'); ids.add(id);
    const state = c.state ?? c.timingState;
    if (!['agreement', 'deferred', 'unmeasured'].includes(state)) throw new TypeError('state must be agreement, deferred or unmeasured');
    const onset = finite(c.onsetTime) ? c.onsetTime : finite(c.pulseOnsetTime) ? c.pulseOnsetTime : null;
    const rho = finite(c.rhoTime) ? c.rhoTime : null;
    const locator = onset ?? rho;
    const inWindow = finite(locator) && locator >= playStartSeconds && locator < playEndSeconds;
    return { ...c, id, ordinal, state, onsetTime: onset, rhoTime: rho, locatorTime: locator,
      positionIndex: Number.isSafeInteger(c.positionIndex) ? c.positionIndex : null, positionReliable: c.positionReliable === true,
      inWindow, scopeLabel: inWindow ? '연주 구간' : '구간 밖', mapping: null, assignmentAmbiguous: false,
      eligible: false, exclusionReasons: [], fittedResidualMs: null, detailResidualRounded5Ms: null, fixedGridResidualMs: null,
      taskMismatch: false, gateRejections: Array.isArray(c.gateRejections) ? c.gateRejections.slice() : [] };
  });
  const mapping = inferPositions(rows, scope, nominalStep);
  const occupancy = new Map();
  for (const r of rows) if (r.inWindow && Number.isSafeInteger(r.positionIndex)) { const list = occupancy.get(r.positionIndex) || []; list.push(r); occupancy.set(r.positionIndex, list); }
  const taskComparable = !['N1', 'N5'].includes(input.taskId) && input.taskComparable !== false;
  for (const r of rows) {
    if (!r.inWindow) r.exclusionReasons.push('outside-play-window-or-no-time');
    if (r.gateRejections.length) r.exclusionReasons.push('rejected-by-upstream-gate');
    if (r.state !== 'agreement') r.exclusionReasons.push('not-two-values-agreement');
    if (!finite(r.onsetTime)) r.exclusionReasons.push('no-observed-onset');
    if (!scopeByIndex.has(r.positionIndex)) r.exclusionReasons.push('outside-planned-scope-or-unassigned');
    if (r.assignmentAmbiguous) r.exclusionReasons.push('ambiguous-position');
    if ((occupancy.get(r.positionIndex) || []).length > 1) r.exclusionReasons.push('multiple-candidates-at-position');
    r.eligible = r.exclusionReasons.length === 0;
    const p = scopeByIndex.get(r.positionIndex);
    r.taskMismatch = !!(taskComparable && p && finite(p.expectedMidi) && finite(r.midi) && Math.round(r.midi) !== p.expectedMidi);
  }
  const fitRows = rows.filter(r => r.eligible);
  const fit = robustLine(fitRows.map(r => ({ index: r.positionIndex, time: r.onsetTime })));
  const fixedIntercept = fitRows.length ? median(fitRows.map(r => r.onsetTime - nominalStep * r.positionIndex)) : null;
  for (const r of fitRows) {
    r.fittedResidualMs = fit ? 1000 * (r.onsetTime - fit.interceptSeconds - fit.stepSeconds * r.positionIndex) : null;
    r.detailResidualRounded5Ms = round5(r.fittedResidualMs);
    r.fixedGridResidualMs = finite(fixedIntercept) ? 1000 * (r.onsetTime - fixedIntercept - nominalStep * r.positionIndex) : null;
  }
  const at = index => { const group = occupancy.get(index) || []; return group.length === 1 && group[0].eligible ? group[0] : null; };
  const pairRows = [], tripleRows = [];
  for (let i = 1; i < scope.length; i++) {
    const previous = scope[i - 1], current = scope[i], a = at(previous.index), b = at(current.index);
    const reasons = [];
    if (current.index !== previous.index + 1) reasons.push('planned-position-gap');
    if (!a || !b) reasons.push('missing-deferred-unmeasured-or-ambiguous-position');
    if (!fit) reasons.push('fit-unavailable');
    if (a && b && (b.onsetTime <= a.onsetTime || rows.some(r => r.inWindow && r.id !== a.id && r.id !== b.id && finite(r.locatorTime) && r.locatorTime > a.onsetTime && r.locatorTime < b.onsetTime))) reasons.push('intervening-candidate-or-nonincreasing-time');
    pairRows.push({ positions: [previous.index, current.index], candidateIds: [a?.id ?? null, b?.id ?? null], valid: reasons.length === 0,
      reason: reasons.length ? '견줄 수 없음' : null, excludedReasons: reasons,
      observedIntervalSeconds: a && b ? b.onsetTime - a.onsetTime : null,
      intervalResidualMs: !reasons.length ? 1000 * (b.onsetTime - a.onsetTime - fit.stepSeconds) : null });
    if (i >= 2) {
      const p0 = scope[i - 2], c = at(p0.index), priorPair = pairRows[i - 2], valid = priorPair.valid && !reasons.length;
      tripleRows.push({ positions: [p0.index, previous.index, current.index], candidateIds: [c?.id ?? null, a?.id ?? null, b?.id ?? null], valid,
        reason: valid ? null : '견줄 수 없음', midpointDepartureMs: valid ? 1000 * (a.onsetTime - (c.onsetTime + b.onsetTime) / 2) : null });
    }
  }
  const validPairs = pairRows.filter(p => p.valid), validTriples = tripleRows.filter(p => p.valid);
  const numeric = validPairs.length >= 10 && !!fit;
  const intervalSd = numeric ? populationSd(validPairs.map(p => p.intervalResidualMs)) : null;
  const residualSd = numeric ? populationSd(fitRows.map(r => r.fittedResidualMs)) : null;
  const tripleSd = numeric && validTriples.length >= 2 ? populationSd(validTriples.map(p => p.midpointDepartureMs)) : null;
  const coverage = proportion(fitRows.length, scope.length);
  const benchmark = input.benchmark || {};
  // §3 fail-closed takes precedence over the conflicting provisional ±10 ms band.
  const referenceBand = benchmark.threeGatesPass === true && finite(benchmark.referenceBandMs) && benchmark.referenceBandMs > 0 && typeof benchmark.evidenceId === 'string' && benchmark.evidenceId.length
    ? { halfWidthMs: benchmark.referenceBandMs, evidenceId: benchmark.evidenceId, source: 'measured-benchmark' } : null;
  const beyond = referenceBand ? fitRows.filter(r => finite(r.fittedResidualMs) && Math.abs(r.fittedResidualMs) > referenceBand.halfWidthMs) : [];
  const highlights = beyond.slice().sort((a, b) => Math.abs(b.fittedResidualMs) - Math.abs(a.fittedResidualMs)).slice(0, 3).map(r => r.id);
  const actualBpm = fit ? 60 / fit.stepSeconds / subdivisions : null;
  const span = scope.length > 1 ? scope[scope.length - 1].index - scope[0].index : 0;
  const driftNotes = fit ? span * (fit.stepSeconds - nominalStep) / nominalStep : null;
  const fittedGridOutsideStoredAudio = fit ? scope.map(p => ({positionIndex:p.index,geometryTimeSeconds:fit.interceptSeconds+fit.stepSeconds*p.index,observedOnsetTime:null}))
    .filter(p => p.geometryTimeSeconds < playStartSeconds || p.geometryTimeSeconds >= playEndSeconds) : [];
  const missingPositions = fit ? scope.filter(p => {const t=fit.interceptSeconds+fit.stepSeconds*p.index;
    return t>=playStartSeconds && t<playEndSeconds && !rows.some(r => r.inWindow && finite(r.locatorTime) && Math.abs(r.locatorTime-t)<=0.060+1e-12);
  }).map(p => ({
    positionIndex: p.index, plannedMarkerTimeSeconds: fit.interceptSeconds + fit.stepSeconds * p.index,
    observedOnsetTime: null, state: 'planned-marker-only', agreement: false, possibleMissing: true,
    provisionalMapping: mapping.provisional, label: '후보 없는 자리', reason: '후보 없는 격자 자리(실제 누락 확정 아님)' })) : [];
  const inside = rows.filter(r => r.inWindow), deferred = inside.filter(r => r.state === 'deferred').length;
  const counts = { inWindowCandidates: inside.length, outsideWindowCandidates: rows.length - inside.length, agreement: inside.filter(r => r.state === 'agreement').length,
    deferred, unmeasured: inside.filter(r => r.state === 'unmeasured').length, fittedPositions: fitRows.length, plannedInScope: scope.length, validAdjacentPairs: validPairs.length, validTriples: validTriples.length };
  const firstScreen = {
    foundText: `연주 구간에서 후보 ${inside.length}개를 찾았습니다`,
    coverageText: `연주 구간의 ${scope.length}자리 중 ${fitRows.length}자리 시각을 쟀습니다${mapping.provisional ? '(자리 대응은 임시)' : ''}`,
    tempoText: actualBpm === null ? '템포를 견줄 시각이 부족합니다' : `메트로놈 ${bpm} · 실제 약 ${Math.round(actualBpm)} · ${tempoDriftWords(driftNotes)}`,
    unclearText: `시작이 불분명한 음 ${deferred}개`, evennessStatus: referenceBand ? '시험 범위 안에서 관찰' : '임시',
    directionReference: '빠른 쪽·늦은 쪽은 이 테이크 자신의 흐름에 견준 방향입니다.',
    outsideBandText: referenceBand ? beyond.length ? `띠 밖으로 나간 음: ${beyond.map(r => r.positionIndex + 1).join(' · ')}번째(늦은 쪽 ${beyond.filter(r => r.fittedResidualMs > 0).length} · 빠른 쪽 ${beyond.filter(r => r.fittedResidualMs < 0).length})` : '띠 밖으로 나간 음 없음' : null,
    taskCorrespondenceText: ['N1', 'N5'].includes(input.taskId) ? '과제와의 대응 확인 불가(사용자: 기억 안 남)' : taskComparable ? null : '과제와의 대응 확인 불가',
    nextStep: deferred ? '시작이 불분명한 음을 눌러 앞뒤와 함께 들어보세요.' : '궁금한 음을 눌러 앞뒤와 함께 들어보세요.'
  };
  return { schema: VERSION, metadata: { takeId: input.takeId ?? null, taskId: input.taskId ?? null, taskComparable,
    taskPatternKey: input.taskPatternKey ?? input.taskId ?? null, monitoringRoute: ['direct', 'software'].includes(input.monitoringRoute) ? input.monitoringRoute : 'unknown',
    sessionId: input.sessionId ?? null, sessionOrder: input.sessionOrder ?? null, recordedDate: input.recordedDate ?? null, clickKind: input.clickKind ?? null },
    scope: { playStartSeconds, playEndSeconds, endExclusive: true, plannedInScope: scope, unrecordedPlannedPositions: planned.filter(p => p.timeSeconds >= playEndSeconds),
      outsideCandidatesPreserved: true }, mapping, fit: fit ? { ...fit, interceptDisplayAllowed: false } : null,
    nominalStepSeconds: nominalStep, actualBpm, cumulativeSpacingDriftNotes: driftNotes, rows, counts, coverage, pairCoverage: proportion(validPairs.length, pairRows.length),
    pairs: pairRows, triples: tripleRows, missingPositions, fittedGridOutsideStoredAudio,
    rejectedCandidates: rows.filter(r => r.gateRejections.length).map(r => ({ id: r.id, gates: r.gateRejections })),
    referenceBand, highlightedCandidateIds: highlights, firstScreen,
    details: { numericDispersionAvailable: numeric, numericDispersionReason: numeric ? null : 'fewer-than-10-valid-adjacent-pairs',
      dispersionDefinition: '모집단 SD. 간격 흩어짐과 맞춘 격자 나머지 흩어짐은 별도이며 동일한 값이 아닙니다.',
      displayRangeDefinition: '정수 반올림 표시 범위이며 신뢰구간이나 측정 오차가 아닙니다.',
      intervalResidualPopulationSdMs: intervalSd, intervalDispersionDisplayRangeMs: integerRange(intervalSd),
      fittedResidualPopulationSdMs: residualSd, fittedResidualDispersionDisplayRangeMs: integerRange(residualSd),
      tripleMidpointPopulationSdMs: tripleSd, tripleDispersionDisplayRangeMs: integerRange(tripleSd),
      fixedGrid: { stepSeconds: nominalStep, offsetStoredOnly: true, interceptSeconds: fixedIntercept,
        residualPopulationSdMs: numeric ? populationSd(fitRows.map(r => r.fixedGridResidualMs)) : null },
      referenceBandSuppressionReason: referenceBand ? null : 'benchmark-three-gates-not-established-or-measured-band-unavailable',
      offsetDisplayAllowed: false, noPerceptualConstant: true }
  };
}

module.exports = { VERSION, analyzeEvenness, robustLine, proportion, tempoDriftWords, comparisonEligibility, populationSd };
