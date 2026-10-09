'use strict';
// Read-only signal observation; this is not a string classifier or a quality score.
const VERSION = 'remaining-previous-component-11r2-v1';
const SETTINGS = Object.freeze({ sampleRate: 44100, harmonicCount: 8, maxFrequency: 1800,
  isolatedStartSeconds: .03, boundaryGuardSeconds: .015, referenceMaxSeconds: .14,
  comparisonWindowSeconds: .065, minimumWindowSeconds: .035,
  peakSearchFraction: .035, peakGridHz: .5, minimumHarmonicRelativeDb: -35,
  minimumReferenceRms: 1e-5, overlapRayleighMultiplier: 1.5 });
const finite = x => typeof x === 'number' && Number.isFinite(x);
const hz = midi => 440 * 2 ** ((midi - 69) / 12);
function window(pcm, start, end, sr) {
  const a = Math.max(0, Math.ceil(start * sr)), b = Math.min(pcm.length, Math.floor(end * sr));
  if (b <= a) return null;
  let sum = 0; const samples = new Float64Array(b-a); let weight = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = pcm[a+i]; if (!finite(v)) throw Error('nonfinite-pcm');
    const w = .5 - .5 * Math.cos(2*Math.PI*i/Math.max(1,samples.length-1));
    samples[i] = v*w; weight += w; sum += v*v;
  }
  return { samples, weight, startFrame:a, endFrameExclusive:b, seconds:(b-a)/sr, rms:Math.sqrt(sum/samples.length) };
}
function power(w, f, sr) {
  const step = 2*Math.PI*f/sr, cr = Math.cos(step), ci = Math.sin(step);
  let c = 1, s = 0, re = 0, im = 0;
  for (let i = 0; i < w.samples.length; i++) { re += w.samples[i]*c; im += w.samples[i]*s; const nc = c*cr-s*ci; s = s*cr+c*ci; c = nc; }
  return 4*(re*re+im*im)/(w.weight*w.weight);
}
function measuredPeaks(w, midi, sr = SETTINGS.sampleRate) {
  if (!finite(midi) || !w || w.rms < SETTINGS.minimumReferenceRms) return [];
  const f0 = hz(midi), peaks = [];
  for (let h=1; h<=SETTINGS.harmonicCount && h*f0<=SETTINGS.maxFrequency; h++) {
    const nominal = h*f0, span = Math.max(2, nominal*SETTINGS.peakSearchFraction);
    let best = null;
    for (let f=nominal-span; f<=nominal+span+1e-9; f+=SETTINGS.peakGridHz) {
      const p = power(w, f, sr); if (!best || p>best.power) best = { harmonic:h, nominalFrequency:nominal, frequency:f, power:p };
    }
    if (best) peaks.push(best);
  }
  const max = Math.max(...peaks.map(p=>p.power), 0), cutoff = max*10**(SETTINGS.minimumHarmonicRelativeDb/10);
  return peaks.filter(p=>p.power>=cutoff && p.power>0);
}
function measureTransition(pcm, previous, current, next = null, sampleRate = SETTINGS.sampleRate) {
  if (!(pcm instanceof Float32Array) || sampleRate!==44100) throw Error('44100-f32-mono-required');
  const onset = c => finite(c?.r2?.pulseOnsetTime) ? c.r2.pulseOnsetTime : finite(c?.knee?.time) ? c.knee.time : finite(c?.onsetTime) ? c.onsetTime : null;
  const oldTime = onset(previous), newTime = onset(current), nextTime = onset(next);
  const result = { candidateId: current?.id??null, previousCandidateId: previous?.id??null,
    version: VERSION, ratioDb:null, status:'unavailable', reasons:[], oldTime, newTime,
    interpretation:'앞 음의 겹치지 않는 측정 주파수 성분의 전후 비. 줄·울림 원인·연주 품질을 확정하지 않음.',
    onsetAgreementRequired:false, settings:SETTINGS };
  const stop = why => ({...result,reasons:[why]});
  if (oldTime===null || newTime===null) return stop('no-estimated-onset');
  if (newTime<=oldTime) return stop('nonincreasing-onset');
  const oldMidi=finite(previous.medianMidi)?previous.medianMidi:previous.midi;
  const newMidi=finite(current.medianMidi)?current.medianMidi:current.midi;
  if (!finite(oldMidi)||!finite(newMidi)) return stop('missing-pitch-for-overlap-exclusion');
  const oldEnd=newTime-SETTINGS.boundaryGuardSeconds;
  const oldStart=Math.max(oldTime+SETTINGS.isolatedStartSeconds,oldEnd-SETTINGS.referenceMaxSeconds);
  const nextBoundary=nextTime??pcm.length/sampleRate;
  const newStart=newTime+SETTINGS.boundaryGuardSeconds;
  const newEnd=Math.min(nextBoundary-SETTINGS.boundaryGuardSeconds,newStart+SETTINGS.referenceMaxSeconds);
  const oldRef=window(pcm,oldStart,oldEnd,sampleRate), newRef=window(pcm,newStart,newEnd,sampleRate);
  if (!oldRef||!newRef||oldRef.seconds<Math.max(SETTINGS.minimumWindowSeconds,2/hz(oldMidi))||newRef.seconds<Math.max(SETTINGS.minimumWindowSeconds,2/hz(newMidi))) return stop('insufficient-isolated-reference');
  if (oldRef.rms<SETTINGS.minimumReferenceRms) return stop('old-reference-below-floor');
  const oldPeaks=measuredPeaks(oldRef,oldMidi), newPeaks=measuredPeaks(newRef,newMidi);
  if (!oldPeaks.length||!newPeaks.length) return stop('measured-harmonics-unavailable');
  const duration=Math.min(SETTINGS.comparisonWindowSeconds,oldRef.seconds,newRef.seconds);
  const before=window(pcm,newTime-SETTINGS.boundaryGuardSeconds-duration,newTime-SETTINGS.boundaryGuardSeconds,sampleRate);
  const after=window(pcm,newStart,newStart+duration,sampleRate);
  const overlapHz=SETTINGS.overlapRayleighMultiplier/Math.min(before.seconds,after.seconds,oldRef.seconds,newRef.seconds);
  const components=oldPeaks.map(p=>{
    const overlapping=newPeaks.filter(q=>Math.abs(q.frequency-p.frequency)<=overlapHz).map(q=>q.frequency);
    return {...p, overlappingNewFrequencies:overlapping, excluded:overlapping.length>0,
      beforePower:power(before,p.frequency,sampleRate),afterPower:power(after,p.frequency,sampleRate)};
  });
  const valid=components.filter(p=>!p.excluded);
  const pre=valid.reduce((s,p)=>s+p.beforePower,0),post=valid.reduce((s,p)=>s+p.afterPower,0);
  Object.assign(result,{ oldMeasuredPeaks:oldPeaks,newMeasuredPeaks:newPeaks,components,overlapHz,
    windows:{oldReference:[oldRef.startFrame,oldRef.endFrameExclusive],newReference:[newRef.startFrame,newRef.endFrameExclusive],before:[before.startFrame,before.endFrameExclusive],after:[after.startFrame,after.endFrameExclusive]},
    referenceIsolation:'inter-candidate interval, not independently proven isolated; contamination may bias this observation',
    usedComponents:valid.length,totalOldComponents:components.length,
    isolationConfidence:'provisional',beforePower:pre,afterPower:post });
  if (!valid.length) return {...result,reasons:['all-measured-components-overlap-new-note']};
  if (pre<SETTINGS.minimumReferenceRms**2) return {...result,reasons:['comparison-reference-below-floor']};
  return {...result,status:'observed',ratioDb:10*Math.log10(Math.max(post,1e-20)/pre),
    reasons:[],sameRoundedPitch:Math.round(oldMidi)===Math.round(newMidi),
    limitations:['short-window-frequency-leakage','isolated-reference-not-proven','non-overlap-subset-only','pickup-sums-all-strings','no-cause-attribution']};
}
function measureAll(pcm,candidates) {
  return candidates.map((c,i)=>i?measureTransition(pcm,candidates[i-1],c,candidates[i+1]):{
    candidateId:c.id,previousCandidateId:null,status:'unavailable',ratioDb:null,reasons:['no-previous-candidate'],onsetAgreementRequired:false});
}
module.exports={VERSION,SETTINGS,measureTransition,measureAll,measuredPeaks};
