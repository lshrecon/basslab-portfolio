'use strict';
// User sessions are metadata journals. They never control audio or modify a take.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {plain,chain,zip}=require('./portable-state.cjs');
const {participantLabel,ownParticipant}=require('./participant-store.cjs');
const need=(v,m)=>{if(!v)throw Error(m);};
const id=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(v)&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(v);
const requestId=v=>typeof v==='string'&&/^[a-zA-Z0-9-]{1,80}$/.test(v);
const obj=v=>v&&typeof v==='object'&&!Array.isArray(v);
const text=(v,max=2000)=>typeof v==='string'&&v.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v);
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const canonical=v=>JSON.stringify(v,(_,x)=>obj(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const keys=(v,allowed)=>need(obj(v)&&Object.keys(v).every(k=>allowed.includes(k)),'invalid-session-fields');
function validateScript(value,taskIds){
 keys(value,['id','title','version','steps']);need(id(value.id)&&text(value.title,150)&&value.title.trim()&&value.version===1&&Array.isArray(value.steps)&&value.steps.length>0&&value.steps.length<=128,'invalid-session-script');
 const seen=new Set();
 for(const s of value.steps){
  need(obj(s)&&id(s.id)&&!seen.has(s.id)&&(s.optional===undefined||typeof s.optional==='boolean'),'invalid-session-step-id');seen.add(s.id);
  if(s.type==='record'){
   keys(s,['id','type','taskId','bpm','clickMode','instruction','expected','beforeQuestions','optional']);
   need(id(s.taskId)&&(!taskIds||taskIds.includes(s.taskId))&&[40,50,60,70,80].includes(s.bpm)&&['quarter','sixteenth'].includes(s.clickMode)&&text(s.instruction)&&text(s.expected)&&Array.isArray(s.beforeQuestions)&&s.beforeQuestions.length<=12&&(s.optional===undefined||typeof s.optional==='boolean'),'invalid-session-record-step');
   const questions=new Set();for(const q of s.beforeQuestions){keys(q,['id','type','question','options','exclusiveOption']);need(id(q.id)&&!questions.has(q.id)&&text(q.question,500)&&({overall:'single',shaken:'multiple',memo:'text'})[q.id]===q.type,'invalid-before-question');questions.add(q.id);if(q.type!=='text')need(Array.isArray(q.options)&&q.options.length>=2&&q.options.length<=16&&q.options.every(x=>text(x,80))&&new Set(q.options).size===q.options.length&&(q.exclusiveOption===undefined||q.options.includes(q.exclusiveOption)),'invalid-before-options');}need(!questions.size||(questions.has('overall')&&questions.has('shaken')),'unsupported-before-question-structure');
  }else if(s.type==='listen'){
   keys(s,['id','type','takeId','slots','question','options','optional']);need(id(s.takeId)&&Array.isArray(s.slots)&&s.slots.length>0&&s.slots.length<=256&&s.slots.every(n=>Number.isInteger(n)&&n>=1&&n<=256)&&new Set(s.slots).size===s.slots.length&&text(s.question,1000)&&Array.isArray(s.options)&&s.options.length>=2&&s.options.length<=16&&s.options.every(x=>text(x,80))&&new Set(s.options).size===s.options.length,'invalid-session-listen-step');
  }else if(s.type==='questions'){
   keys(s,['id','type','questions','optional']);need(Array.isArray(s.questions)&&s.questions.length>0&&s.questions.length<=20&&s.questions.every(q=>text(q,1000)),'invalid-session-questions-step');
  }else throw Error('invalid-session-step-type');
 }
 need(Buffer.byteLength(JSON.stringify(value))<=65536,'session-script-too-large');return JSON.parse(JSON.stringify(value));
}
function createSessionStore(root,{taskIds,clock=Date.now,version='26',maxExportBytes=256*1024*1024}={}){
 root=path.resolve(root);plain(root,true);const base=path.join(root,'sessions'),scripts=path.join(base,'scripts');
 function ensureDir(dir){const relative=path.relative(root,dir);need(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),'session-path-outside-root');let current=root;for(const part of relative.split(path.sep)){current=path.join(current,part);try{plain(current,true);}catch(e){if(e.code!=='ENOENT')throw e;fs.mkdirSync(current);plain(current,true);}}}
 ensureDir(base);ensureDir(scripts);
 function checked(file){chain(file,root);return plain(file);}
 function read(file,limit=4*1024*1024){need(checked(file).size<=limit,'session-metadata-too-large');return fs.readFileSync(file,'utf8');}
 function exclusive(file,contents){chain(file,root);const fd=fs.openSync(file,'wx');try{fs.writeFileSync(fd,contents);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
 const defaults=path.join(root,'bridge','session-defaults');
 if(fs.existsSync(defaults)){chain(defaults,root);plain(defaults,true);for(const name of ['teacher-2026-10-07','chromatic-3-12']){const dest=path.join(scripts,name+'.json');try{checked(dest);continue;}catch(e){if(e.code!=='ENOENT')throw e;}const source=path.join(defaults,name+'.json');if(!fs.existsSync(source))continue;const raw=read(source,65536),value=validateScript(JSON.parse(raw),taskIds);need(value.id===name,'script-id-filename-mismatch');exclusive(dest,raw);}}
 // A malformed user-edited script is reported without blocking other scripts or capture.
 function listScripts(){chain(scripts,root);plain(scripts,true);const values=[],errors=[];for(const name of fs.readdirSync(scripts).sort()){if(!name.endsWith('.json'))continue;const scriptId=name.slice(0,-5);if(!id(scriptId)){errors.push({id:scriptId,error:'invalid-script-id'});continue;}try{const value=validateScript(JSON.parse(read(path.join(scripts,name),65536)),taskIds);need(value.id===scriptId,'script-id-filename-mismatch');values.push(value);}catch(e){errors.push({id:scriptId,error:e.message});}}return {scripts:values,errors};}
 function journal(sessionId){need(id(sessionId),'invalid-guided-session-id');const dir=path.join(base,sessionId);chain(dir,root);plain(dir,true);return path.join(dir,'session.jsonl');}
 function events(sessionId){const raw=read(journal(sessionId)),lines=raw.split('\n'),values=[];for(let i=0;i<lines.length;i++){if(!lines[i].trim())continue;try{values.push(JSON.parse(lines[i]));}catch(e){let recovery=null;try{recovery=JSON.parse(lines[i+1]);}catch{}const tornFinal=i===lines.length-1;if(!tornFinal&&!(recovery?.type==='journal-recovery'&&recovery.damagedLineSha256===hash(lines[i])))throw Error('session-journal-corrupt');values.push({type:'journal-warning',line:i+1,reason:'partial-append-preserved',damagedLineSha256:hash(lines[i])});}}return values;}
 function append(sessionId,event){const file=journal(sessionId),raw=read(file);let prefix='';if(raw&&!raw.endsWith('\n')){prefix='\n';const tail=raw.slice(raw.lastIndexOf('\n')+1);try{JSON.parse(tail);}catch{prefix+=JSON.stringify({type:'journal-recovery',at:new Date(clock()).toISOString(),reason:'partial-append-preserved',damagedLineSha256:hash(tail)})+'\n';}}const line=JSON.stringify({at:new Date(clock()).toISOString(),...event})+'\n';need(Buffer.byteLength(raw)+Buffer.byteLength(line)+Buffer.byteLength(prefix)<=4*1024*1024,'session-journal-full');const fd=fs.openSync(file,'a');try{fs.writeFileSync(fd,prefix+line);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
 function get(sessionId){
  const log=events(sessionId),start=log.find(e=>e.type==='start');need(start&&start.sessionId===sessionId,'session-start-missing');const script=validateScript(start.scriptSnapshot,taskIds);
  const state={sessionId,scriptId:script.id,scriptSnapshot:script,participant:ownParticipant(start.participant??start.participantLabel),participantLabel:start.participantLabel,version:start.version,startedAt:start.at,endedAt:null,currentStepIndex:0,steps:script.steps.map((s,index)=>({index,type:s.type,taskId:s.taskId??null,bpm:s.bpm??null,clickMode:s.clickMode??null,takeIds:[],takes:[],beforeAnswers:null,viewedAt:null,skipped:false,skipReason:null,listenAnswers:[],answers:[],pendingRecord:null})),events:log};
  for(const e of log){const step=state.steps[e.stepIndex];if(e.type==='end')state.endedAt=e.at;if(!step)continue;
   if(e.type==='step'&&e.action==='activate')state.currentStepIndex=e.stepIndex;
   if(e.type==='step'&&e.action==='record-intent')step.pendingRecord={requestId:e.requestId,command:e.command,at:e.at};
   if(e.type==='step'&&e.action==='record-failed'&&step.pendingRecord?.requestId===e.commandRequestId)step.pendingRecord=null;
   if(e.type==='step'&&e.action==='bind'){if(!step.takeIds.includes(e.takeId)){step.takeIds.push(e.takeId);step.takes.push({takeId:e.takeId,beforeAnswers:null,viewedAt:null,viewedWithoutAnswers:false,requiresBefore:script.steps[e.stepIndex].beforeQuestions.length>0});}step.pendingRecord=null;}
   if(e.type==='step'&&e.action==='before'){const take=step.takes.find(t=>t.takeId===e.takeId);if(take){take.beforeAnswers=e.beforeAnswers;step.beforeAnswers=e.beforeAnswers;if(e.viewedAt){take.viewedAt=e.viewedAt;take.viewedWithoutAnswers=false;step.viewedAt=e.viewedAt;}}}
   if(e.type==='step'&&e.action==='view'){const take=step.takes.find(t=>t.takeId===e.takeId);if(take&&!take.viewedAt){take.viewedAt=e.viewedAt;take.viewedWithoutAnswers=e.viewedWithoutAnswers;step.viewedAt=e.viewedAt;}}
   if(e.type==='step'&&e.action==='skip'){step.skipped=true;step.skipReason=e.reason;}
   if(e.type==='listen')step.listenAnswers.push({slot:e.slot,answer:e.answer,at:e.at});
   if(e.type==='questions')step.answers=e.answers;
  }state.revision=log.length;state.journalWarnings=log.filter(e=>e.type==='journal-warning');return state;
 }
 function list(){chain(base,root);plain(base,true);const sessions=[],errors=[];for(const n of fs.readdirSync(base)){if(n==='scripts'||!id(n))continue;try{sessions.push(get(n));}catch(e){errors.push({sessionId:n,error:e.message});}}sessions.sort((a,b)=>b.startedAt.localeCompare(a.startedAt));const active=sessions.find(s=>!s.endedAt)??null,takeIndex={};for(const s of sessions)for(const step of s.steps)for(const take of step.takes)takeIndex[take.takeId]={...take,sessionId:s.sessionId,stepIndex:step.index};return {sessions,active,takeIndex,errors,revision:sessions.reduce((n,s)=>n+s.revision,0)};}
 function prior(state,request,payload){need(requestId(request),'invalid-request-id');const found=state.events.find(e=>e.requestId===request);if(found)need(found.fingerprint===hash(canonical(payload)),'request-id-content-mismatch');return found;}
 function recordEvent(state,payload,event){append(state.sessionId,{...event,requestId:payload.requestId,fingerprint:hash(canonical(payload))});return get(state.sessionId);}
 function listenStatus(takeId){need(id(takeId),'invalid-session-take-id');for(const name of ['run.json','pcm.f32le']){try{const stat=checked(path.join(root,'takes',takeId,name));if(name==='pcm.f32le'&&(!stat.size||stat.size%4))return {available:false,reason:'audio-unavailable'};}catch(e){if(e.code==='ENOENT')return {available:false,reason:'take-unavailable'};throw e;}}
  try{const run=JSON.parse(read(path.join(root,'takes',takeId,'run.json')));if(run?.takeId!==takeId)return {available:false,reason:'take-metadata-unavailable'};}catch(e){if(e instanceof SyntaxError)return {available:false,reason:'take-metadata-unavailable'};throw e;}
  const derived=path.join(root,'outputs','practice-takes',takeId,'DERIVED.json'),catalog=path.join(root,'outputs','UI-RESULTS.json');
  for(const file of [derived,catalog]){try{const data=JSON.parse(read(file)),results=Array.isArray(data)?data:data?.results;if(file===derived?data?.ui?.takeId===takeId:Array.isArray(results)&&results.some(r=>r?.takeId===takeId))return {available:true,reason:null};}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}}
  return {available:false,reason:'result-unavailable'};
 }
 const canListen=takeId=>listenStatus(takeId).available;
 function activateMissing(session){const index=session.currentStepIndex,step=session.scriptSnapshot.steps[index];if(step?.type==='listen'&&!session.steps[index].skipped){const status=listenStatus(step.takeId);if(!status.available){append(session.sessionId,{type:'step',action:'skip',stepIndex:index,skipped:true,reason:status.reason,takeId:step.takeId});return get(session.sessionId);}}return session;}
 function start(body){keys(body,['requestId','scriptId','participantLabel','participant']);need(requestId(body.requestId)&&id(body.scriptId),'invalid-session-start');const participant=participantLabel(body.participant??body.participantLabel??'나');need(body.participantLabel===undefined||participantLabel(body.participantLabel)===participant,'session-participant-mismatch');const all=list();for(const state of all.sessions){if(prior(state,body.requestId,body))return state;}need(!all.active,'guided-session-already-active');const script=listScripts().scripts.find(s=>s.id===body.scriptId);need(script,'session-script-unavailable');const sessionId='session-'+crypto.randomUUID(),dir=path.join(base,sessionId);ensureDir(dir);exclusive(path.join(dir,'script.json'),JSON.stringify(script,null,2)+'\n');exclusive(path.join(dir,'session.jsonl'),'');const state={sessionId};recordEvent(state,body,{type:'start',sessionId,scriptId:script.id,scriptSnapshot:script,participant,participantLabel:participant,version});return activateMissing(get(sessionId));}
 function stepFor(state,index,type){need(Number.isInteger(index)&&index>=0&&index<state.steps.length,'invalid-session-step-index');const step=state.steps[index];if(type)need(step.type===type,'session-step-type-mismatch');return step;}
 function command(action,body){
  const allowed={step:['stepIndex'],skip:['stepIndex','reason'],before:['stepIndex','takeId','answers','view'],view:['stepIndex','takeId','withoutAnswers','reason'],listen:['stepIndex','slot','answer'],questions:['stepIndex','answers'],end:[]};need(allowed[action],'invalid-session-action');keys(body,['requestId','sessionId',...allowed[action]]);const state=get(body.sessionId);if(prior(state,body.requestId,body))return state;
  // Answers and view receipts for already-bound takes remain writable after ending a session.
  if(!['before','view'].includes(action))need(!state.endedAt,'guided-session-ended');
  if(action==='end')return recordEvent(state,body,{type:'end'});
  const step=stepFor(state,body.stepIndex),scriptStep=state.scriptSnapshot.steps[body.stepIndex],baseEvent={type:'step',action,stepIndex:body.stepIndex};
  if(action==='step')return activateMissing(recordEvent(state,body,{...baseEvent,action:'activate'}));
  if(action==='skip'){need(text(body.reason??'user-skipped',500),'invalid-skip-reason');need(!step.pendingRecord,'session-record-pending');return recordEvent(state,body,{...baseEvent,skipped:true,reason:body.reason??'user-skipped'});}
  if(action==='before'||action==='view'){
   const take=step.takes.find(t=>t.takeId===body.takeId);need(take,'session-take-not-bound');
   if(action==='view'){need((body.withoutAnswers===undefined||typeof body.withoutAnswers==='boolean')&&text(body.reason??'',100),'invalid-session-view');return recordEvent(state,body,{...baseEvent,takeId:body.takeId,viewedAt:take.viewedAt??new Date(clock()).toISOString(),viewedWithoutAnswers:take.beforeAnswers===null,reason:take.beforeAnswers===null?'답 없이 봄':null});}
   need(!take.viewedAt&&!take.beforeAnswers,'before-answer-already-recorded');keys(body.answers,['direction','unstable','memo']);const questions=scriptStep.beforeQuestions;
   const direction=questions.find(q=>q.id==='overall'),unstable=questions.find(q=>q.id==='shaken');need(direction&&direction.options.includes(body.answers.direction)&&unstable&&Array.isArray(body.answers.unstable)&&body.answers.unstable.length>0&&body.answers.unstable.every(v=>unstable.options.includes(v))&&new Set(body.answers.unstable).size===body.answers.unstable.length&&(!body.answers.unstable.includes(unstable.exclusiveOption)||body.answers.unstable.length===1)&&text(body.answers.memo??'',1000)&&(body.view===undefined||typeof body.view==='boolean'),'invalid-before-answers');
   return recordEvent(state,body,{...baseEvent,takeId:body.takeId,beforeAnswers:{...body.answers,memo:body.answers.memo??''},viewedAt:body.view===true?new Date(clock()).toISOString():null});
  }
  if(action==='listen'){need(step.type==='listen'&&!step.skipped&&scriptStep.slots.includes(body.slot)&&scriptStep.options.includes(body.answer),'invalid-session-listen-answer');need(!step.listenAnswers.some(a=>a.slot===body.slot),'listen-answer-already-recorded');return recordEvent(state,body,{type:'listen',stepIndex:body.stepIndex,takeId:scriptStep.takeId,slot:body.slot,answer:body.answer});}
  need(step.type==='questions'&&Array.isArray(body.answers)&&body.answers.length===scriptStep.questions.length&&body.answers.every(a=>text(a,2000)),'invalid-session-question-answers');need(!step.answers.length,'question-answers-already-recorded');return recordEvent(state,body,{type:'questions',stepIndex:body.stepIndex,answers:body.answers});
 }
 function prepareRecord(body){
  const state=get(body.sessionId),step=stepFor(state,body.stepIndex,'record'),scriptStep=state.scriptSnapshot.steps[body.stepIndex];const {sessionId,stepIndex,...nativeCommand}=body;
  const existing=prior(state,body.requestId,body);if(existing){need(existing.action==='record-intent','request-id-content-mismatch');return {state,replayed:true,command:nativeCommand};}
  need(!state.endedAt&&state.currentStepIndex===body.stepIndex&&!step.skipped,'session-record-step-inactive');need(!step.takeIds.length&&!step.pendingRecord,'session-step-already-recorded');need(ownParticipant(body.participant)===state.participant,'session-participant-mismatch');need(body.type==='record'&&body.taskId===scriptStep.taskId&&body.bpm===scriptStep.bpm&&body.clickMode===scriptStep.clickMode,'session-record-settings-mismatch');
  // Prevent a genuine but unrelated prior controller request from being rebound.
  const requestFile=path.join(root,'bridge','ledger','request-'+body.requestId+'.json');if(fs.existsSync(requestFile)){checked(requestFile);throw Error('session-record-request-already-used');}
  return {state:recordEvent(state,body,{type:'step',action:'record-intent',stepIndex:body.stepIndex,command:nativeCommand}),replayed:false,command:nativeCommand};
 }
 function findAttempt(request,attempts=[]){const found=attempts.filter(a=>a.requestId===request);const ledger=path.join(root,'bridge','ledger');if(fs.existsSync(ledger)){chain(ledger,root);plain(ledger,true);for(const n of fs.readdirSync(ledger)){if(!/^attempt-[a-zA-Z0-9-]+\.json$/.test(n))continue;const a=JSON.parse(read(path.join(ledger,n)));if(a.requestId===request&&!found.some(x=>x.takeId===a.takeId))found.push(a);}}need(found.length<=1,'session-record-attempt-ambiguous');return found[0]??null;}
 function bind(sessionId,stepIndex,recordRequestId,attempts=[]){const state=get(sessionId),step=stepFor(state,stepIndex,'record');const intent=state.events.find(e=>e.action==='record-intent'&&e.requestId===recordRequestId&&e.stepIndex===stepIndex);need(intent,'session-record-intent-missing');const already=state.events.find(e=>e.action==='bind'&&e.commandRequestId===recordRequestId);if(already)return state;const attempt=findAttempt(recordRequestId,attempts);need(attempt&&id(attempt.takeId)&&attempt.taskId===intent.command.taskId&&attempt.bpm===intent.command.bpm&&attempt.clickMode===intent.command.clickMode&&ownParticipant(attempt.participant)===ownParticipant(intent.command.participant),'session-record-attempt-unconfirmed');need(!step.takeIds.length,'session-step-already-recorded');append(sessionId,{type:'step',action:'bind',stepIndex,takeId:attempt.takeId,participant:ownParticipant(attempt.participant),commandRequestId:recordRequestId,bindingSource:'controller-attempt-request-id'});return get(sessionId);}
 function recordFailed(sessionId,stepIndex,recordRequestId,error){const state=get(sessionId),step=stepFor(state,stepIndex,'record');if(step.pendingRecord?.requestId===recordRequestId)append(sessionId,{type:'step',action:'record-failed',stepIndex,commandRequestId:recordRequestId,error:String(error).slice(0,500)});return get(sessionId);}
 function bindCommand(body,attempts=[]){keys(body,['sessionId','stepIndex','requestId','recordRequestId']);const state=get(body.sessionId);if(prior(state,body.requestId,body))return state;need(requestId(body.recordRequestId),'invalid-record-request-id');const bound=bind(body.sessionId,body.stepIndex,body.recordRequestId,attempts);return recordEvent(bound,body,{type:'step',action:'binding-confirmed',stepIndex:body.stepIndex,commandRequestId:body.recordRequestId});}
 function recover(){for(const state of list().sessions)for(const step of state.steps)if(step.pendingRecord){const request=step.pendingRecord.requestId;if(findAttempt(request))bind(state.sessionId,step.index,request);else recordFailed(state.sessionId,step.index,request,'previous-run-ended-before-record-binding');}}
 function exportZip(body){keys(body,['sessionId','includePcm']);need(body.includePcm===undefined||typeof body.includePcm==='boolean','invalid-session-export');const state=get(body.sessionId),includePcm=body.includePcm!==false,archive=createSessionArchive(root,{maxExportBytes});
  archive.add(journal(state.sessionId),'session.jsonl');archive.addBytes('script.json',JSON.stringify(state.scriptSnapshot,null,2)+'\n');
  const takeIds=[...new Set(state.steps.flatMap((s,index)=>s.type==='listen'?[state.scriptSnapshot.steps[index].takeId]:s.takeIds))];
  for(const takeId of takeIds)archive.addTake(takeId,includePcm);
  return archive.finish({schema:'basslab-session-export-v1',sessionId:state.sessionId,scriptId:state.scriptId,participant:state.participant,createdAt:new Date(clock()).toISOString(),includePcm,takeIds,noEngineLogs:true});
 }
 recover();return {listScripts,list,get,start,command,prepareRecord,bind,bindCommand,findAttempt,recordFailed,exportZip,canListen,recover};
}
function createSessionArchive(root,{maxExportBytes=256*1024*1024,errorPrefix='session-export'}={}){
 root=path.resolve(root);plain(root,true);const entries=[],files=[],missing=[],omitted=[],names=new Set();let total=0;
 function addBytes(name,data){need(typeof name==='string'&&!name.includes('\\')&&!path.isAbsolute(name)&&name.split('/').every(s=>s&&s!=='.'&&s!=='..')&&!names.has(name),'invalid-export-entry');const bytes=Buffer.isBuffer(data)?data:Buffer.from(data);need(bytes.length<=128*1024*1024&&total+bytes.length<=maxExportBytes,errorPrefix+'-too-large');names.add(name);total+=bytes.length;entries.push({name,data:bytes});files.push({file:name,bytes:bytes.length,sha256:hash(bytes)});}
 function add(file,name){try{chain(file,root);const stat=plain(file);need(stat.size<=128*1024*1024&&total+stat.size<=maxExportBytes,errorPrefix+'-too-large');const data=fs.readFileSync(file);need(data.length===stat.size,errorPrefix+'-file-changed');addBytes(name,data);}catch(e){if(e.code==='ENOENT'){missing.push({file:name,reason:'not-present'});return;}throw e;}}
 function addTake(takeId,includePcm){need(id(takeId),'invalid-session-take-id');for(const name of ['run.json','feedback.jsonl','pcm.f32le']){const relative='takes/'+takeId+'/'+name;if(name==='pcm.f32le'&&!includePcm){omitted.push({file:relative,reason:'audio-not-selected'});continue;}add(path.join(root,relative),relative);}const derived='outputs/practice-takes/'+takeId+'/DERIVED.json';add(path.join(root,derived),derived);}
 function finish(metadata){entries.push({name:'EXPORT.json',data:JSON.stringify({...metadata,files,missing,omitted},null,2)+'\n'});const bytes=zip(entries);need(bytes.length<=maxExportBytes,errorPrefix+'-too-large');return bytes;}
 return {add,addBytes,addTake,finish};
}
module.exports={createSessionStore,validateScript,createSessionArchive};
