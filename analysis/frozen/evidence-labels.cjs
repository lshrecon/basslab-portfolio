'use strict';

// Additive, provisional evidence descriptions. No detector, reference sequence,
// score, expected beat, take ID or listening label is an input to this module.
const version='evidence-labels-4r2-20260927-v3';
const settings=Object.freeze({provisional:true,strongFlux:20,strongRiseDb:3,changeFluxBelow:5,changeRiseDbBelow:-2,
  toneStartSeconds:.02,toneEndSeconds:.15,toneClarity:.7,noToneQualifyingFrames:0,
  fluxWindowSeconds:.04,fluxFirstHarmonic:2,fluxLastHarmonic:12,fluxStepSeconds:.005,
  fluxSearchStartSeconds:-.01,fluxSearchEndSeconds:.06,fluxPriorFirstSteps:2,fluxPriorLastSteps:7,fluxCapDb:20,
  riseBeforeStartSeconds:-.06,riseBeforeEndSeconds:-.01,riseAfterStartSeconds:-.005,riseAfterEndSeconds:.06,
  onsetSearchSeconds:.08,onsetEnergyRiseDb:2,onsetEnergySpanSeconds:.024,onsetFluxPeak:8,onsetFluxRiseFraction:.2,onsetMinimumRisingSteps:2,
  onsetFluxWindowMustEndBeforeNext:true,onsetFluxWindowMustFitFile:true,
  onsetEnergyWindowMustEndBeforeNext:true,sourceEnergyAnalysisRate:6000,sourceEnergyHalfWindowSeconds:.014,
  sourceEnergyDetectorSha256:'93fa1e4c8574cdbbfcbfdf37bbccdb28a84e21ebe648e01bf4071643e13c61f9'});
