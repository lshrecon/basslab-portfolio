'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
const {StringDecoder}=require('node:string_decoder');
const {TASKS}=require('./tasks.cjs');
const PROFILE='practice-portable-v13-20260930',BPMS=[40,50,60,70,80],RATE=44100,PRE=55125;
const VERSIONS={program:'basslab-practice-v13-portable-engine-v1',schedule:'practice-v13-8-quarter-countin-32-notes-finish-tail2-v1',taskSchedule:'practice-v24-8-quarter-countin-task-notes-finish-tail2-v1'};
const need=(yes,message)=>{if(!yes)throw new Error(message);};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function plain(p,dir=false){const s=fs.lstatSync(p);need(!s.isSymbolicLink()&&(dir?s.isDirectory():s.isFile()),'non-plain-path');return s;}
function readJson(p){need(plain(p).size<4*1024*1024,'metadata-too-large');return JSON.parse(fs.readFileSync(p,'utf8'));}
function optional(p){try{return readJson(p);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function exclusive(p,v){const fd=fs.openSync(p,'wx');try{fs.writeFileSync(fd,JSON.stringify(v,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function beat(n,d,bpm){return Math.floor((n*60*RATE+d*bpm/2)/(d*bpm));}
function participantLabel(value='나'){need(typeof value==='string'&&value===value.normalize('NFC').trim()&&value.length>0&&Buffer.byteLength(value,'utf8')<=120&&!/[\u0000-\u001f\u007f]/.test(value),'invalid-participant');return value;}
function noteCount(value){need(Number.isSafeInteger(value)&&value>=1&&value<=256,'invalid-planned-note-count');return value;}
function scheduleVersion(count){return noteCount(count)===32?VERSIONS.schedule:VERSIONS.taskSchedule;}
function timing(bpm,clickMode,plannedNoteCount){need(BPMS.includes(bpm)&&['quarter','sixteenth'].includes(clickMode),'unsupported-tempo-or-click');const count=noteCount(plannedNoteCount),frames=Array.from({length:count},(_,i)=>PRE+beat(32+i,4,bpm)),end=PRE+beat(32+count,4,bpm);return {sampleRate:RATE,preRollFrames:PRE,playStartFrame:frames[0],playEndFrame:end,captureEndFrame:end+88200,plannedNoteFrames:frames,clickFrames:[...Array.from({length:8},(_,i)=>PRE+beat(i,1,bpm)),...frames.filter((_,i)=>clickMode==='sixteenth'||i%4===0),end]};}
// Native closes run.json before TAKE_SAVED. Enrich only that active teacher save,
// after validating the native metadata and PCM, and before publishing its identity.
function finalizeTeacherTaskLabel(runPath,run,originalBytes,attempt){
 need(run.deviceReleased===true,'teacher-save-device-release-unconfirmed');
 const task=TASKS.find(t=>t.taskId===attempt.taskId);
 need(task?.group==='teacher'&&task.label===attempt.task.label,'teacher-task-label-binding-mismatch');
 if(Object.hasOwn(run,'taskLabel')){need(run.taskLabel===task.label,'saved-task-label-mismatch');return;}
 need(fs.readFileSync(runPath).equals(originalBytes),'saved-metadata-changed-before-finalize');
 const next={...run,taskLabel:task.label},temporary=runPath+'.task-label-'+crypto.randomUUID()+'.tmp';
 exclusive(temporary,next);
 need(fs.readFileSync(runPath).equals(originalBytes),'saved-metadata-changed-during-finalize');
 fs.renameSync(temporary,runPath);
 run.taskLabel=task.label;
}
function inspectTake(root,attempt,{finalizeTeacherLabel=false}={}){
 const dir=path.join(root,'takes',attempt.takeId);plain(dir,true);const runPath=path.join(dir,'run.json'),pcmPath=path.join(dir,'pcm.f32le'),runBytes=(need(plain(runPath).size<4*1024*1024,'metadata-too-large'),fs.readFileSync(runPath)),run=JSON.parse(runBytes.toString('utf8')),p=run.pcm,count=noteCount(attempt.plannedNoteCount??attempt.task?.slots?.length),participant=participantLabel(attempt.participant);
 need(run.schema==='basslab-practice-v2-run-v1'&&run.engineVersion===VERSIONS.program&&run.scheduleVersion===scheduleVersion(count),'saved-version-mismatch');
 need(participantLabel(run.participant)===participant,'saved-participant-mismatch');
 need(run.takeId===attempt.takeId&&run.bpm===attempt.bpm&&run.subdivision===4&&run.taskId===attempt.taskId&&run.monitorRoute===attempt.monitorRoute&&run.clickMode===attempt.clickMode,'saved-settings-mismatch');
 if(attempt.deviceBinding){need(isDeepStrictEqual(run.deviceSelection,attempt.deviceBinding.deviceSelection)&&isDeepStrictEqual(run.clickCalibration,attempt.deviceBinding.clickCalibration),'saved-device-calibration-binding-mismatch');}
 need(p&&p.encoding==='f32le'&&p.sampleRate===RATE&&p.channels===1,'saved-format-mismatch');
 need(Number.isSafeInteger(p.frameCount)&&p.frameCount>=0&&p.frameCount<=attempt.timing.captureEndFrame,'saved-length-invalid');
 need(p.byteLength===p.frameCount*4&&plain(pcmPath).size===p.byteLength,'saved-bytes-mismatch');need(sha(fs.readFileSync(pcmPath))===p.sha256,'saved-sha-mismatch');
 const expected=attempt.timing.clickFrames;
 need(run.plannedNoteCount===count&&run.plannedClickCount===expected.length&&run.countInClickCount===8&&run.practiceClickCount===expected.length-9&&run.finishClickCount===1&&run.schedule.length===expected.length,'saved-schedule-count-mismatch');
 for(let i=0;i<expected.length;i++)need(run.schedule[i].index===i&&run.schedule[i].pcmLocalFrame===expected[i]&&run.schedule[i].countIn===(i<8),'saved-schedule-frame-mismatch');
 if(p.frameCount){need(Number.isSafeInteger(p.firstFrame)&&p.firstFrame>=0&&p.lastFrameExclusive===p.firstFrame+p.frameCount,'saved-origin-invalid');
  const boundaries={preparingStart:0,countInStart:PRE,practiceStart:attempt.timing.playStartFrame,practiceEnd:attempt.timing.playEndFrame,captureEnd:attempt.timing.captureEndFrame};
  for(const [key,frame]of Object.entries(boundaries))need(run.boundaries?.pcmLocalFrames?.[key]===frame&&run.boundaries?.captureStreamFrames?.[key]===p.firstFrame+frame,'saved-boundary-invalid');
  for(let i=0;i<expected.length;i++)need(run.schedule[i].requestedCaptureFrame===p.firstFrame+expected[i],'saved-requested-frame-invalid');
 }
 if(finalizeTeacherLabel&&attempt.task?.group==='teacher')finalizeTeacherTaskLabel(runPath,run,runBytes,attempt);
 const plannedComplete=run.complete===true&&run.valid===true&&!run.interrupted&&Array.isArray(run.invalidReasons)&&!run.invalidReasons.length&&run.deviceReleased===true&&p.frameCount===attempt.timing.captureEndFrame&&run.actualSubmittedClickCount===expected.length&&run.schedule.every(c=>c.submitted===true&&c.submittedWaveformBytes===13230);
 return {profile:PROFILE,takeId:attempt.takeId,taskId:attempt.taskId,participant,plannedNoteCount:count,bpm:attempt.bpm,monitorRoute:attempt.monitorRoute,clickMode:attempt.clickMode,deviceBinding:attempt.deviceBinding,sessionId:attempt.sessionId,sessionOrder:attempt.sessionOrder,
  status:plannedComplete?'saved':'interrupted',plannedComplete,complete:run.complete,valid:run.valid,invalidReasons:run.invalidReasons,deviceReleased:run.deviceReleased===true,
  frameCount:p.frameCount,durationSeconds:p.frameCount/RATE,runIdentity:{path:runPath,bytes:plain(runPath).size,sha256:sha(fs.readFileSync(runPath))},pcmIdentity:{path:pcmPath,bytes:p.byteLength,sha256:p.sha256},
  plannedPositions:attempt.task.slots.map((s,i)=>({index:i,timeSeconds:attempt.timing.plannedNoteFrames[i]/RATE,expectedMidi:s.midi})),
  playStartSeconds:attempt.timing.playStartFrame/RATE,playEndSeconds:p.frameCount/RATE,
  expectedScope:{basis:'planned-positions-not-proof-of-played-notes',recorded:attempt.timing.plannedNoteFrames.flatMap((f,i)=>f<p.frameCount?[i]:[]),unrecorded:attempt.timing.plannedNoteFrames.flatMap((f,i)=>f>=p.frameCount?[i]:[])},
  firstNote:attempt.firstNote,metadata:{task:attempt.task,participant,plannedNoteCount:count,bpm:attempt.bpm,timing:attempt.timing,monitorRoute:attempt.monitorRoute,clickMode:attempt.clickMode,deviceBinding:attempt.deviceBinding,sessionId:attempt.sessionId,sessionOrder:attempt.sessionOrder},analysisCalls:0,calibration:run.calibrationStatus??(run.clickCalibration?.validatedForThisEngine?'snapshot-applied':'default-provisional'),finishedAt:run.finishedAt};
}
function createController({root,spawnEngine,captureEnabled=false,verify=()=>{},onChange=()=>{},onSavedAnalysis=null,onCalibrationSaved=null,getDeviceBinding=()=>({}),log=()=>{},stdout=()=>{},stderr=()=>{},clock=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,knownResultIds=()=>[]}={}){
 const ledger=path.join(root,'bridge','ledger');fs.mkdirSync(ledger,{recursive:true});fs.mkdirSync(path.join(root,'takes'),{recursive:true});plain(ledger,true);plain(path.join(root,'takes'),true);
 const sessionFiles=fs.readdirSync(ledger).filter(n=>/^session-[a-f0-9-]{36}\.json$/.test(n)).map(n=>readJson(path.join(ledger,n))).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
 let session=sessionFiles.at(-1);if(!session||optional(path.join(ledger,'ended-'+session.sessionId+'.json'))){session={sessionId:crypto.randomUUID(),profile:PROFILE,createdAt:new Date(clock()).toISOString()};exclusive(path.join(ledger,'session-'+session.sessionId+'.json'),session);}
 const sessionId=session.sessionId;
 const attemptFiles=fs.readdirSync(ledger).filter(n=>/^attempt-[a-z0-9-]+\.json$/.test(n));
 const allAttempts=attemptFiles.map(n=>readJson(path.join(ledger,n))),recoveredAttemptTakeIds=[];
 for(const attempt of allAttempts){const file=path.join(ledger,'result-'+attempt.takeId+'.json');if(optional(file))continue;
  const result={profile:PROFILE,takeId:attempt.takeId,sessionId:attempt.sessionId,taskId:attempt.taskId,participant:participantLabel(attempt.participant),plannedNoteCount:attempt.plannedNoteCount??attempt.task?.slots?.length,status:'previous-run-ended',reason:'previous-run-ended',deviceReleased:true,recoveryBasis:'new-controller-process-holds-no-device',filesPreserved:true,recoveredAt:new Date(clock()).toISOString()};
  exclusive(file,result);recoveredAttemptTakeIds.push(attempt.takeId);log({kind:'previous-run-ended',...result});
 }
 const attempts=allAttempts.filter(a=>a.sessionId===sessionId).sort((a,b)=>a.sequence-b.sequence);
 const results=new Map(attempts.map(a=>[a.takeId,optional(path.join(ledger,'result-'+a.takeId+'.json'))]).filter(([,r])=>r));
 const retryTokens=new Map(),analysisStarted=new Set();for(const n of fs.readdirSync(ledger).filter(n=>/^retry-[a-zA-Z0-9-]+\.json$/.test(n))){const r=readJson(path.join(ledger,n));if(r.sessionId===sessionId&&!attempts.some(a=>a.retryRequestId===r.requestId))retryTokens.set(r.taskId,r);}
 let child=null,childClosed=false,startAction=null,active=null,decoder=new StringDecoder('utf8'),pending='',endRequested=false,endObserved=false,firstNoteTask=null,firstNoteStopped=false,watchdog=null,killTimer=null,analysisPending=false,calibrationActive=null,shutdownRequested=false,recordCommandSubmitted=false,calibrationCommandSubmitted=false;
 const state={phase:'DORMANT',captureEnabled:!!captureEnabled,deviceReleased:true,selectedBpm:60,selectedTaskId:null,monitorRoute:'unknown',clickMode:'sixteenth',firstNote:null,firstNoteStartedAtMs:null,calibrationResult:null,
  startupNotice:recoveredAttemptTakeIds.length?'지난번에 녹음 도중 프로그램이 꺼졌습니다. 그 녹음은 결과가 없습니다. 다시 녹음할 수 있습니다.':null,recoveredAttemptTakeIds,
  activeTakeId:null,lastAttemptTakeId:attempts.at(-1)?.takeId??null,lastSavedTakeId:[...results.values()].filter(r=>r.runIdentity).at(-1)?.takeId??null,progress:null,progressReceivedAtMs:null,lastError:null,engineSpawnCount:0,sessionEnded:false};
 const taskIds=()=>[...new Set(attempts.map(a=>a.taskId))];
 function snapshot(){return {...state,sessionId,preRollSeconds:PRE/RATE,serverNowMs:clock(),distinctTaskCount:taskIds().length,completedTaskIds:taskIds(),attemptedTaskIds:taskIds(),attemptBlockedForTaskIds:[],automaticRecording:false,automaticRetry:false};}
 const emit=()=>onChange(snapshot());
 function timerClear(){if(watchdog){clearTimer(watchdog);watchdog=null;}}
 function write(command,payload={}){need(child&&!childClosed&&child.stdin.writable&&!child.stdin.destroyed,'native-input-unavailable');log({kind:'native-command',command,payload});child.stdin.write(JSON.stringify({id:crypto.randomUUID(),command,payload})+'\n');}
 function unavailable(reason){if(active&&!results.has(active.takeId)){const r={profile:PROFILE,takeId:active.takeId,sessionId,taskId:active.taskId,participant:active.participant,plannedNoteCount:active.plannedNoteCount,status:endRequested&&endObserved&&childClosed&&state.childExit?.code===0&&!state.childExit?.signal&&state.deviceReleased===true&&!state.lastError&&!recordCommandSubmitted?'cancelled-before-recording':'unavailable',recordCommandSubmitted,reason,deviceReleased:state.deviceReleased};exclusive(path.join(ledger,'result-'+active.takeId+'.json'),r);results.set(active.takeId,r);}}
 // READY or process close is the terminal boundary: an ERROR can precede a save,
 // so merely seeing an ERROR/deviceReleased event must never discard pending work.
 function finishFailedOperation(processClosed=false){
  if(state.lastError&&active&&!results.has(active.takeId))unavailable(state.lastError);
  if(calibrationActive&&!analysisPending&&(state.lastError||processClosed)){state.lastError=state.lastError||'calibration-save-not-confirmed';log({kind:'calibration-finished-error',takeId:calibrationActive.takeId,message:state.lastError,deviceReleased:state.deviceReleased});calibrationActive=null;}
 }
 function end(reason='explicit-user-end',options={}){
  if(options.graceful===true){shutdownRequested=true;if(killTimer){clearTimer(killTimer);killTimer=null;}}
  if(endRequested){emit();return;}
  timerClear();endRequested=true;startAction=null;state.phase='ENDING';log({kind:'end-request',reason});
  if(!child||childClosed){if(state.deviceReleased!==false&&state.deviceReleased!==null){state.deviceReleased=true;state.phase=analysisPending?'ANALYZING':'ENDED';state.sessionEnded=true;markEnded(reason);}else{state.phase='ERROR';state.lastError='device-release-not-confirmed';}emit();return;}
  try{write('END');}catch(e){state.lastError=e.message;}
  if(!shutdownRequested&&!killTimer){killTimer=setTimer(()=>{if(!childClosed){state.phase='ERROR';state.deviceReleased=false;state.lastError='native-end-timeout';child.kill();emit();}},10000);killTimer?.unref?.();}emit();
 }
 function markEnded(reason){const p=path.join(ledger,'ended-'+sessionId+'.json');if(!optional(p))exclusive(p,{sessionId,reason,at:new Date(clock()).toISOString()});}
 function fail(message){state.lastError=message;log({kind:'controller-error',message});end(message);state.phase='ERROR';emit();}
 function dispatch(action){verify();state.progress=null;state.progressReceivedAtMs=null;state.deviceReleased=false;
  if(action.type==='calibrate'){state.phase='CALIBRATING';write('CALIBRATE',{takeId:calibrationActive.takeId,...calibrationActive.binding});calibrationCommandSubmitted=true;watchdog=setTimer(()=>fail('calibration-completion-timeout'),45000);}
  else if(action.type==='first-note'){firstNoteTask=action.selection.task;firstNoteStopped=false;state.phase='FIRST_NOTE';write('FIRST_NOTE',{takeId:'preview-'+crypto.randomUUID(),bpm:action.selection.bpm,subdivision:4,taskId:action.selection.task.taskId,plannedNoteCount:action.selection.plannedNoteCount,participant:action.selection.participant,monitorRoute:action.selection.monitorRoute,clickMode:action.selection.clickMode,...getDeviceBinding()});watchdog=setTimer(()=>fail('first-note-completion-timeout'),45000);}
  else{state.phase='RECORDING';write('RECORD',{takeId:active.takeId,bpm:active.bpm,subdivision:4,taskId:active.taskId,plannedNoteCount:active.plannedNoteCount,participant:active.participant,monitorRoute:active.monitorRoute,clickMode:active.clickMode,...active.deviceBinding});recordCommandSubmitted=true;watchdog=setTimer(()=>fail('capture-completion-timeout'),active.timing.captureEndFrame/RATE*1000+15000);}
  watchdog?.unref?.();emit();
 }
 function maybeAnalyze(){const result=active&&results.get(active.takeId);if(!onSavedAnalysis||!result?.runIdentity||state.deviceReleased!==true||analysisStarted.has(result.takeId)||(endRequested&&!childClosed))return;
  analysisStarted.add(result.takeId);analysisPending=true;state.phase='ANALYZING';emit();
  Promise.resolve().then(()=>onSavedAnalysis(result)).then(()=>{analysisPending=false;state.phase=state.sessionEnded?'ENDED':endRequested?'ENDING':'SAVED';emit();}).catch(error=>{analysisPending=false;state.lastError='analysis-followup: '+error.message;log({kind:'analysis-followup-error',message:error.message,takeId:result.takeId});state.phase='ERROR';emit();});
 }
 function event(e){need(e&&typeof e.event==='string','invalid-native-event');log({kind:'native-event',event:e,receivedAtMs:clock()});
  switch(e.event){
   case 'READY':need(e.program===VERSIONS.program&&e.deviceReleased===true,'native-ready-mismatch');state.deviceReleased=true;timerClear();if(startAction&&!endRequested){const action=startAction;startAction=null;dispatch(action);return;}finishFailedOperation();if(!endRequested){state.progress=null;state.phase=analysisPending?(calibrationActive?'CALIBRATION_ANALYZING':'ANALYZING'):state.calibrationResult?'CALIBRATION_SAVED':state.lastError?'ERROR':active&&results.has(active.takeId)?'SAVED':'READY';maybeAnalyze();}break;
   case 'FIRST_NOTE_STARTED':need(firstNoteTask,'unrequested-first-note');state.phase='FIRST_NOTE';state.deviceReleased=false;state.firstNoteStartedAtMs=clock();break;
   case 'FIRST_NOTE':need(firstNoteTask&&e.taskId===firstNoteTask.taskId&&e.savedPcm===false,'first-note-binding-mismatch');state.firstNote={taskId:e.taskId,midi:typeof e.midi==='number'&&Number.isFinite(e.midi)?e.midi:null,noteName:typeof e.noteName==='string'?e.noteName:null,levelDbfs:e.levelDbfs,clarity:e.clarity,purpose:'input-display-only-not-frozen-analysis',receivedAt:new Date(clock()).toISOString()};break;
   case 'FIRST_NOTE_DONE':need(firstNoteTask&&e.taskId===firstNoteTask.taskId&&e.savedPcm===false&&e.deviceReleased===true,'first-note-release-mismatch');firstNoteStopped=true;state.deviceReleased=true;timerClear();if(!state.firstNote)state.firstNote={taskId:firstNoteTask.taskId,midi:null,noteName:null,levelDbfs:null,purpose:'input-display-only-not-frozen-analysis'};break;
   case 'RECORDING':need((active&&e.takeId===active.takeId)||(calibrationActive&&e.takeId===calibrationActive.takeId),'native-take-mismatch');state.phase=endRequested?'ENDING':calibrationActive?'CALIBRATING':'RECORDING';state.deviceReleased=false;break;
   case 'STATUS':need((active&&e.takeId===active.takeId&&e.operation==='record')||(calibrationActive&&e.takeId===calibrationActive.takeId&&e.operation==='calibration'),'native-status-mismatch');state.progress={...e,storedElapsedSeconds:e.elapsedSeconds,elapsedSeconds:e.uiClockValid===true&&Number.isFinite(e.uiElapsedSeconds)?e.uiElapsedSeconds:null};state.progressReceivedAtMs=clock();break;
   case 'CALIBRATION_SAVED':{need(calibrationActive&&!calibrationActive.savedObserved&&e.takeId===calibrationActive.takeId,'unexpected-calibration-save');calibrationActive.savedObserved=true;need(e.runPath===path.join(root,'calibrations',calibrationActive.takeId,'run.json')&&e.pcmPath===path.join(root,'calibrations',calibrationActive.takeId,'pcm.f32le'),'calibration-save-path-mismatch');timerClear();state.deviceReleased=e.deviceReleased===true;need(state.deviceReleased,'calibration-device-release-unconfirmed');state.phase='CALIBRATION_ANALYZING';const cal=calibrationActive;need(typeof onCalibrationSaved==='function','calibration-analysis-unavailable');analysisPending=true;Promise.resolve().then(()=>onCalibrationSaved({...cal,...e})).then(result=>{state.calibrationResult=result;analysisPending=false;calibrationActive=null;state.phase=state.sessionEnded?'ENDED':endRequested?'ENDING':'CALIBRATION_SAVED';emit();}).catch(error=>{analysisPending=false;calibrationActive=null;state.lastError=error.message;log({kind:'calibration-followup-error',message:error.message,takeId:cal.takeId});state.phase='ERROR';emit();});break;}
   case 'TAKE_SAVED':{need(active&&e.takeId===active.takeId&&!results.has(active.takeId),'unexpected-or-duplicate-save');need(e.runPath===path.join(root,'takes',active.takeId,'run.json')&&e.pcmPath===path.join(root,'takes',active.takeId,'pcm.f32le'),'native-save-path-mismatch');state.phase='SAVING';state.deviceReleased=e.deviceReleased===true;emit();if(active.task?.group==='teacher')need(state.deviceReleased,'teacher-save-device-release-unconfirmed');const result=inspectTake(root,active,{finalizeTeacherLabel:true});exclusive(path.join(ledger,'result-'+active.takeId+'.json'),result);results.set(active.takeId,result);state.lastSavedTakeId=active.takeId;timerClear();break;}
   case 'STOPPED':state.deviceReleased=e.deviceReleased===true;break;
   case 'ERROR':state.lastError=String(e.message||e.reason||'native-error');state.deviceReleased=e.deviceReleased===true;state.phase='ERROR';break;
   case 'SESSION_ENDED':endObserved=true;state.deviceReleased=e.deviceReleased===true;state.phase='ENDING';break;
   default:throw new Error('unexpected-native-event');
  }emit();
 }
 function start(action){if(action.type==='record')recordCommandSubmitted=false;if(action.type==='calibrate')calibrationCommandSubmitted=false;if(child&&!childClosed){dispatch(action);return;}
  state.phase='STARTING';startAction=action;childClosed=false;endObserved=false;decoder=new StringDecoder('utf8');pending='';
  try{verify();state.engineSpawnCount++;child=spawnEngine();}catch(e){startAction=null;state.lastError=e.message;state.phase='ERROR';state.deviceReleased=true;unavailable('native-spawn-failed');finishFailedOperation();log({kind:'native-spawn-failed',message:e.message});emit();throw e;}
  child.stdout.on('data',chunk=>{stdout(chunk);pending+=decoder.write(chunk);if(pending.length>1024*1024){fail('native-output-too-large');pending='';return;}let n;while((n=pending.indexOf('\n'))>=0){const line=pending.slice(0,n);pending=pending.slice(n+1);if(line.trim())try{event(JSON.parse(line));}catch(e){fail(e.message);}}});
  child.stderr.on('data',stderr);for(const stream of [child.stdin,child.stdout,child.stderr])stream.on('error',e=>fail(e.message));child.on('error',e=>fail(e.message));
  child.stdout.on('end',()=>{pending+=decoder.end();if(pending.trim())fail('truncated-native-json');});
  child.on('close',(code,signal)=>{childClosed=true;timerClear();if(killTimer){clearTimer(killTimer);killTimer=null;}state.childExit={code,signal};if(endObserved&&code===0&&!signal&&state.deviceReleased){state.phase=analysisPending?'ANALYZING':'ENDED';state.sessionEnded=true;markEnded('native-clean-end');if(calibrationActive&&!calibrationCommandSubmitted&&!state.lastError){state.calibrationResult={accepted:false,reason:'cancelled-before-calibration',recordingStarted:false};calibrationActive=null;}}else{state.phase='ERROR';state.lastError=state.lastError||'native-exit-without-clean-release';}unavailable(state.lastError||'native-ended');finishFailedOperation(true);maybeAnalyze();emit();});
  watchdog=setTimer(()=>fail('native-startup-timeout'),15000);watchdog?.unref?.();emit();
 }
 function selection(body){const task=TASKS.find(t=>t.taskId===body.taskId);need(task&&BPMS.includes(body.bpm)&&['quarter','sixteenth'].includes(body.clickMode),'invalid-task-tempo-click');const monitorRoute=body.monitorRoute??body.monitoringRoute??state.monitorRoute;need(['unknown','direct','software'].includes(monitorRoute),'invalid-monitor-route');return {task,plannedNoteCount:noteCount(task.slots?.length),participant:participantLabel(body.participant),bpm:body.bpm,clickMode:body.clickMode,monitorRoute};}
 function isIdle(){return !['STARTING','FIRST_NOTE','RECORDING','CALIBRATING','CALIBRATION_ANALYZING','STOPPING','SAVING','ANALYZING','ENDING'].includes(state.phase)&&state.deviceReleased===true;}
 function command(body){need(!shutdownRequested,'shutdown-in-progress');need(body&&typeof body==='object'&&!Array.isArray(body),'invalid-command');const allowed=['type','requestId','taskId','bpm','monitorRoute','monitoringRoute','clickMode','takeId','excluded','setupConfirmed','participant'];need(Object.keys(body).every(k=>allowed.includes(k)),'unknown-command-field');need(typeof body.requestId==='string'&&/^[a-zA-Z0-9-]{1,80}$/.test(body.requestId),'invalid-request-id');need(['first-note','first-note-stop','record','stop','end','retry','exclude','calibrate'].includes(body.type),'unknown-command');
  const requestFile=path.join(ledger,'request-'+body.requestId+'.json'),before=optional(requestFile);if(before){need(JSON.stringify(before.body)===JSON.stringify(body),'request-id-content-mismatch');return snapshot();}
  const reserve=()=>exclusive(requestFile,{sessionId,body,at:new Date(clock()).toISOString()});
  if(body.type==='end'){reserve();end();return snapshot();}
  if(body.type==='stop'||body.type==='first-note-stop'){reserve();if(state.phase==='STARTING'){
   timerClear();startAction=null;if(active&&!recordCommandSubmitted&&!results.has(active.takeId)){const result={profile:PROFILE,takeId:active.takeId,sessionId,taskId:active.taskId,participant:active.participant,plannedNoteCount:active.plannedNoteCount,status:'cancelled-before-recording',recordCommandSubmitted:false,reason:'stop-during-startup',deviceReleased:true};exclusive(path.join(ledger,'result-'+active.takeId+'.json'),result);results.set(active.takeId,result);}
   if(calibrationActive&&!calibrationCommandSubmitted){state.calibrationResult={accepted:false,reason:'cancelled-before-calibration',recordingStarted:false};calibrationActive=null;}
   state.phase='STOPPING';write('STOP');emit();return snapshot();
  }if(['FIRST_NOTE','RECORDING','CALIBRATING'].includes(state.phase)){state.phase='STOPPING';write('STOP');}emit();return snapshot();}
  if(body.type==='exclude'){need(typeof body.takeId==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(body.takeId)&&body.excluded===true,'invalid-exclusion');need(results.has(body.takeId)||knownResultIds().includes(body.takeId),'unknown-take');reserve();const file=path.join(ledger,'excluded-'+body.takeId+'.json');if(!optional(file))exclusive(file,{takeId:body.takeId,excluded:true,requestId:body.requestId,source:'explicit-user-exclusion-no-deletion'});emit();return snapshot();}
  need(state.captureEnabled&&!endRequested&&!state.sessionEnded,'capture-unavailable');need(isIdle(),'action-busy-or-device-release-unconfirmed');
  if(body.type==='retry'){const prior=attempts.find(a=>a.takeId===body.takeId);need(prior&&prior.sessionId===sessionId,'retry-take-unknown');need(!retryTokens.has(prior.taskId),'retry-already-prepared');reserve();const token={sessionId,taskId:prior.taskId,takeId:prior.takeId,requestId:body.requestId,at:new Date(clock()).toISOString()};exclusive(path.join(ledger,'retry-'+body.requestId+'.json'),token);retryTokens.set(prior.taskId,token);state.firstNote=null;firstNoteStopped=false;state.lastError=null;state.phase='DORMANT';active=null;emit();return snapshot();}
  if(body.type==='calibrate'){need(body.setupConfirmed===true,'calibration-setup-confirmation-required');verify();const binding=getDeviceBinding();reserve();active=null;calibrationActive={takeId:'calibration-'+crypto.randomUUID(),binding,createdAt:new Date(clock()).toISOString()};state.firstNote=null;firstNoteStopped=false;state.calibrationResult=null;state.lastError=null;state.progress=null;start({type:'calibrate'});return snapshot();}
  const selected=selection(body),taskId=selected.task.taskId;verify();getDeviceBinding();state.calibrationResult=null;
  if(body.type==='first-note'){reserve();Object.assign(state,{selectedBpm:selected.bpm,selectedTaskId:taskId,plannedNoteCount:selected.plannedNoteCount,participant:selected.participant,monitorRoute:selected.monitorRoute,clickMode:selected.clickMode,firstNote:null,firstNoteStartedAtMs:null,lastError:null});active=null;start({type:'first-note',selection:selected});return snapshot();}
  need(firstNoteStopped&&state.firstNote?.taskId===taskId,'first-note-check-required');reserve();
  const retryToken=retryTokens.get(taskId),attempt={profile:PROFILE,sessionId,sequence:attempts.length+1,sessionOrder:attempts.length+1,
   task:selected.task,taskId,plannedNoteCount:selected.plannedNoteCount,participant:selected.participant,bpm:selected.bpm,clickMode:selected.clickMode,monitorRoute:selected.monitorRoute,requestId:body.requestId,retryRequestId:retryToken?.requestId??null,
   takeId:'practice-v2-'+crypto.randomUUID(),timing:timing(selected.bpm,selected.clickMode,selected.plannedNoteCount),firstNote:{...state.firstNote},createdAt:new Date(clock()).toISOString(),source:'explicit-user-record-button',deviceBinding:getDeviceBinding()};
  exclusive(path.join(ledger,'attempt-'+attempt.takeId+'.json'),attempt);attempts.push(attempt);retryTokens.delete(taskId);active=attempt;state.lastAttemptTakeId=attempt.takeId;state.activeTakeId=attempt.takeId;state.lastError=null;state.selectedBpm=selected.bpm;state.selectedTaskId=taskId;state.plannedNoteCount=selected.plannedNoteCount;state.participant=selected.participant;state.monitorRoute=selected.monitorRoute;state.clickMode=selected.clickMode;
  start({type:'record'});return snapshot();
 }
 function takes(){return attempts.map(a=>{const saved=results.get(a.takeId);return {...a,...saved,participant:participantLabel(saved?.participant??a.participant),plannedNoteCount:saved?.plannedNoteCount??a.plannedNoteCount??a.task?.slots?.length,...(saved?.runIdentity?{runIdentity:{...saved.runIdentity,path:path.join(root,'takes',a.takeId,'run.json')},pcmIdentity:{...saved.pcmIdentity,path:path.join(root,'takes',a.takeId,'pcm.f32le')}}:{}),excluded:!!optional(path.join(ledger,'excluded-'+a.takeId+'.json'))};});}
 function lifecycle(){
  const result=active&&results.get(active.takeId),nativeProcessClosed=!child||childClosed,nativeCleanExit=!child||(childClosed&&endObserved&&state.childExit?.code===0&&!state.childExit?.signal);
  const analysisAwaitingStart=!!(onSavedAnalysis&&result?.runIdentity&&!analysisStarted.has(result.takeId));
  const cancelledBeforeRecording=result?.status==='cancelled-before-recording',terminalRecording=!!result&&['cancelled-before-recording','unavailable','previous-run-ended'].includes(result.status);
  const savePending=!!(active&&!result?.runIdentity&&!terminalRecording),calibrationPending=!!calibrationActive;
  const operationFinished=state.deviceReleased===true&&!analysisPending&&!analysisAwaitingStart&&!savePending&&!calibrationPending;
  const priorOperationError=operationFinished?state.lastError:null;
  const failure=(priorOperationError?null:state.lastError)||((nativeProcessClosed&&savePending)?'recording-save-not-confirmed':null)||((nativeProcessClosed&&calibrationPending&&!analysisPending)?'calibration-save-not-confirmed':null);
  return {deviceReleased:state.deviceReleased===true,nativeProcessClosed,nativeStarted:!!child,nativeCleanExit,analysisPending,analysisAwaitingStart,savePending,calibrationPending,shutdownRequested,endRequested,sessionEnded:state.sessionEnded,failure,priorOperationError,cancelledBeforeRecording,recordCommandSubmitted,activeTakeId:active?.takeId??null,savedTakeId:result?.runIdentity?result.takeId:null,savedFilesVerified:!!result?.runIdentity,calibrationMeasurementId:state.calibrationResult?.measurementId??null};
 }
 function resetSelection(){need(!shutdownRequested,'shutdown-in-progress');need(isIdle(),'device-change-while-busy');state.firstNote=null;state.firstNoteStartedAtMs=null;firstNoteStopped=false;state.calibrationResult=null;state.lastError=null;active=null;state.phase='DORMANT';emit();}
 return {snapshot,lifecycle,command,end,resetSelection,onEvent:event,takes,ledger,sessionId,tasks:()=>TASKS,excluded:takeId=>!!optional(path.join(ledger,'excluded-'+takeId+'.json'))};
}
module.exports={PROFILE,BPMS,VERSIONS,RATE,PRE,sha,plain,readJson,exclusive,timing,noteCount,scheduleVersion,participantLabel,inspectTake,createController};
