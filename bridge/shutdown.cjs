'use strict';
function createShutdown({controller,identity,getLifecycle,onChange=()=>{},log=()=>{},timeoutMs=45000,pollMs=50,clock=Date.now}={}){
 let receipt={status:'idle',requestId:null,safeToClose:false,...identity},pending=null;
 const lifecycle=()=>getLifecycle?getLifecycle():typeof controller.lifecycle==='function'?controller.lifecycle():{failure:'shutdown-lifecycle-unavailable',nativeProcessClosed:true,analysisPending:false};
 const snapshot=()=>{const state=lifecycle();if(receipt.status==='failed'&&receipt.error==='shutdown-wait-timeout'&&ready(state)){receipt={...receipt,status:'closing',safeToClose:true,error:null,recoveredAfterTimeout:true,readyAt:new Date(clock()).toISOString()};log({kind:'shutdown-timeout-recovered',...receipt,lifecycle:state});}return {...receipt,lifecycle:state};};
 const ready=v=>v.deviceReleased===true&&v.nativeProcessClosed===true&&v.analysisPending===false&&v.analysisAwaitingStart===false&&v.savePending===false&&v.calibrationPending===false&&v.auxiliaryPending!==true&&!v.failure;
 const publish=()=>{log({kind:'server-shutdown',...snapshot()});onChange();};
 function request(requestId){
  if(typeof requestId!=='string'||!/^[a-zA-Z0-9-]{1,80}$/.test(requestId))throw Error('invalid-shutdown-request-id');
  if(pending)return pending.then(()=>snapshot());
  if(receipt.status==='closing')return Promise.resolve(snapshot());
  receipt={...receipt,status:'waiting',requestId,safeToClose:false,error:null,requestedAt:new Date(clock()).toISOString()};delete receipt.failedAt;delete receipt.readyAt;delete receipt.recoveredAfterTimeout;publish();
  pending=(async()=>{
   try{
    controller.end('explicit-program-shutdown',{graceful:true});
    const deadline=clock()+timeoutMs;
    while(true){const state=lifecycle();
     if(ready(state)){receipt={...receipt,status:'closing',safeToClose:true,readyAt:new Date(clock()).toISOString()};publish();return snapshot();}
     if(state.nativeProcessClosed&&!state.analysisPending&&(state.failure||state.analysisAwaitingStart||state.savePending||state.calibrationPending||!state.deviceReleased))throw Error(state.failure||'shutdown-preservation-or-release-unconfirmed');
     if(clock()>=deadline)throw Error('shutdown-wait-timeout');
     await new Promise(resolve=>setTimeout(resolve,pollMs));
    }
   }catch(error){receipt={...receipt,status:'failed',safeToClose:false,error:error.message,failedAt:new Date(clock()).toISOString()};publish();return snapshot();}
  })().finally(()=>{pending=null;});
  return pending;
 }
 return {snapshot,request,started:()=>receipt.status!=='idle'};
}
module.exports={createShutdown};