const labelText={strong:'발음 근거 강함',uncertain:'발음 여부 불확실',change:'소리 변화 후보'};
const finite=Number.isFinite;
function median(a){if(!a.length)return null;const b=a.slice().sort((x,y)=>x-y);return b[Math.floor(b.length/2)];}
function energyDb(f){return 20*Math.log10(f.energy+1e-9);}
function classifyEvidence(f){
  if(!f||!finite(f.flux)||!finite(f.riseDb)||!finite(f.toneFramesAfter)||f.valid===false)return 'uncertain';
  if(f.flux>=settings.strongFlux||f.riseDb>=settings.strongRiseDb)return 'strong';
  if(f.flux<settings.changeFluxBelow&&f.riseDb<settings.changeRiseDbBelow&&f.toneFramesAfter===0&&f.toneWindowComplete!==false)return 'change';
  return 'uncertain';
}
function frameWindow(frames,a,b){return frames.filter(f=>f.time>=Math.max(0,a)&&f.time<b);}
function localPitch(frames,t){
  const dt=frames.length>1?frames[1].time-frames[0].time:.006,i=Math.round(t/dt);
  const take=(a,b)=>frames.slice(Math.max(0,a),Math.min(frames.length,b)).filter(f=>f.voiced&&finite(f.midi)).map(f=>f.midi);
  const after=take(i+3,i+14);if(after.length>=3)return median(after);
  const before=take(i-12,i);return before.length>=3?median(before):null;
}
function harmonicSeries(mono,sr,t,midi){
  if(!finite(midi))return {flux:null,points:[],validWindows:0,invalidWindows:0,harmonics:[]};
  const size=Math.max(4,Math.round(sr*settings.fluxWindowSeconds)),f0=440*Math.pow(2,(midi-69)/12);
  const window=Float64Array.from({length:size},(_,i)=>.5-.5*Math.cos(2*Math.PI*i/size));
  const harmonics=[];for(let k=2;k<=12;k++)if(k*f0<sr/2)harmonics.push({k,coef:2*Math.cos(2*Math.PI*k*f0/sr)});
  if(!harmonics.length)return {flux:null,points:[],validWindows:0,invalidWindows:0,harmonics:[]};
  const cache=new Map();
  const amplitudeAt=o=>{if(o<0||o+size>mono.length)return null;if(cache.has(o))return cache.get(o);const a=[];
    for(const h of harmonics){let s1=0,s2=0;for(let n=0;n<size;n++){const value=mono[o+n];if(!finite(value))return null;const v=value*window[n]+h.coef*s1-s2;s2=s1;s1=v;}a.push(10*Math.log10(Math.max(0,s1*s1+s2*s2-h.coef*s1*s2)/size+1e-14));}cache.set(o,a);return a;};
  const points=[];let invalidWindows=0;
  // The feature probe names a forward-window start t+offset. For the onset
  // estimator we explicitly report its centre; no filter-delay subtraction.
  for(let step=0;step<=14;step++){
    const startSeconds=t+settings.fluxSearchStartSeconds+step*settings.fluxStepSeconds,o=Math.round(startSeconds*sr),now=amplitudeAt(o);
    if(!now){invalidWindows++;continue;}const previous=[];
    for(let j=2;j<=7;j++){const a=amplitudeAt(o-Math.round(j*settings.fluxStepSeconds*sr));if(a)previous.push(a);}
    if(!previous.length){invalidWindows++;continue;}let flux=0;
    for(let k=0;k<harmonics.length;k++)flux+=Math.min(20,Math.max(0,now[k]-Math.max(...previous.map(a=>a[k]))));
    points.push({time:(o+size/2)/sr,value:flux,windowStartFrame:o,windowEndFrameExclusive:o+size,priorWindows:previous.length});
  }
  return {flux:points.length?Math.max(...points.map(q=>q.value)):null,points,validWindows:points.length,invalidWindows,harmonics:harmonics.map(h=>h.k)};
}
function risingCandidates(points,lower,upper,kind){
  const found=[];
  for(let i=0;i<points.length-1;i++){
    const a=points[i];if(a.time<lower||a.time>=upper)continue;
    if(i>0&&a.value>points[i-1].value)continue; // already inside a rise: its start is outside the search
    if(points[i+1].value<=a.value+1e-12)continue; // use the end of a flat valley, not its beginning
    let positiveSteps=0;
    for(let j=i+1;j<points.length;j++){
      const b=points[j];if(b.time>=upper||b.value<points[j-1].value)break;
      if(kind==='energy'&&b.time-a.time>settings.onsetEnergySpanSeconds+1e-12)break;
      if(b.value>points[j-1].value+1e-12)positiveSteps++;
      const enough=kind==='energy'?b.value-a.value>=settings.onsetEnergyRiseDb:
        b.value>=settings.onsetFluxPeak&&a.value<=b.value*settings.onsetFluxRiseFraction;
      if(enough&&positiveSteps>=settings.onsetMinimumRisingSteps){found.push({time:a.time,kind,startValue:a.value,supportTime:b.time,supportValue:b.value,positiveSteps});break;}
    }
  }
  return found;
}
function findAcousticOnset(frames,fluxPoints,rhoTime,nextRhoTime,duration,sr){
  const maxTime=Math.min(rhoTime+settings.onsetSearchSeconds,duration);
  // Half-open next-candidate boundary avoids assigning a later event's rise to
  // this one. Search-end itself remains inclusive when no following event exists.
  const exclusiveNext=finite(nextRhoTime)?nextRhoTime:Infinity;
  const upper=Math.min(maxTime+1e-10,exclusiveNext);
  const fluxWindowsExcluded={missingBounds:0,beyondNextCandidate:0,beyondFile:0};
  const boundedFluxPoints=fluxPoints.filter(q=>{
    if(!finite(q.windowEndFrameExclusive)){fluxWindowsExcluded.missingBounds++;return false;}
    const end=q.windowEndFrameExclusive/sr;
    if(end>exclusiveNext){fluxWindowsExcluded.beyondNextCandidate++;return false;}
    if(end>duration){fluxWindowsExcluded.beyondFile++;return false;}
    return true;
  });
  // Reconstruct the exact cached RMS support from the frozen source: analysis
  // rate min(sr,6000), halfEnergy round(rate*0.014), hi=min(x.length,center+half).
  const energyRate=Math.min(sr,settings.sourceEnergyAnalysisRate),energyHalfFrames=Math.round(energyRate*settings.sourceEnergyHalfWindowSeconds);
  const sourceFrames=Math.round(duration*sr),preparedFrames=Math.floor(sourceFrames*energyRate/sr),energyWindowsExcluded={beyondNextCandidate:0};
  const energyPoints=frames.filter(f=>f.time>=rhoTime-.03&&f.time<=maxTime&&f.time<exclusiveNext).map(f=>{
    const center=Math.round(f.time*energyRate),end=Math.min(preparedFrames,center+energyHalfFrames);
    return {time:f.time,value:energyDb(f),windowEndFrameExclusive:end,windowEndSeconds:end/energyRate};
  }).filter(q=>{if(q.windowEndSeconds>exclusiveNext){energyWindowsExcluded.beyondNextCandidate++;return false;}return q.windowEndSeconds<=duration;});
  const candidates=risingCandidates(energyPoints,rhoTime,upper,'energy').concat(risingCandidates(boundedFluxPoints,rhoTime,upper,'harmonic-flux')).sort((a,b)=>a.time-b.time||(a.kind==='energy'?-1:1));
  const chosen=candidates[0]||null;let acousticOnsetTime=null,frame=null,reason='no-qualified-rise';
  if(chosen){frame=Math.round(chosen.time*sr);const rounded=frame/sr;
    if(rounded>=rhoTime&&rounded<=maxTime&&rounded<exclusiveNext&&frame>=0&&frame<Math.round(duration*sr)){acousticOnsetTime=rounded;reason='qualified-rising-start';}else{frame=null;reason='rounding-crosses-search-boundary';}}
  return {acousticOnsetTime,deltaSeconds:acousticOnsetTime===null?null:acousticOnsetTime-rhoTime,
    timingUncertain:acousticOnsetTime===null,onsetEvidence:{method:'earliest-qualified-rising-start; energy wins exact-time ties',reason,provisional:true,
      searchStartSeconds:rhoTime,searchEndSeconds:maxTime,nextCandidateExclusiveSeconds:finite(nextRhoTime)?nextRhoTime:null,
      chosen,alternatives:candidates,roundedSample:frame,roundingErrorSeconds:chosen&&frame!==null?frame/sr-chosen.time:null,
      fileEndLimited:duration<rhoTime+settings.onsetSearchSeconds,nextCandidateLimited:finite(nextRhoTime)&&nextRhoTime<=maxTime,
      fluxWindowsExcluded,fluxWindowBoundaryCheck:'full window end-exclusive <= next candidate and file end',
      energyWindowsExcluded,energyWindowBoundaryCheck:'full source-reconstructed RMS window end-exclusive <= next candidate; source file-edge clamp retained',
      energySupport:{analysisRate:energyRate,halfWindowFrames:energyHalfFrames,sourceFrames,preparedFrames,sourceSha256:settings.sourceEnergyDetectorSha256},
      energyRiseDb:settings.onsetEnergyRiseDb,energySpanSeconds:settings.onsetEnergySpanSeconds,fluxPeak:settings.onsetFluxPeak,fluxRiseFraction:settings.onsetFluxRiseFraction,
      note:'Estimated rising edge only. Not validated as perceptual onset; no fixed delay correction or merging.'}};
}
function annotateEvidence(mono,sampleRate,raw,options={}){
  if(!raw||!Array.isArray(raw.notes))throw new TypeError('raw.notes must be an array');
  const frames=Array.isArray(raw.frames)?raw.frames:[],duration=mono&&finite(sampleRate)&&sampleRate>0?mono.length/sampleRate:0;
  const signalValid=(ArrayBuffer.isView(mono)||Array.isArray(mono))&&finite(sampleRate)&&sampleRate>=1000&&finite(duration);
  const framesValid=frames.length>0&&frames.every((f,i)=>finite(f.time)&&finite(f.energy)&&f.energy>=0&&(!i||f.time>frames[i-1].time));
  const notes=raw.notes.map((note,index)=>{
    const rhoTime=finite(note.startSeconds)?note.startSeconds:null,next=raw.notes[index+1]?.startSeconds;
    let features={valid:false,flux:null,riseDb:null,toneFramesAfter:null,toneWindowComplete:false,reason:!signalValid?'invalid-signal':!framesValid?'missing-or-invalid-frames':'invalid-rho-time'};
    let timing={acousticOnsetTime:null,deltaSeconds:null,timingUncertain:true,onsetEvidence:{reason:'features-unavailable',provisional:true}};
    if(signalValid&&framesValid&&rhoTime!==null&&rhoTime>=0&&rhoTime<duration){
      const midi=localPitch(frames,rhoTime),harmonic=harmonicSeries(mono,sampleRate,rhoTime,midi);
      const before=frameWindow(frames,rhoTime-.06,rhoTime-.01),after=frameWindow(frames,rhoTime-.005,rhoTime+.06);
      const beforeDb=before.length?Math.max(...before.map(energyDb)):null,afterDb=after.length?Math.max(...after.map(energyDb)):null;
      const tone=frameWindow(frames,rhoTime+.02,rhoTime+.15),toneFramesAfter=tone.filter(f=>f.voiced&&finite(f.clarity)&&f.clarity>=settings.toneClarity).length;
      const riseDb=beforeDb===null||afterDb===null?null:afterDb-beforeDb;
      features={valid:finite(harmonic.flux)&&finite(riseDb),flux:harmonic.flux,riseDb,toneFramesAfter,toneWindowComplete:rhoTime+.15<=duration,
        toneDefinition:'count of voiced frames with clarity >= 0.7 in [rho+20ms,rho+150ms); no tone means exactly 0',
        localMidi:midi,beforePeakDb:beforeDb,afterPeakDb:afterDb,beforeFrameCount:before.length,afterFrameCount:after.length,
        toneAvailableFrameCount:tone.length,fluxValidWindows:harmonic.validWindows,fluxInvalidWindows:harmonic.invalidWindows,
        fluxHarmonics:harmonic.harmonics,fluxTrace:harmonic.points,reason:finite(harmonic.flux)&&finite(riseDb)?null:'feature-not-observable'};
      timing=findAcousticOnset(frames,harmonic.points,rhoTime,finite(next)?next:null,duration,sampleRate);
      if(!features.valid)timing={acousticOnsetTime:null,deltaSeconds:null,timingUncertain:true,onsetEvidence:{...timing.onsetEvidence,reason:'features-unavailable',chosen:null,roundedSample:null}};
    }
    const label=classifyEvidence(features);
    return {...note,evidence:{version,label,labelText:labelText[label],rhoTime,...timing,features,provisional:true}};
  });
  // Every original property, including unread/glide flags and timestamps, remains.
  return {...raw,notes,evidenceLabels:{version,settings,provisional:true,rawNoteCount:raw.notes.length,decoratedNoteCount:notes.length,hiddenCount:0}};
}
module.exports={version,settings,annotateEvidence,classifyEvidence,_test:{harmonicSeries,risingCandidates,findAcousticOnset,localPitch}};
