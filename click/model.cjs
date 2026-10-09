'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const bytes=fs.readFileSync(path.join(__dirname,'config.json'));
function freeze(x){if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;}
const CONFIG=freeze(JSON.parse(bytes)),CONFIG_SHA256=crypto.createHash('sha256').update(bytes).digest('hex');
const finite=n=>typeof n==='number'&&Number.isFinite(n);
const integer=n=>Number.isSafeInteger(n)&&n>=0;
function configForRun(run){
 const value=run?.clickCalibration;
 if(value?.validatedForThisEngine===true&&integer(value.kFrames)&&value.kFrames<=22050&&typeof value.measurementId==='string'&&value.measurementId&&typeof value.deviceKey==='string'&&value.deviceKey)return{...CONFIG,kFrames:value.kFrames,validatedForThisEngine:true,source:value.source||'stored cable calibration for this machine and device selection',calibrationStatus:'recorded-device-calibration',measurementId:value.measurementId,deviceKey:value.deviceKey};
 return CONFIG;
}
function renderClicks(run,config=configForRun(run)){
 const errors=[],events=[],unrecordedEvents=[],scheduleRows=[],rate=config.sampleRate;
 if(rate!==44100||run?.format?.sampleRate!==rate||run?.pcm?.sampleRate!==rate)errors.push('unsupported-sample-rate');
 if(!integer(config.kFrames))errors.push('invalid-k-frames');
 if(run?.pcm?.firstFrame!=null&&run.pcm.firstFrame!==0)errors.push('unsupported-nonzero-pcm-origin');
 if(!Array.isArray(run?.schedule)||!run.schedule.length)errors.push('missing-click-schedule');
 const end=integer(run?.pcm?.frameCount)?run.pcm.frameCount:null;if(end==null)errors.push('missing-recorded-pcm-bound');
 const ids=new Set();let last=-Infinity;
 for(const[order,row]of(run?.schedule??[]).entries()){
  const i=integer(row.index)?row.index:order;if(ids.has(i))errors.push('duplicate-click-index:'+i);ids.add(i);
  const planned=integer(row.pcmLocalFrame)?row.pcmLocalFrame:integer(row.requestedCaptureFrame)?row.requestedCaptureFrame:null;
  const resource=({accent:'accent',subdiv:'subdivision',subdivision:'subdivision',lastbar:'lastbar',finish:'finish'})[row.variant]??(row.accent===true?'accent':'subdivision');
  const common={scheduleIndex:i,countIn:row.countIn===true,kind:row.kind??(row.countIn?'count-in':'practice'),accent:row.accent===true,resource,plannedPcmFrame:planned};
  if(!integer(row.actualRenderFrame)||row.submitted!==true){
   if(end!=null&&planned!=null&&planned>=end){scheduleRows.push({...common,recorded:false,unrecorded:true,reason:'planned-start-at-or-after-saved-end',h:null});}
   else{errors.push('missing-actual-render-frame:'+i);scheduleRows.push({...common,recorded:false,unrecorded:false,unknown:true,reason:'actual-frame-unknown-within-recorded-range',h:null});}
   continue;
  }
  if(row.actualRenderFrame<=last)errors.push('nonmonotonic-click-frame:'+i);last=row.actualRenderFrame;
  const frame=row.actualRenderFrame+config.kFrames,h=frame/rate;
  if(!Number.isSafeInteger(frame)||frame<0)errors.push('invalid-arrival-frame:'+i);
  const submittedFrames=integer(row.submittedWaveformBytes)?Math.floor(row.submittedWaveformBytes/6):2205;
  const recorded=end!=null&&frame<end;
  const event={...common,actualRenderFrame:row.actualRenderFrame,frame,h,timeSeconds:h,submitted:true,source:'actualRenderFrame-plus-K',recorded,unrecorded:!recorded,playbackFrames:recorded?Math.max(0,Math.min(2205,submittedFrames,end-frame)):0,waveformTruncated:submittedFrames<2205||(end!=null&&frame+2205>end)};
  scheduleRows.push(event);if(recorded)events.push(event);else unrecordedEvents.push({...event,reason:'actual-click-arrival-at-or-after-saved-end'});
 }
 return{available:errors.length===0,status:errors.length?'unavailable':'available',events,unrecordedEvents,scheduleRows,errors,sampleRate:rate,kFrames:config.kFrames,recordedFrameCount:end,provisional:true,configSha256:config===CONFIG?CONFIG_SHA256:null};
}
function extractTime(candidate,config){
 const state=candidate.selectedState??candidate.states?.[config.agreementSchemeId]??null,stateName=state?.state??state??null;
 const r2=finite(candidate.r2?.pulseOnsetTime)?candidate.r2.pulseOnsetTime:null,knee=finite(candidate.knee?.time)?candidate.knee.time:null,rho=finite(candidate.rhoTime)?candidate.rhoTime:null;
 const period=finite(candidate.knee?.periodSeconds)&&candidate.knee.periodSeconds>0?candidate.knee.periodSeconds:finite(state?.periodSeconds)&&state.periodSeconds>0?state.periodSeconds:null;
 // The correction compares estimators only; raw knee remains the knee-only onset.
 const difference=r2!=null&&knee!=null?Math.abs(r2-(knee-.00276)):null;
 // Four machine epsilons at the input time scale cover subtraction rounding only.
 const roundingEpsilon=Number.EPSILON*Math.max(1,Math.abs(r2??0),Math.abs(knee??0),period??0)*4;
 const noMeasuredOnset=r2===null&&knee===null;
 const periodDisagreement=stateName==='hold'&&state?.reason==='estimator-disagreement'&&difference!=null&&period!=null&&difference+roundingEpsilon>=period;
 // rhoTime locates audio for listening/pairing; it is not an observed onset.
 const timingUnavailable=noMeasuredOnset||periodDisagreement;
 const timingUnavailableReason=noMeasuredOnset?'no-measured-onset':periodDisagreement?'estimator-disagreement-one-period':null;
 const timingUnavailableText=noMeasuredOnset?'음 시작을 측정하지 못함 · 주변 듣기 위치만 있음':periodDisagreement?'시작을 한 가지로 정하지 못함 · 두 방법이 한 파동쯤 다름':null;
 const rawTime=r2??knee??rho,timeSource=r2!=null?'r2':knee!=null?'knee':rho!=null?'rho':null;
 const playbackTimeSeconds=periodDisagreement?Math.min(r2,knee):rawTime;
 return{timeSeconds:timingUnavailable?null:rawTime,timeSource:timingUnavailable?null:timeSource,playbackTimeSeconds,pairingTimeSeconds:playbackTimeSeconds,measuredTimingCandidate:!noMeasuredOnset,agreement:!timingUnavailable&&(state?.state==='agree'||state==='agree'||state==='agreement')&&r2!=null,state:stateName,timingUnavailable,timingUnavailableReason,timingUnavailableText};
}
function resolveSlotPlan(run,clicks,timing){
 const errors=[],all=clicks.scheduleRows.filter(e=>!e.countIn&&!['finish','calibration'].includes(e.kind)),legacy=['practice-4-quarter-countin-56-beats-tail2-v1','guided-8-quarter-countin-16-sixteenth-tail2-v1'];
 if(run.clickMode==='sixteenth'||run.clickMode==='quarter')return{n:run.plannedNoteCount,mode:run.clickMode,practice:all,source:'explicit-run-clickMode-and-plannedNoteCount',errors};
 const frames=Array.isArray(timing?.plannedSlots)?timing.plannedSlots.map(s=>s.plannedPcmLocalFrame):Array.isArray(timing?.plannedNoteFrames)?timing.plannedNoteFrames:null;
 if(frames){
  if(!legacy.includes(run.scheduleVersion)||run.subdivision!==4||timing.sampleRate!==44100)errors.push('unsupported-legacy-task-timing');
  if(!frames.length||frames.some((f,i)=>!integer(f)||(i>0&&f<=frames[i-1])))errors.push('invalid-planned-task-frames');
  const practice=frames.map((frame,i)=>{const match=all.filter(e=>e.plannedPcmFrame===frame&&run.schedule.find(s=>s.index===e.scheduleIndex)?.pcmLocalFrame===frame);if(match.length!==1){errors.push('task-frame-schedule-binding-not-unique:'+i);return{h:null,reason:'missing-exact-task-to-schedule-binding'};}return match[0];});
  return{n:frames.length,mode:'sixteenth',practice,source:'legacy-task-frames-exactly-bound-to-schedule-pcmLocalFrame',errors,bindings:practice.map((s,i)=>({slotIndex:i+1,plannedPcmLocalFrame:frames[i],scheduleIndex:s.scheduleIndex??null,actualRenderFrame:s.actualRenderFrame??null}))};
 }
 if(run.scheduleVersion==='guided-8-quarter-countin-16-sixteenth-tail2-v1'&&run.subdivision===4&&run.practiceClickCount===16&&all.length===16)return{n:16,mode:'sixteenth',practice:all,source:'explicit-guided-schedule-version-and-practiceClickCount',errors};
 return{n:null,mode:null,practice:[],source:'unavailable',errors:['missing-explicit-slot-plan-no-default-32']};
}
function buildSlots(run,clicks,config,timing){
 const plan=resolveSlotPlan(run,clicks,timing),n=plan.n,practice=plan.practice,slots=[],unrecordedSlots=[],unknownSlots=[],errors=plan.errors.slice();
 if(!integer(n)||n<1||n>4096)return{slots,unrecordedSlots,unknownSlots,plannedTotalSlots:n,errors:errors.concat('invalid-slot-count'),plan:{source:plan.source,mode:plan.mode,bindings:null}};
 if(!finite(run.bpm)||run.bpm<=0)return{slots,unrecordedSlots,unknownSlots,plannedTotalSlots:n,errors:['invalid-bpm']};
 const end=clicks.recordedFrameCount/config.sampleRate;
 const add=s=>{if(finite(s.h)){if(s.h>=end){unrecordedSlots.push({...s,recorded:false,reason:'slot-at-or-after-saved-end'});return;}Object.assign(s,{recorded:true,candidateId:null,timeSeconds:null,playbackTimeSeconds:null,pairingTimeSeconds:null,deltaMs:null,timeSource:null,agreement:false,timingUnavailable:false,timingUnavailableReason:null,timingUnavailableText:null});slots.push(s);}else if(s.unrecorded)unrecordedSlots.push({...s,recorded:false});else unknownSlots.push({...s,recorded:false,unknown:true});};
 if(plan.mode==='sixteenth'){
  if(practice.length!==n)errors.push('practice-click-count-does-not-match-slots');
  for(let i=0;i<n;i++){const p=practice[i];if(!p){add({index:i+1,h:null,reason:'missing-planned-click-row'});continue;}add({index:i+1,h:p.h,clickTimeSeconds:p.h,anchorSource:'actual-click',scheduleIndex:p.scheduleIndex,interpolated:false,unrecorded:p.unrecorded,reason:p.reason});}
 }else if(plan.mode==='quarter'){
  if(practice.length!==Math.ceil(n/4))errors.push('quarter-click-count-does-not-match-slots');
  for(let i=0;i<n;i++){const q=Math.floor(i/4),part=i%4,a=practice[q],next=practice[q+1];if(!a||!finite(a.h)){add({index:i+1,h:null,unrecorded:a?.unrecorded??false,reason:a?.reason??'missing-quarter-click'});continue;}const nextKnown=next&&finite(next.h),interval=nextKnown?next.h-a.h:60/run.bpm,h=a.h+interval*part/4;add({index:i+1,h,clickTimeSeconds:h,anchorSource:part===0?'actual-click':nextKnown?'interpolated-adjacent-actual-clicks':'last-quarter-planned-interval',scheduleIndex:a.scheduleIndex,interpolated:part!==0});}
 }else errors.push('unknown-click-mode');
 for(let i=1;i<slots.length;i++)if(slots[i].h<=slots[i-1].h)errors.push('nonmonotonic-slot');
 return{slots,unrecordedSlots,unknownSlots,plannedTotalSlots:n,errors,plan:{source:plan.source,mode:plan.mode,bindings:plan.bindings??null}};
}
function buildClickAnchor({run,candidates,timing,monitorRoute,config=configForRun(run)}){const rendered=renderClicks(run,config),built=buildSlots(run,rendered,config,timing),errors=rendered.errors.concat(built.errors),slots=built.slots;const base={schema:'basslab-click-anchor-v12',available:errors.length===0,status:errors.length?'unavailable':'available',provisional:true,slotPlan:built.plan??null,plannedTotalSlots:built.plannedTotalSlots,unrecordedSlots:built.unrecordedSlots,unknownSlots:built.unknownSlots,slots,extras:[],invalidCandidates:[],candidates:[],clickEvents:rendered.events,errors,calibration:{kFrames:config.kFrames,kMilliseconds:config.kFrames*1000/config.sampleRate,validatedForThisEngine:config.validatedForThisEngine,source:config.source,status:config.calibrationStatus},configSha256:config===CONFIG?CONFIG_SHA256:null,referenceBandsMs:config.referenceBandsMs,referenceBandsAreEstimatorAccuracy:false,monitorRoute:monitorRoute??run.monitorRoute??'unknown'};const list=(Array.isArray(candidates)?candidates:[]).map((c,i)=>({candidateId:c.id??i+1,sourceOrder:i,noteName:c.noteName??null,...extractTime(c,config),matchedSlotIndex:null,deltaMs:null,kind:'unassigned'}));base.candidates=list;if(errors.length||!slots.length){base.available=false;base.status='unavailable';base.summary={matchedCount:0,totalSlots:slots.length,plannedTotalSlots:built.plannedTotalSlots,unrecordedCount:built.unrecordedSlots.length,unavailable:true};base.counts={matched:0,missing:slots.length,extra:0,early:0,after:0,invalid:list.length};return base;}const nominal=60/run.bpm/4,firstHalf=slots.length>1?(slots[1].h-slots[0].h)/2:nominal/2,lastHalf=slots.length>1?(slots.at(-1).h-slots.at(-2).h)/2:nominal/2,eps=1e-12;const groups=new Map();for(const c of list){const pairingTime=c.pairingTimeSeconds;if(!finite(pairingTime)||pairingTime<0||(integer(run.pcm?.frameCount)&&pairingTime>=run.pcm.frameCount/config.sampleRate)){c.kind='invalid';c.reason='candidate-time-missing-or-outside-pcm';base.invalidCandidates.push(c);continue;}if(pairingTime<slots[0].h-firstHalf-eps){c.kind='preparation';base.extras.push(c);continue;}if(pairingTime>slots.at(-1).h+lastHalf+eps){c.kind='after';base.extras.push(c);continue;}let best=slots[0],distance=Math.abs(pairingTime-best.h);for(const s of slots.slice(1)){const d=Math.abs(pairingTime-s.h);if(d<distance-eps){best=s;distance=d;}}c.pairingDeltaMs=(pairingTime-best.h)*1000;c.deltaMs=c.timingUnavailable?null:c.pairingDeltaMs;c.nearestSlotIndex=best.index;(groups.get(best.index)??(groups.set(best.index,[]),groups.get(best.index))).push(c);}for(const s of slots){const group=groups.get(s.index)??[];group.sort((a,b)=>Number(b.measuredTimingCandidate)-Number(a.measuredTimingCandidate)||Math.abs(a.pairingDeltaMs)-Math.abs(b.pairingDeltaMs)||a.pairingTimeSeconds-b.pairingTimeSeconds||a.sourceOrder-b.sourceOrder);if(group.length){const chosen=group[0];chosen.kind='matched';chosen.matchedSlotIndex=s.index;Object.assign(s,{candidateId:chosen.candidateId,timeSeconds:chosen.timeSeconds,deltaMs:chosen.deltaMs,timeSource:chosen.timeSource,agreement:chosen.agreement,noteName:chosen.noteName,playbackTimeSeconds:chosen.playbackTimeSeconds,pairingTimeSeconds:chosen.pairingTimeSeconds,timingUnavailable:chosen.timingUnavailable,timingUnavailableReason:chosen.timingUnavailableReason,timingUnavailableText:chosen.timingUnavailableText});for(const extra of group.slice(1)){extra.kind='extra';base.extras.push(extra);}}}
const matched=slots.filter(s=>s.candidateId!=null),timed=matched.filter(s=>finite(s.deltaMs)),values=timed.map(s=>s.deltaMs),mean=values.length?values.reduce((a,b)=>a+b,0)/values.length:null,sd=values.length?Math.sqrt(values.reduce((a,b)=>a+(b-mean)**2,0)/values.length):null;const within=ms=>values.filter(v=>Math.abs(v)<=ms+1e-9).length;const early=base.extras.filter(c=>c.kind==='early').length,after=base.extras.filter(c=>c.kind==='after').length,extra=base.extras.filter(c=>c.kind==='extra').length;const mostDeviant=timed.filter(s=>Math.abs(s.deltaMs)>40+1e-9).sort((a,b)=>Math.abs(b.deltaMs)-Math.abs(a.deltaMs)||a.index-b.index).slice(0,3).map(s=>({index:s.index,candidateId:s.candidateId,deltaMs:s.deltaMs,direction:s.deltaMs<0?'early':'late'}));const overall=base.monitorRoute==='direct'&&mean!=null?Math.abs(mean)<=config.nearMeanMs?'전체로는 클릭과 거의 같이':mean<0?'전체로 클릭보다 조금 앞':'전체로 클릭보다 조금 뒤':null;base.counts={matched:matched.length,missing:slots.length-matched.length,extra,early,after,invalid:base.invalidCandidates.length};base.summary={matchedCount:matched.length,measuredTimingCount:timed.length,timingUnavailableCount:matched.length-timed.length,totalSlots:slots.length,plannedTotalSlots:built.plannedTotalSlots,unrecordedCount:built.unrecordedSlots.length,missingCount:slots.length-matched.length,extraCount:extra,earlyCount:early,preparationCount:base.extras.filter(c=>c.kind==='preparation').length,afterCount:after,within20Count:within(20),within30Count:within(30),within40Count:within(40),meanMs:mean,populationSdMs:sd,sampleSdMs:values.length>1?sd*Math.sqrt(values.length/(values.length-1)):null,minimumMs:values.length?Math.min(...values):null,maximumMs:values.length?Math.max(...values):null,mostDeviant,overallText:overall,matchedText:`클릭 ${slots.length}개 가운데 ${matched.length}개에 음이 있었습니다`,within40Text:`${within(40)}개는 클릭과 함께`,afterText:after?`끝난 뒤에 ${after}음을 더 쳤습니다`:null};return base;}
module.exports={CONFIG,CONFIG_SHA256,configForRun,renderClicks,buildClickAnchor,extractTime};
