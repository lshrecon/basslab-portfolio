'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto'),cp=require('node:child_process');
const {PROFILE,VERSIONS,sha,plain,readJson,exclusive,createController}=require('./practice-controller.cjs');
const {isDeepStrictEqual}=require('node:util');
const {StringDecoder}=require('node:string_decoder');
const ROOT=path.resolve(__dirname,'..');
const {createShutdown}=require('./shutdown.cjs');
const {createUiLifecycle}=require('./ui-lifecycle.cjs');
const {FIXED_PORT,ENGINE_VERSION,DISCOVERY,DISCOVERY_ORIGINS}=require('./engine-config.cjs');
const {createClickResults}=require('./click-results.cjs');
const {createSettings,diagnosticZip,localTake,safeId,chain}=require('./portable-state.cjs');
const {createSessionStore}=require('./session-store.cjs');
const {createParticipantStore,ownParticipant}=require('./participant-store.cjs');
const {TASKS}=require('./tasks.cjs');
// Incoming chunks may end in the middle of a UTF-8 character. Count raw bytes
// for the protocol limit, and retain partial characters until the next chunk.
async function readRequestText(req,maximumBytes=16384){
 const decoder=new StringDecoder('utf8');let text='',receivedBytes=0;
 for await(const chunk of req){receivedBytes+=chunk.length;if(receivedBytes>maximumBytes)return null;text+=decoder.write(chunk);}
 return text+decoder.end();
}
function optional(file,fallback){try{return readJson(file);}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
function errorMessage(code){const labels={'invalid-participant':'이름표는 비워 두지 말고 짧은 별명으로 적어 주세요.','participant-selection-changed':'지금 치는 사람이 바뀌었습니다. 이름표를 확인하고 다시 시작해 주세요.','participant-change-while-busy':'녹음과 저장, 장치 해제가 끝난 뒤 치는 사람을 바꿔 주세요.','session-participant-mismatch':'이 세션의 치는 사람과 현재 이름표가 다릅니다. 세션의 이름표로 바꿔 주세요.','participant-unavailable':'이 이름표를 사용할 수 없습니다. 숨김을 해제하거나 다른 이름표를 골라 주세요.','participant-already-exists':'이미 있는 이름표입니다. 목록에서 골라 주세요.'};return labels[code]||(code==='capture-unavailable'?'이번 실행에서는 더 녹음할 수 없습니다. 프로그램 종료 뒤 BassLab.exe 를 다시 실행해 주세요.':code==='diagnostic-export-too-large'?'내보낼 기록이 너무 큽니다. 함께 보낼 녹음 소리의 선택을 줄여 다시 시도해 주세요.':['session-export-too-large','participant-export-too-large'].includes(code)?'내보낼 기록이 너무 큽니다. 녹음 소리를 제외하거나 세션별로 나누어 내보내 주세요.':'프로그램 쪽 문제로 멈췄습니다. 장치와 지연 설정의 기록 내보내기를 보내 주세요');}
function verifyCapture(root=ROOT){const record=readJson(path.join(root,'bridge','CAPTURE-READY.json'));if(record.profile!==PROFILE||record.implementationChecksPassed!==true||!Array.isArray(record.files)||record.files.length<10)throw new Error('capture-checkpoint-not-ready');for(const f of record.files){const p=path.resolve(root,f.file);if(!p.startsWith(root+path.sep))throw new Error('invalid-capture-manifest-path');chain(p,root);const stat=plain(p),b=fs.readFileSync(p);if(stat.size!==f.bytes||sha(b)!==f.sha256)throw new Error('capture-dependency-changed: '+f.file);}return record;}
function toStereoWav(pcm){if(pcm.length%4)throw new Error('PCM alignment');const out=Buffer.alloc(44+pcm.length*2);out.write('RIFF');out.writeUInt32LE(out.length-8,4);out.write('WAVEfmt ',8);out.writeUInt32LE(16,16);out.writeUInt16LE(3,20);out.writeUInt16LE(2,22);out.writeUInt32LE(44100,24);out.writeUInt32LE(44100*8,28);out.writeUInt16LE(8,32);out.writeUInt16LE(32,34);out.write('data',36);out.writeUInt32LE(pcm.length*2,40);for(let i=0;i<pcm.length/4;i++){const sample=pcm.readFloatLE(i*4);if(!Number.isFinite(sample))throw new Error('nonfinite PCM');pcm.copy(out,44+i*8,i*4,i*4+4);pcm.copy(out,48+i*8,i*4,i*4+4);}return out;}
function analysisWorker(root,log,spawnWorker=cp.spawn){return result=>new Promise((resolve,reject)=>{
 const requests=path.join(root,'bridge','analysis-requests');fs.mkdirSync(requests,{recursive:true});plain(requests,true);
 const context=path.join(requests,result.takeId+'.json');try{exclusive(context,result);}catch(error){reject(error);return;}
 const child=spawnWorker(process.execPath,[path.join(root,'source','analyze-practice-worker.cjs'),'--saved-context',context],{cwd:root,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
 let out='',err='',failure=null;const outDecoder=new StringDecoder('utf8'),errDecoder=new StringDecoder('utf8');child.stdout.on('data',b=>{out+=outDecoder.write(b);if(out.length>1024*1024&&!failure){failure=new Error('analysis-worker-output-limit');child.kill();}});child.stderr.on('data',b=>{err+=errDecoder.write(b);if(err.length>1024*1024&&!failure){failure=new Error('analysis-worker-error-limit');child.kill();}});
 child.on('error',error=>{failure=error;});child.on('close',(code,signal)=>{out+=outDecoder.end();err+=errDecoder.end();log({kind:'analysis-worker-closed',takeId:result.takeId,code,signal,stdout:out,stderr:err});if(failure){reject(failure);return;}if(code!==0||signal){reject(new Error('analysis-worker-failed; automatic retry disabled'));return;}try{resolve(JSON.parse(out.trim()));}catch{reject(new Error('analysis-worker-invalid-result'));}});
});}
function enumerateWorker(root,spawnWorker=cp.spawn,timeoutMs=10000){return new Promise((resolve,reject)=>{
 const child=spawnWorker(path.join(root,'native','bin','practice-engine-v2.exe'),['--enumerate-devices'],{cwd:root,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});let out='',err='',failure=null;const outDecoder=new StringDecoder('utf8'),errDecoder=new StringDecoder('utf8');
 const stop=error=>{if(!failure){failure=error;child.kill();}},timer=setTimeout(()=>stop(Error('device-list-timeout')),timeoutMs);
 child.stdout.on('data',b=>{if(!failure){out+=outDecoder.write(b);if(out.length>1024*1024)stop(Error('device-list-output-limit'));}});child.stderr.on('data',b=>{if(!failure){err+=errDecoder.write(b);if(err.length>1024*1024)stop(Error('device-list-error-limit'));}});
 child.on('error',e=>{clearTimeout(timer);failure=e;});child.on('close',(code,signal)=>{clearTimeout(timer);out+=outDecoder.end();err+=errDecoder.end();if(failure)return reject(failure);if(code!==0||signal)return reject(Error('device-list-failed: '+err.slice(0,1000)));try{const value=JSON.parse(out.trim());if(value.deviceStreamOpens!==0)throw Error('device-list-opened-stream');resolve(value);}catch(e){reject(e);}});
});}
function createServer({root=ROOT,port=FIXED_PORT,spawnEngine,enumerateDevices,settingsFactory=createSettings,verify=()=>verifyCapture(root),captureEnabled,controllerFactory=createController,onSavedAnalysis,allowedPcmRoots,publicFallbackRoot,shutdownTimeoutMs=45000,shutdownPollMs=50,shutdownDelayMs=500,uiGraceMs=10000,uiRecoveryPollMs=1000,onShutdownClosed=()=>{}}={}){
 root=path.resolve(root);if(captureEnabled===undefined){try{verify();captureEnabled=true;}catch{captureEnabled=false;}}
 const token=crypto.randomBytes(32).toString('hex'),clients=new Set(),origin='http://127.0.0.1:'+port,session=crypto.randomUUID();
 const runtime=path.join(root,'runtime');fs.mkdirSync(runtime,{recursive:true});plain(runtime,true);const journal=path.join(runtime,'bridge-'+session+'.jsonl');
 const log=v=>fs.appendFileSync(journal,JSON.stringify({atUtc:new Date().toISOString(),...v})+'\n');
 const resultFile=path.join(root,'outputs','UI-RESULTS.json'),listeningFile=path.join(root,'outputs','LISTENING-UI.json');
 const readResults=()=>{const input=optional(resultFile,{results:[]}),value=Array.isArray(input)?{results:input}:input,results=[...(value.results||[])];const derived=path.join(root,'outputs','practice-takes');
  if(fs.existsSync(derived)){plain(derived,true);for(const n of fs.readdirSync(derived)){if(!/^practice-v2-[a-f0-9-]{36}$/.test(n))continue;const dir=path.join(derived,n);plain(dir,true);const d=optional(path.join(dir,'DERIVED.json'),null);if(d?.ui&&!results.some(r=>r.takeId===d.ui.takeId))results.push(d.ui);}}
  return {...value,results:results.map(r=>{if(!safeId(r.takeId))throw Error('invalid-result-take-id');const pcm=path.join(root,'takes',r.takeId,'pcm.f32le'),run=path.join(root,'takes',r.takeId,'run.json');return clickResults.enrich({...r,feedback:(()=>{const f=path.join(root,'takes',r.takeId,'feedback.jsonl');if(!fs.existsSync(f))return [];plainChain(f,path.join(root,'takes'));plain(f);return fs.readFileSync(f,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);})(),originalPcm:typeof r.originalPcm==='object'?{...r.originalPcm,path:pcm}:pcm,runIdentity:r.runIdentity?{...r.runIdentity,path:run}:undefined});})};};
 const listeningLedger=path.join(root,'bridge','listening-ledger');fs.mkdirSync(listeningLedger,{recursive:true});plain(listeningLedger,true);
 const responsePath=(kind,id)=>path.join(listeningLedger,kind+'-'+crypto.createHash('sha256').update(id).digest('hex')+'.json');
 function readListening(){const v=optional(listeningFile,{takes:[],ringTasks:[]});return {...v,takes:(v.takes||[]).map(t=>({...t,response:optional(responsePath('listening',t.code),null)?.response??t.response??null})),ringTasks:(v.ringTasks||[]).map(t=>({...t,response:optional(responsePath('ring',t.id),null)?.response??t.response??null}))};}
 function listeningCommand(body){if(typeof body.requestId!=='string'||!/^[a-zA-Z0-9-]{1,80}$/.test(body.requestId))throw new Error('invalid-request-id');const catalog=readListening();let id,response,kind;
  if(body.type==='listening-response'){if(!catalog.takes.some(t=>t.code===body.code)||!['missedSounds','extraTicks'].every(k=>Number.isSafeInteger(body[k])&&body[k]>=0&&body[k]<=1000))throw new Error('invalid-listening-response');id=body.code;kind='listening';response={missedSounds:body.missedSounds,extraTicks:body.extraTicks};}
  else{if(!catalog.ringTasks.some(t=>t.id===body.id)||!['yes','no','unknown'].includes(body.answer))throw new Error('invalid-ring-response');id=body.id;kind='ring';response={answer:body.answer};}
  const p=responsePath(kind,id),prior=optional(p,null);if(prior){if(prior.requestId!==body.requestId||JSON.stringify(prior.response)!==JSON.stringify(response))throw new Error('response-already-saved');return;}
  exclusive(p,{kind,id,response,requestId:body.requestId,source:'user-listening-report-not-sample-accurate-ground-truth',createdAt:new Date().toISOString()});
 }
 for(const folder of ['takes','calibrations','outputs']){const p=path.join(root,folder);fs.mkdirSync(p,{recursive:true});plain(p,true);}
 const settings=settingsFactory(root);
 const participantProfiles=createParticipantStore(root);
 const guidedSessions=createSessionStore(root,{taskIds:TASKS.map(t=>t.taskId)});
 let shutdown=null,uiLifecycle=null,enumerationPending=0,closeScheduled=false,closeTimer=null;
 let sessionBinding=false;
 const stateSnapshot=()=>({...controller.snapshot(),participantProfiles:participantProfiles.snapshot(),guidedSessions:guidedSessions.list(),shutdown:shutdown?.snapshot()??{status:'idle',safeToClose:false},uiLifecycle:uiLifecycle?.snapshot()??null});
 const onChange=state=>{if(sessionBinding)return;const text='data: '+JSON.stringify({...state,participantProfiles:participantProfiles.snapshot(),guidedSessions:guidedSessions.list(),shutdown:shutdown?.snapshot()??{status:'idle',safeToClose:false},uiLifecycle:uiLifecycle?.snapshot()??null})+'\n\n';for(const response of clients){if(response.destroyed||response.writableEnded){clients.delete(response);continue;}/* A false write is buffered successfully; let it drain and coalesce later heartbeat snapshots. */if(!response.writableNeedDrain)response.write(text);}};
 let nativeOrdinal=0;
 const spawn=spawnEngine||(()=>{const r=path.join(runtime,'native-'+session+'-'+(++nativeOrdinal));fs.mkdirSync(r);plain(r,true);return cp.spawn(path.join(root,'native','bin','practice-engine-v2.exe'),['--serve','--root',path.join(root,'takes'),'--resources',path.join(root,'resources'),'--runtime',r],{cwd:root,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});});
 const enumerate=enumerateDevices||(()=>enumerateWorker(root));
 const calibrationSaved=async e=>{const dir=path.join(root,'calibrations',e.takeId);plain(dir,true);const runPath=path.join(dir,'run.json'),pcmPath=path.join(dir,'pcm.f32le');plain(runPath);plain(pcmPath);const run=readJson(runPath),pcm=fs.readFileSync(pcmPath);if(run.takeId!==e.takeId||run.deviceReleased!==true||run.pcm?.sha256!==sha(pcm)||run.pcm?.byteLength!==pcm.length||run.engineVersion!==VERSIONS.program||run.schema!=='basslab-practice-v2-run-v1'||run.scheduleVersion!=='frozen-mulberry32-relative-offset-nearest-ties-up-v1'||run.kind!=='C'||run.operation!=='calibration'||!isDeepStrictEqual(run.deviceSelection,e.binding.deviceSelection)||!isDeepStrictEqual(run.clickCalibration,e.binding.clickCalibration))throw Error('calibration-file-binding-mismatch');const resources={accent:fs.readFileSync(path.join(root,'resources/accent.pcm24-stereo.bin')),subdivision:fs.readFileSync(path.join(root,'resources/subdivision.pcm24-stereo.bin'))};let measured;if(!run.valid||!run.complete)measured={accepted:false,kFrames:null,reason:'calibration-capture-incomplete'};else measured=require('../click/calibrate.cjs').measureCalibration({pcm,run,resources});const bound={deviceKey:e.binding.clickCalibration.deviceKey,selection:e.binding.deviceSelection};const result=settings.storeCalibration(measured,e.takeId,bound);exclusive(path.join(dir,'measurement.json'),{...result,runIdentity:{bytes:plain(runPath).size,sha256:sha(fs.readFileSync(runPath))},pcmIdentity:{bytes:pcm.length,sha256:sha(pcm)}});log({kind:'calibration-measured',takeId:e.takeId,accepted:result.accepted,reason:result.reason});return result;};
 const controller=controllerFactory({root,spawnEngine:spawn,captureEnabled,verify,onChange,getDeviceBinding:()=>settings.binding(),onCalibrationSaved:calibrationSaved,onSavedAnalysis:onSavedAnalysis===undefined?analysisWorker(root,log):onSavedAnalysis,log,knownResultIds:()=>readResults().results.map(r=>r.takeId),stdout:b=>fs.appendFileSync(path.join(runtime,'native-'+session+'-stdout.log'),b),stderr:b=>fs.appendFileSync(path.join(runtime,'native-'+session+'-stderr.log'),b)});
 shutdown=createShutdown({controller,identity:{pid:process.pid,rootFingerprint:sha(Buffer.from(root))},getLifecycle:()=>({...controller.lifecycle(),auxiliaryPending:enumerationPending>0}),onChange:()=>onChange(controller.snapshot()),log,timeoutMs:shutdownTimeoutMs,pollMs:shutdownPollMs});
 const pcmRoots=[path.join(root,'takes')];
 const clickResults=createClickResults({root,pcmRoots});
 const fallbackPublic=null;
 const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'"};
 const trainingHeaders={...headers,'Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'"};
 const send=(res,code,value)=>{res.writeHead(code,{...headers,'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
 function binary(req,res,bytes,mime){const range=req.headers.range;if(range){const m=/^bytes=(\d+)-(\d*)$/.exec(range);if(!m)return send(res,416,{error:'unsupported-range'});const lo=Number(m[1]),hi=m[2]?Math.min(Number(m[2]),bytes.length-1):bytes.length-1;if(lo>hi||lo>=bytes.length)return send(res,416,{error:'range-outside'});res.writeHead(206,{...headers,'Content-Type':mime,'Accept-Ranges':'bytes','Content-Range':`bytes ${lo}-${hi}/${bytes.length}`,'Content-Length':hi-lo+1});res.end(bytes.subarray(lo,hi+1));return;}res.writeHead(200,{...headers,'Content-Type':mime,'Content-Length':bytes.length,'Accept-Ranges':'bytes'});res.end(bytes);}
 function plainChain(file,limit){let p=path.dirname(file);while(p.startsWith(limit+path.sep)||p===limit){plain(p,true);if(p===limit)return;p=path.dirname(p);}throw new Error('path-outside-root');}
 function scheduleClose(reason){
  const value=shutdown.snapshot();if(closeScheduled||value.status!=='closing'||value.safeToClose!==true)return;
  closeScheduled=true;closeTimer=setTimeout(()=>{closeTimer=null;uiLifecycle.stop();log({kind:'server-closing',reason,shutdown:shutdown.snapshot()});for(const response of clients)response.end();clients.clear();server.close();server.closeAllConnections();},shutdownDelayMs);
 }
 function closeAfterReceipt(res){if(closeScheduled)return;res.once('finish',()=>scheduleClose('shutdown-receipt-delivered'));}
 uiLifecycle=createUiLifecycle({shutdown,getClientCount:()=>clients.size,close:()=>scheduleClose('last-ui-disconnected'),onChange:()=>onChange(controller.snapshot()),log,graceMs:uiGraceMs,recoveryPollMs:uiRecoveryPollMs});

 const server=http.createServer(async(req,res)=>{try{
  if(req.headers.host!=='127.0.0.1:'+port)return send(res,403,{error:'invalid-host'});
  const url=new URL(req.url,origin),route=url.pathname;
  if(route==='/api/discovery'){
   const incoming=req.headers.origin,external=incoming&&incoming!==origin;
   if(external&&!DISCOVERY_ORIGINS.includes(incoming))return send(res,403,{error:'discovery-origin-not-allowed'});
   if(!incoming&&req.headers['sec-fetch-site']==='cross-site')return send(res,403,{error:'discovery-origin-required'});
   const cors=external?{'Access-Control-Allow-Origin':incoming,'Vary':'Origin'}:{};
   if(req.method==='OPTIONS'){
    if(!incoming||req.headers['access-control-request-method']!=='GET'||String(req.headers['access-control-request-headers']||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean).some(x=>x!=='accept'))return send(res,403,{error:'discovery-preflight-not-allowed'});
    res.writeHead(204,{...headers,...cors,'Access-Control-Allow-Methods':'GET','Access-Control-Max-Age':'0',...(req.headers['access-control-request-private-network']==='true'?{'Access-Control-Allow-Private-Network':'true'}:{})});return res.end();
   }
   if(req.method!=='GET')return send(res,405,{error:'discovery-method-not-allowed'});
   res.writeHead(200,{...headers,...cors,'Content-Type':'application/json; charset=utf-8'});return res.end(JSON.stringify(DISCOVERY));
  }
  if(req.headers.origin&&req.headers.origin!==origin)return send(res,403,{error:'cross-origin-request'});
  if(req.headers['sec-fetch-site']==='cross-site')return send(res,403,{error:'cross-site-request'});
  if(req.method==='GET'&&route==='/api/health')return send(res,200,{application:'basslab-portable-v13',pid:process.pid,rootFingerprint:sha(Buffer.from(root))});
  if(req.method==='GET'&&route==='/api/shutdown'){const value=shutdown.snapshot();if(value.status==='closing'&&value.safeToClose===true)closeAfterReceipt(res);return send(res,200,value);}
  if(req.method==='GET'&&route==='/api/settings')return send(res,200,settings.snapshot());
  if(req.method==='GET'&&route==='/api/devices'){if(shutdown.started())throw Error('shutdown-in-progress');if(controller.snapshot().deviceReleased!==true)throw Error('device-list-while-busy');enumerationPending++;try{const d=settings.acceptDevices(await enumerate());return send(res,200,{...d,settings:settings.snapshot()});}finally{enumerationPending--;}}
  if(req.method==='GET'&&route==='/api/state')return send(res,200,stateSnapshot());
  if(req.method==='GET'&&route==='/api/tasks')return send(res,200,{tasks:controller.tasks()});
  if(req.method==='GET'&&route==='/api/participants')return send(res,200,participantProfiles.snapshot());
  if(req.method==='GET'&&route==='/api/sessions/scripts')return send(res,200,guidedSessions.listScripts());
  if(req.method==='GET'&&route==='/api/sessions')return send(res,200,guidedSessions.list());
  if(req.method==='GET'&&route.startsWith('/api/sessions/'))return send(res,200,guidedSessions.get(decodeURIComponent(route.slice('/api/sessions/'.length))));
  if(req.method==='GET'&&route==='/api/results'){const value=readResults();return send(res,200,{...value,results:value.results.map(r=>({...r,participant:participantProfiles.takeOwner(r.takeId,r.participant),excluded:controller.excluded(r.takeId)||r.excluded===true}))});}
  if(req.method==='GET'&&route==='/api/takes')return send(res,200,{takes:controller.takes().map(t=>({...t,participant:ownParticipant(t.participant)}))});
  if(req.method==='GET'&&route==='/api/listening')return send(res,200,readListening());
  if(req.method==='GET'&&route==='/api/events'){
   res.writeHead(200,{...headers,'Content-Type':'text/event-stream','Connection':'keep-alive'});clients.add(res);uiLifecycle.connected();res.write('data: '+JSON.stringify(stateSnapshot())+'\n\n');
   req.on('close',()=>{clients.delete(res);uiLifecycle.disconnected();});return;
  }
  if(req.method==='POST'&&(['/api/command','/api/listening-response','/api/settings','/api/feedback','/api/diagnostics','/api/shutdown'].includes(route)||route.startsWith('/api/sessions/')||route.startsWith('/api/participants/'))){
   if(req.headers['x-session-token']!==token)return send(res,403,{error:'invalid-session-token'});
   if(!String(req.headers['content-type']).startsWith('application/json'))return send(res,415,{error:'json-required'});
   const text=await readRequestText(req);if(text===null)return send(res,413,{error:'request-too-large'});
   const body=JSON.parse(text);
   if(route==='/api/shutdown'){if(!body||Array.isArray(body)||Object.keys(body).some(k=>k!=='requestId'))throw Error('invalid-shutdown-body');const value=await shutdown.request(body.requestId);if(value.status==='closing'&&value.safeToClose===true){closeAfterReceipt(res);return send(res,200,value);}return send(res,409,value);}
   if(shutdown.started())return send(res,409,{error:'shutdown-in-progress',shutdown:shutdown.snapshot(),state:stateSnapshot()});
   if(route.startsWith('/api/participants/')){const action=route.slice('/api/participants/'.length);if(action==='export'){const bytes=participantProfiles.exportZip(body,guidedSessions);res.setHeader('Content-Disposition','attachment; filename="basslab-participant.zip"');return binary(req,res,bytes,'application/zip');}const state=controller.snapshot();const busy=state.deviceReleased!==true||['STARTING','FIRST_NOTE','RECORDING','CALIBRATING','CALIBRATION_ANALYZING','STOPPING','SAVING','ANALYZING','ENDING'].includes(state.phase);const value=participantProfiles.command(action,body,{busy});onChange(controller.snapshot());return send(res,200,value);}
   if(route.startsWith('/api/sessions/')){const action=route.slice('/api/sessions/'.length);if(action==='export'){const bytes=guidedSessions.exportZip(body);res.setHeader('Content-Disposition','attachment; filename="basslab-session.zip"');return binary(req,res,bytes,'application/zip');}if(action==='start'){const prior=guidedSessions.list().sessions.flatMap(s=>s.events).find(e=>e.type==='start'&&e.requestId===body.requestId);body.participant=prior?ownParticipant(body.participant??prior.participant):participantProfiles.selected(body.participant);}if(['step','skip','before','view','listen','questions'].includes(action)&&guidedSessions.get(body.sessionId).participant!==participantProfiles.snapshot().selected)throw Error('session-participant-mismatch');const value=action==='start'?guidedSessions.start(body):action==='bind'?guidedSessions.bindCommand(body,controller.takes()):guidedSessions.command(action,body);onChange(controller.snapshot());return send(res,200,{session:value,guidedSessions:guidedSessions.list()});}
   if(route==='/api/settings'){if(controller.snapshot().deviceReleased!==true||['STARTING','FIRST_NOTE','RECORDING','CALIBRATING','CALIBRATION_ANALYZING','STOPPING','SAVING','ANALYZING','ENDING'].includes(controller.snapshot().phase))throw Error('device-change-while-busy');const value=settings.save(body);controller.resetSelection();log({kind:'devices-selected',selection:value.selection});return send(res,200,{...value,state:stateSnapshot()});}
   if(route==='/api/feedback'){if(typeof body.requestId!=='string'||!/^[a-zA-Z0-9-]{1,80}$/.test(body.requestId)||!safeId(body.takeId)||!Number.isSafeInteger(body.slotIndex)||body.slotIndex<1||!['false-positive','missed-note','timing-mismatch'].includes(body.type))throw Error('invalid-result-feedback');const p=localTake(root,body.takeId,'feedback.jsonl'),run=readJson(localTake(root,body.takeId,'run.json')),count=run.plannedNoteCount??32;if(run.takeId!==body.takeId||!Number.isInteger(count)||count<1||count>256||body.slotIndex>count)throw Error('invalid-result-feedback');if(fs.existsSync(p))plain(p);const prior=fs.existsSync(p)?fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];const same=prior.find(x=>x.requestId===body.requestId);if(same&&(same.slotIndex!==body.slotIndex||same.type!==body.type))throw Error('request-id-content-mismatch');if(!same)fs.appendFileSync(p,JSON.stringify({...body,participant:ownParticipant(run.participant),createdAt:new Date().toISOString(),meaning:'user-observation-not-detector-ground-truth'})+'\n');return send(res,200,{saved:true,takeId:body.takeId,slotIndex:body.slotIndex,type:body.type});}
   if(route==='/api/diagnostics'){const bytes=diagnosticZip(root,body.includePcmTakeIds??[]);res.setHeader('Content-Disposition','attachment; filename="basslab-diagnostics.zip"');return binary(req,res,bytes,'application/zip');}
   if(['listening-response','ring-response'].includes(body.type)){listeningCommand(body);return send(res,200,{state:stateSnapshot(),listening:readListening()});}
   if(route==='/api/command'&&['record','first-note'].includes(body.type)){let prior=null;if(typeof body.requestId==='string'&&/^[a-zA-Z0-9-]{1,80}$/.test(body.requestId)){const file=path.join(root,'bridge','ledger','request-'+body.requestId+'.json');if(fs.existsSync(file)){chain(file,root);prior=readJson(file);}}body.participant=prior?.body?.type===body.type?ownParticipant(body.participant??prior.body.participant):participantProfiles.selected(body.participant);}
   if(route==='/api/command'&&(body.sessionId!==undefined||body.stepIndex!==undefined)){
    if(body.type!=='record')throw Error('session-binding-record-only');const prepared=guidedSessions.prepareRecord(body);
    if(prepared.replayed){const bound=prepared.state.steps[body.stepIndex].takeIds.length>0;if(!bound)throw Error('session-record-request-already-finished');return send(res,200,{state:stateSnapshot(),session:prepared.state,guidedSessions:guidedSessions.list()});}
    sessionBinding=true;let commandState,sessionState;
    try{commandState=controller.command(prepared.command);sessionState=guidedSessions.bind(body.sessionId,body.stepIndex,body.requestId,controller.takes());}
    catch(error){try{sessionState=guidedSessions.bind(body.sessionId,body.stepIndex,body.requestId,controller.takes());}catch{if(!guidedSessions.findAttempt(body.requestId,controller.takes()))guidedSessions.recordFailed(body.sessionId,body.stepIndex,body.requestId,error.message);}throw error;}
    finally{sessionBinding=false;onChange(controller.snapshot());}
    return send(res,200,{state:{...commandState,guidedSessions:guidedSessions.list()},session:sessionState,guidedSessions:guidedSessions.list()});
   }
   return send(res,200,{state:controller.command(body)});
  }
  if(req.method!=='GET')return send(res,405,{error:'method-not-allowed'});
  if(route.startsWith('/api/audio/')){
   const metadata=route.endsWith('/meta');const id=decodeURIComponent(route.slice('/api/audio/'.length,metadata?-5:undefined));if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id))return send(res,400,{error:'invalid-take-id'});
   const result=readResults().results.find(r=>r.takeId===id)||controller.takes().find(r=>r.takeId===id);const field=result?.originalPcm??result?.pcmIdentity?.path;const pcm=typeof field==='string'?field:field?.path;
   if(!pcm)return send(res,404,{error:'audio-unavailable'});const p=path.resolve(pcm),allowed=pcmRoots.find(r=>p.startsWith(r+path.sep));if(!allowed||path.basename(p)!=='pcm.f32le')throw new Error('audio-path-not-allowed');plainChain(p,allowed);if(plain(p).size>64*1024*1024)throw new Error('audio-too-large');const bytes=fs.readFileSync(p),expected=result?.pcmIdentity?.sha256??(typeof field==='object'?field.sha256:null);if(expected&&sha(bytes)!==expected)throw new Error('audio-identity-mismatch');if(metadata||url.searchParams.get('click')==='1'||(url.searchParams.get('click')==='0'&&result?.clickPlayback?.available)){const mix=clickResults.playback(result,bytes);if(metadata)return send(res,200,mix.metadata);res.setHeader('X-Audio-Mix-Gain',String(mix.metadata.commonGain));res.setHeader('X-Audio-Click',url.searchParams.get('click')==='1'?'1':'0');return binary(req,res,url.searchParams.get('click')==='1'?mix.on:mix.off,'audio/wav');}return binary(req,res,toStereoWav(bytes),'audio/wav');
  }
  if(route.startsWith('/public/')){const relative=decodeURIComponent(route.slice(8));if(!/^[a-zA-Z0-9._/-]+$/.test(relative)||relative.split('/').some(p=>p==='..'||p==='.'||!p))return send(res,400,{error:'invalid-media-path'});let publicRoot=path.join(root,'public'),file=path.resolve(publicRoot,relative);if(!fs.existsSync(file)&&fallbackPublic){publicRoot=path.resolve(fallbackPublic);file=path.resolve(publicRoot,relative);}if(!file.startsWith(publicRoot+path.sep)||!['.wav','.png','.jpg','.svg'].includes(path.extname(file)))return send(res,404,{error:'media-not-found'});plainChain(file,publicRoot);plain(file);return binary(req,res,fs.readFileSync(file),path.extname(file)==='.wav'?'audio/wav':path.extname(file)==='.svg'?'image/svg+xml':path.extname(file)==='.jpg'?'image/jpeg':'image/png');}
  if(route==='/analysis'){res.writeHead(308,{...headers,Location:'/analysis/'});return res.end();}
  const analysisFiles=['index.html','styles.css','observation.min.js','react.production.min.js','react-dom.production.min.js'];
  const trainingFiles=['index.html','app.min.js','styles.css','react.production.min.js','react-dom.production.min.js','Tone.js','tone.min.js','tone-14.8.49.min.js'];
  let folder=null,name=null;
  if(route==='/'||route==='/index.html'){folder='training';name='index.html';}
  else if(route==='/analysis/'){folder='app';name='index.html';}
  else if(route.startsWith('/analysis/')&&analysisFiles.includes(route.slice(10))){folder='app';name=route.slice(10);}
  else if(route.startsWith('/training/')&&trainingFiles.includes(route.slice(10))){folder='training';name=route.slice(10);}
  else if(analysisFiles.includes(route.slice(1))&&route!=='/index.html'){folder='app';name=route.slice(1);}
  if(!folder)return send(res,404,{error:'not-found'});const file=path.join(root,folder,name);plain(file);let bytes=fs.readFileSync(file);
  if(name==='index.html')bytes=Buffer.from(bytes.toString('utf8').replace('</head>','<script>window.__SESSION_TOKEN__='+JSON.stringify(token)+';window.__BASSLAB_PORTABLE__='+JSON.stringify({version:ENGINE_VERSION,fixedPort:FIXED_PORT,temporaryPort:port!==FIXED_PORT})+';</script></head>'));
  if(folder==='training'){res.writeHead(200,{...trainingHeaders,'Content-Type':name.endsWith('.js')?'text/javascript; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8','Content-Length':bytes.length});return res.end(bytes);}
  return binary(req,res,bytes,name.endsWith('.js')?'text/javascript; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8');
 }catch(error){log({kind:'http-error',message:error.message});if(!res.headersSent)send(res,409,{error:error.message,message:errorMessage(error.message),state:stateSnapshot()});else res.destroy();}});
 const heartbeat=setInterval(()=>onChange(controller.snapshot()),500);heartbeat.unref();
 server.on('close',()=>{clearInterval(heartbeat);if(closeTimer)clearTimeout(closeTimer);uiLifecycle.stop();for(const r of clients)r.destroy();if(!shutdown.started())controller.end('server-close');if(shutdown.snapshot().status==='closing')onShutdownClosed(shutdown.snapshot());});
 return {server,controller,shutdown,uiLifecycle,guidedSessions,participantProfiles,token,origin,port,root,log};
}
if(require.main===module){const p=Number(process.env.BASSLAB_PORT||(process.argv.includes('--port')?process.argv[process.argv.indexOf('--port')+1]:FIXED_PORT));if(!Number.isInteger(p)||p<1024||p>65535)throw Error('invalid-port');const app=createServer({port:p});app.server.listen(app.port,'127.0.0.1',()=>console.log(JSON.stringify({url:app.origin,pid:process.pid,captureEnabled:app.controller.snapshot().captureEnabled,nativeSpawnCount:0})));app.server.on('error',e=>{console.error(e.message);process.exitCode=1;});}
function verifyPackage(root=ROOT){const manifest=readJson(path.join(root,'PACKAGE-MANIFEST.json'));if(!Array.isArray(manifest.files)||!manifest.files.length)throw Error('package-manifest-invalid');const seen=new Set();for(const item of manifest.files){if(typeof item.file!=='string'||item.file.includes('\\')||item.file.split('/').some(part=>!part||part==='.'||part==='..')||seen.has(item.file))throw Error('invalid-package-manifest-path');seen.add(item.file);const file=path.resolve(root,item.file);if(!file.startsWith(root+path.sep))throw Error('invalid-package-manifest-path');chain(file,root);const bytes=fs.readFileSync(file);if(bytes.length!==item.bytes||sha(bytes)!==item.sha256)throw Error('package-dependency-changed: '+item.file);}return manifest;}
module.exports={ROOT,createServer,verifyCapture,verifyPackage,toStereoWav,analysisWorker,enumerateWorker,errorMessage,readRequestText};


