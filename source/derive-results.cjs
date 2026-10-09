'use strict';
const fs=require('node:fs'),path=require('node:path');
const {ROOT,W,identity,read,verifyCatalogue}=require('./input-catalogue.cjs');
const {analyzeEvenness}=require('../analysis/evenness-v2.cjs');
const {measureAll}=require('../analysis/remaining-component.cjs');
const {noteName}=require('../analysis/signal-pipeline.cjs');
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const save=(file,x)=>fs.writeFileSync(file,JSON.stringify(x,null,2)+'\n',{flag:'wx'});
function positions(take){
 const t=take.timing;
 if(Array.isArray(t.plannedSlots))return t.plannedSlots.map((p,i)=>({index:i,timeSeconds:p.plannedPcmLocalFrame/44100,expectedMidi:['N1','N5'].includes(take.code)?null:p.midi,plannedString:p.string,plannedFret:p.fret}));
 return t.plannedNoteFrames.map((f,i)=>({index:i,timeSeconds:f/44100,expectedMidi:take.task.expectedMidi}));
}
function derive(result,take,decision,memo,levels={}){
 const duration=take.pcm.bytes/4/44100, planned=positions(take), selected=result.selectedCandidates;
 const getOnset=c=>finite(c.r2?.pulseOnsetTime)?c.r2.pulseOnsetTime:finite(c.knee?.time)?c.knee.time:null;
 const even=analyzeEvenness({takeId:take.takeId,taskId:take.code,candidates:selected.map(c=>({id:c.id,rhoTime:c.rhoTime,
   onsetTime:getOnset(c),state:({agree:'agreement',hold:'deferred',unmeasured:'unmeasured'})[c.selectedState.state],
   midi:c.midi,noteName:c.noteName,positionReliable:false,uncertainMetadata:c.selectedState.uncertainMetadataOnly})),
   plannedPositions:planned,playStartSeconds:take.timing.playStartFrame/44100,playEndSeconds:duration,
   metronomeBpm:take.bpm,subdivisionsPerBeat:4,monitoringRoute:take.monitoringRoute??'unknown',clickKind:take.clickMode??'sixteenth',
   taskComparable:!['N1','N5'].includes(take.code),recordedDate:take.recordedDate??null,sessionOrder:take.sessionOrder??null,
   benchmark:decision.threeGatesPass?{threeGatesPass:true,referenceBandMs:decision.referenceBandMs,evidenceId:decision.evidenceId}:{}
 });
 const rowById=new Map(even.rows.map(r=>[r.id,r]));
 // Within-take measured RMS only; this is not force, quality or clip normalization.
 const notes=selected.map(c=>{const r=rowById.get(c.id);
  return{index:c.id,slotIndex:r.positionIndex===null?null:r.positionIndex+1,noteName:c.noteName,timeSeconds:getOnset(c)??c.rhoTime,
   measuredOnsetTime:getOnset(c),listeningLocatorOnly:getOnset(c)===null,status:({agree:'agreement',hold:'reserved',unmeasured:'unmeasured'})[c.selectedState.state],
   inWindow:r.inWindow,residualMs:r.fittedResidualMs,levelRelativeDb:levels[c.id]?.relativeDb??null,levelMeasurement:levels[c.id]??null,
   reason:c.selectedState.reason,taskMismatch:r.taskMismatch,positionMapping:r.mapping,pitchUncertain:c.pitchUncertain};});
 const rejected=(result.rawDetector?.diagnostics?.rejectedCandidates||[]).map((c,i)=>({id:'rejected-'+(i+1),timeSeconds:c.time,gateEvidence:c.gateEvidence,reasons:c.reasons??[],observedOnsetTime:null,agreement:false}));
 const ui={takeId:take.takeId,label:take.code+' · '+(take.task.label??'안내 A현 개방'),taskId:take.code,
   expectedCount:even.scope.plannedInScope.length,candidateCount:even.counts.inWindowCandidates,durationSeconds:duration,
   audioUrl:'/api/audio/'+encodeURIComponent(take.takeId),monitorRoute:take.monitoringRoute??'unknown',clickMode:take.clickMode??'sixteenth',
   performanceNote:typeof memo==='string'?memo:JSON.stringify(memo),taskCorrespondence:['N1','N5'].includes(take.code)?'unknown':'task-intent-only',
   outsideCount:even.counts.outsideWindowCandidates,tempo:{metronomeBpm:take.bpm,actualBpm:even.actualBpm,driftNotes:even.cumulativeSpacingDriftNotes},
   evenness:{provisional:!even.referenceBand,bandAllowed:!!even.referenceBand,bandMs:even.referenceBand?.halfWidthMs??null,
    measuredCount:even.coverage.numerator,populationCount:even.coverage.denominator,validAdjacentPairs:even.counts.validAdjacentPairs,
    gridSpreadMs:even.details.fittedResidualPopulationSdMs,intervalSpreadMs:even.details.intervalResidualPopulationSdMs,
    fixedGridSpreadMs:even.details.fixedGrid.residualPopulationSdMs},notes,missedPositions:even.missingPositions,rejectedCandidates:rejected,
   excluded:false,observationOnly:take.code==='N9',firstScreen:even.firstScreen,positionMapping:even.mapping,originalPcm:take.pcm,
   lateEntry:notes.length?notes.filter(n=>n.inWindow)[0]?.timeSeconds>take.timing.playStartFrame/44100+.06:false,
   lateEntryMeaning:'first candidate relative to planned start, informational; device/monitor latency not removed'};
 ui.missedPositions=even.missingPositions.map(p=>({...p,slotIndex:p.positionIndex+1}));
 return {code:take.code,takeId:take.takeId,evenness:even,rejectedCandidates:rejected,ui};
}
function readMemo(file){const m=read(file);return m.note??m.text??m.memo??m.comment??m;}
function decode(file){const b=fs.readFileSync(file);const a=new Float32Array(b.length/4);for(let i=0;i<a.length;i++)a[i]=b.readFloatLE(i*4);return a;}
function relativeLevels(pcm,candidates,playStartFrame){
 const time=c=>finite(c.r2?.pulseOnsetTime)?c.r2.pulseOnsetTime:finite(c.knee?.time)?c.knee.time:c.rhoTime;
 const rows=candidates.map((c,i)=>{const a=Math.max(0,Math.round(time(c)*44100)),next=i+1<candidates.length?Math.round(time(candidates[i+1])*44100):pcm.length;
  const b=Math.min(pcm.length,a+3528,next-441);if(b-a<882)return{id:c.id,rms:null,relativeDb:null,reason:'less-than-20ms-window'};
  let sq=0;for(let j=a;j<b;j++)sq+=pcm[j]*pcm[j];return{id:c.id,startFrame:a,endFrameExclusive:b,rms:Math.sqrt(sq/(b-a)),
   measuredOnsetAvailable:finite(c.r2?.pulseOnsetTime)||finite(c.knee?.time),inPerformance:a>=playStartFrame,meaning:'20–80ms RMS relative to median inside this take; not striking force'};});
 const values=rows.filter(r=>r.inPerformance&&finite(r.rms)&&r.rms>0).map(r=>r.rms).sort((a,b)=>a-b),middle=values.length>>1;
 const ref=values.length?(values.length%2?values[middle]:(values[middle-1]+values[middle])/2):0;
 return Object.fromEntries(rows.map(r=>[r.id,{...r,relativeDb:ref>0&&r.rms>0?20*Math.log10(r.rms/ref):null,referenceRms:ref||null}]));
}
function run(revision=null){
 const cat=read(path.join(ROOT,'INPUT-CATALOGUE.json'));verifyCatalogue(cat);
 const decision=read(path.join(ROOT,'BENCHMARK-DECISION.json')),out=path.join(ROOT,'outputs');fs.mkdirSync(out,{recursive:true});
 if(revision!==null&&!/^[a-z0-9-]+$/.test(revision))throw Error('invalid-derivative-revision');
 const destination=revision?path.join(out,revision):out;if(revision)fs.mkdirSync(destination);
 const derived=[],materialResults=[],missingByCode={},ring=[];
 for(const take of cat.takes.filter(t=>t.detectorCallsAllowed===1)){
  const file=path.join(out,'new-takes',take.code+'.result.json'),result=read(file);
  if(result.execution.detectorCalls!==1||result.selection!==decision.schemeId||result.take.pcm.sha256!==take.pcm.sha256)throw Error('result-binding:'+take.code);
  const pcm=decode(take.pcm.path),levels=relativeLevels(pcm,result.selectedCandidates,take.timing.playStartFrame);
  const d=derive(result,take,decision,readMemo(take.memo.path),levels);derived.push(d);materialResults.push(identity(file));
  missingByCode[take.code]=d.evenness.missingPositions.map(p=>({slotIndex:p.positionIndex+1,timeSeconds:p.plannedMarkerTimeSeconds,observedOnset:null,origin:'fitted-grid-gap'}));
  const measured=measureAll(pcm,result.selectedCandidates);
  ring.push({code:take.code,takeId:take.takeId,observationOnly:take.code==='N9',entries:measured.map(m=>{
   const a=d.evenness.rows.find(r=>r.id===m.previousCandidateId),b=d.evenness.rows.find(r=>r.id===m.candidateId);
   const pa=a?positions(take).find(p=>p.index===a.positionIndex):null,pb=b?positions(take).find(p=>p.index===b.positionIndex):null;
   return{...m,possibleTaskStringTransition:!!(pa?.plannedString&&pb?.plannedString&&pa.plannedString!==pb.plannedString),
    stringTransitionConfirmed:false,alignmentProvisional:true};})});
 }
 const old=read(path.join(ROOT,'analysis/reproduction/LEGACY-REPRODUCTION.json'));
 const oldExtraDir=path.join(destination,'old-saved-results');fs.mkdirSync(oldExtraDir);
 const blindExtraResults=[];
 for(const take of cat.takes.filter(t=>t.group==='old-nine')){
  const records=old.records.filter(r=>r.code===take.code),candidates=records.map(r=>({id:r.candidateIndex,rhoTime:r.candidate.rhoTime,
   midi:r.candidate.midi,medianMidi:r.candidate.medianMidi,noteName:noteName(r.candidate.midi),r2:r.r2,knee:r.corrected,
   states:r.correctedStates,selectedState:r.correctedStates[decision.schemeId]}));
  const file=path.join(oldExtraDir,take.code+'.json');save(file,{schema:'design-v2-old-saved-results-v1',code:take.code,take,selectedCandidates:candidates,execution:{detectorCalls:0,r2Calls:0,kneeCalls:0},provenance:'saved reproduction, no rerun'});blindExtraResults.push(identity(file));
 }
 const pool=ring.flatMap(t=>t.entries.filter(e=>e.possibleTaskStringTransition&&e.status==='observed').map(e=>({code:t.code,takeId:t.takeId,...e})));
 pool.sort((a,b)=>b.ratioDb-a.ratioDb);
 const chosen=pool.slice(0,2),rest=pool.slice(2);
 // Deterministic seeded selection of the third from the remainder, not the next largest.
 if(rest.length)chosen.push(rest[(0x11a2b3c4>>>0)%rest.length]);
 const listening=chosen.map((e,i)=>{const duration=cat.takes.find(t=>t.takeId===e.takeId).pcm.bytes/4/44100,start=Math.max(0,Math.min(e.newTime-.5,duration-1.5));return{id:'ring-'+(i+1),code:e.code,takeId:e.takeId,candidateId:e.candidateId,
   startSeconds:start,endSeconds:start+1.5,
   selection:i<2?'largest-ratio':'seeded-other',ratioDb:e.ratioDb,question:'다른 줄이 울리고 있나요?',allowedAnswers:['yes','no','unknown'],answer:null,
   note:'과제와 임시 자리 대응에 따른 줄 전환 후보. 실제 줄 전환 확정 아님.'};});
 save(path.join(destination,'EVENNESS-RESULTS.json'),{schema:'design-v2-evenness-results-v1',takes:derived});
 save(path.join(destination,'UI-RESULTS.json'),{schema:'design-v2-ui-results-v1',results:derived.map(d=>d.ui),captureEnabled:false,listeningTasks:[]});
 save(path.join(destination,'REMAINING-COMPONENTS.json'),{schema:'design-v2-remaining-components-v1',takes:ring,listening,requestedClips:3,providedClips:listening.length,smallSampleNoQualityThreshold:true});
 save(path.join(destination,'MATERIAL-INPUT.json'),{schema:'design-v2-material-input-v1',results:materialResults,missingByCode,blindExtraResults});
 verifyCatalogue(cat);return{takes:derived.length,ringListening:chosen.length,newDetectorCalls:0,destination};
}
if(require.main===module){if(process.argv[2]!=='--derive-saved-only')throw Error('Use --derive-saved-only after ten one-time results');const revision=process.argv[3]==='--revision'?process.argv[4]:null;console.log(JSON.stringify(run(revision)));}
module.exports={positions,derive,relativeLevels,run};
