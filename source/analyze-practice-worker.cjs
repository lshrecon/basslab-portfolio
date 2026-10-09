'use strict';
// Launched only by the bridge after a user-requested take is saved and device released.
const fs=require('node:fs'),path=require('node:path');
const {ROOT,identity,read}=require('./input-catalogue.cjs');
const {loadFrozen,analyzeSignal}=require('../analysis/signal-pipeline.cjs');
const {derive,relativeLevels}=require('./derive-results.cjs');
const {TASKS}=require('../bridge/tasks.cjs');
const {participantLabel,noteCount}=require('../bridge/practice-controller.cjs');
function inside(file,base){const r=path.relative(base,path.resolve(file));return !!r&&!r.startsWith('..')&&!path.isAbsolute(r);}
function analyze(context){
 const id=context.takeId;if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(id))throw Error('invalid-take-id');
 const takeRoot=path.join(ROOT,'takes',id);
 if(!inside(context.pcmIdentity.path,takeRoot)||!inside(context.runIdentity.path,takeRoot))throw Error('new-practice-take-root-required');
 const pcmIdentity=identity(context.pcmIdentity.path,context.pcmIdentity),runIdentity=identity(context.runIdentity.path,context.runIdentity);
 const run=read(runIdentity.path);
 if(run.takeId!==id||run.deviceReleased!==true||context.deviceReleased===false)throw Error('saved-released-take-required');
 if(!run.valid && !(run.invalidReasons?.length===1&&run.invalidReasons[0]==='user-stop'))throw Error('capture-error-not-eligible-for-analysis');
 if(run.pcm?.sampleRate!==44100||run.pcm?.channels!==1||run.pcm?.encoding!=='f32le'||pcmIdentity.bytes%4||run.pcm?.sha256!==pcmIdentity.sha256)throw Error('unsupported-or-unbound-pcm');
 if(context.bpm<40||context.bpm>80||![40,50,60,70,80].includes(context.bpm))throw Error('tempo-outside-approved-range');
 const taskDefinition=TASKS.find(task=>task.taskId===context.taskId),count=noteCount(context.plannedNoteCount??taskDefinition?.slots?.length),participant=participantLabel(context.participant??run.participant);
 if(!taskDefinition||taskDefinition.slots.length!==count||run.plannedNoteCount!==count||participantLabel(run.participant)!==participant)throw Error('task-plan-participant-mismatch');
 if(!Array.isArray(context.plannedPositions)||context.plannedPositions.length!==count)throw Error('task-planned-positions-required');
 if(context.plannedPositions.some((p,i)=>p.index!==i||p.expectedMidi!==taskDefinition.slots[i].midi))throw Error('task-pitch-plan-mismatch');
 if(!Number.isFinite(context.playStartSeconds)||context.plannedPositions.some(p=>!Number.isFinite(p.timeSeconds)))throw Error('finite-planned-timing-required');
 const decision=read(path.join(ROOT,'BENCHMARK-DECISION.json')),freeze=read(path.join(ROOT,'ANALYSIS-FREEZE.json'));
 if(freeze.decisionSha256!==identity(path.join(ROOT,'BENCHMARK-DECISION.json')).sha256)throw Error('unfrozen-analysis-decision');
 const frozenPath=f=>{const p=path.resolve(ROOT,f.file??f.path);if(!inside(p,ROOT))throw Error('frozen-path-outside-package');return p;};
 for(const f of freeze.files)identity(frozenPath(f),f);
 if(!['a-5ms','b-shift-3ms','c-shift-period'].includes(decision.schemeId))throw Error('explicit-agreement-scheme-required');
 const out=path.join(ROOT,'outputs/practice-takes',id);fs.mkdirSync(out,{recursive:true});
 const execution={startedAt:new Date().toISOString(),detectorCalls:0,evidenceCalls:0,pulseCalls:0,kneeCalls:0,retries:0,deviceCalls:0};
 fs.writeFileSync(path.join(out,'ATTEMPT.json'),JSON.stringify({context,execution},null,2)+'\n',{flag:'wx'});
 try{
  const duration=pcmIdentity.bytes/4/44100;
  if(duration<=context.playStartSeconds){
   const ui={takeId:id,taskId:context.taskId,participant,plannedNoteCount:count,label:(context.metadata?.task?.label??context.taskId)+' · 준비 중 중단',durationSeconds:duration,
    expectedCount:0,candidateCount:0,notes:[],missedPositions:[],outsideCount:0,performanceNote:'연주 구간 전에 중단되어 분석할 연주가 없습니다. 녹음은 보존했습니다.',
    originalPcm:pcmIdentity,audioUrl:'/api/audio/'+encodeURIComponent(id),monitorRoute:context.monitorRoute??'unknown',clickMode:context.clickMode,
    tempo:{metronomeBpm:context.bpm,actualBpm:null,driftNotes:null},evenness:{provisional:true,bandAllowed:false,bandMs:null,measuredCount:0,populationCount:0,validAdjacentPairs:0},excluded:false};
   execution.finishedAt=new Date().toISOString();const resultPath=path.join(out,'SKIPPED.json'),derivedPath=path.join(out,'DERIVED.json');
   fs.writeFileSync(resultPath,JSON.stringify({takeId:id,reason:'no-performance-frames',execution,runIdentity,pcmIdentity},null,2)+'\n',{flag:'wx'});
   fs.writeFileSync(derivedPath,JSON.stringify({ui},null,2)+'\n',{flag:'wx'});
   fs.writeFileSync(path.join(out,'COMPLETED.json'),JSON.stringify({skipped:true,execution,result:identity(resultPath),derived:identity(derivedPath)},null,2)+'\n',{flag:'wx'});
   return{takeId:id,resultPath,derivedPath,ui,execution};
  }
  const b=fs.readFileSync(pcmIdentity.path),pcm=new Float32Array(b.length/4);for(let i=0;i<pcm.length;i++)pcm[i]=b.readFloatLE(i*4);
  const measured=analyzeSignal(pcm,loadFrozen(),execution);
  const task=context.metadata?.task??context.task??{label:context.taskId};
  const take={code:context.taskId,takeId:id,participant,plannedNoteCount:count,bpm:context.bpm,pcm:pcmIdentity,run:runIdentity,task,
   monitoringRoute:['direct','software'].includes(context.monitorRoute)?context.monitorRoute:'unknown',clickMode:context.clickMode,
   sessionOrder:context.sessionOrder,recordedDate:(context.finishedAt??'').slice(0,10)||null,
   timing:{playStartFrame:Math.round(context.playStartSeconds*44100),plannedSlots:context.plannedPositions.map((p,i)=>({index:i+1,plannedPcmLocalFrame:Math.round(p.timeSeconds*44100),midi:p.expectedMidi,string:task.slots?.[i]?.string,fret:task.slots?.[i]?.fret}))}};
  const result={schema:'design-v2-practice-analysis-v1',participant,plannedNoteCount:count,take,code:take.code,...measured,selection:decision.schemeId,
   selectedCandidates:measured.candidates.map(c=>({...c,selectedState:c.states[decision.schemeId]}))};
  const levels=relativeLevels(pcm,result.selectedCandidates,take.timing.playStartFrame),derived=derive(result,take,decision,'',levels);
  Object.assign(derived,{participant,plannedNoteCount:count});Object.assign(derived.ui,{participant,plannedNoteCount:count});
  identity(pcmIdentity.path,pcmIdentity);identity(runIdentity.path,runIdentity);
  for(const f of freeze.files)identity(frozenPath(f),f);
  execution.finishedAt=new Date().toISOString();result.execution=execution;
  for(const [name,data]of[['RESULT.json',result],['DERIVED.json',derived]])fs.writeFileSync(path.join(out,name),JSON.stringify(data,null,2)+'\n',{flag:'wx'});
  fs.writeFileSync(path.join(out,'COMPLETED.json'),JSON.stringify({execution,inputsPreserved:true,result:identity(path.join(out,'RESULT.json')),derived:identity(path.join(out,'DERIVED.json'))},null,2)+'\n',{flag:'wx'});
  // The bridge indexes this new immutable result. It never overwrites the old-take index.
  return{takeId:id,resultPath:path.join(out,'RESULT.json'),derivedPath:path.join(out,'DERIVED.json'),ui:derived.ui,execution};
 }catch(error){execution.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(out,'FAILURE.json'),JSON.stringify({message:error.message,execution,retryAllowed:false},null,2)+'\n',{flag:'wx'});throw error;}
}
if(require.main===module){if(process.argv.length!==4||process.argv[2]!=='--saved-context')throw Error('Explicit saved-context file required');const p=path.resolve(process.argv[3]);if(!inside(p,path.join(ROOT,'bridge')))throw Error('bridge-context-path-required');console.log(JSON.stringify(analyze(read(p))));}
module.exports={analyze,inside};
