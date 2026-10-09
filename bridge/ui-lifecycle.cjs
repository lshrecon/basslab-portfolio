'use strict';
const crypto=require('node:crypto');

// An open SSE connection represents an open UI, including a background tab.
// A grace period tolerates reloads; shutdown itself remains the existing path.
function createUiLifecycle({shutdown,getClientCount,close,onChange=()=>{},log=()=>{},graceMs=10000,recoveryPollMs=1000,clock=Date.now}={}){
 let hasOpened=false,deadlineAtMs=null,graceTimer=null,recoveryTimer=null,shutdownRequested=false,closeRequested=false,stopped=false,requestFailure=null;
 const clearGrace=()=>{if(graceTimer!==null)clearTimeout(graceTimer);graceTimer=null;deadlineAtMs=null;};
 const clearRecovery=()=>{if(recoveryTimer!==null)clearInterval(recoveryTimer);recoveryTimer=null;};
 function snapshot(){
  const receipt=shutdown.snapshot(),connectedTabs=getClientCount();
  const status=stopped?'closed':receipt.status==='failed'||requestFailure?'unconfirmed':receipt.status==='closing'||receipt.status==='waiting'?'shutting-down':deadlineAtMs!==null?'waiting-for-reconnect':connectedTabs?'connected':hasOpened?'disconnected':'not-opened';
  return {hasOpened,connectedTabs,graceMs,deadlineAtMs,shutdownRequested,status};
 }
 function inspect(){
  if(stopped||closeRequested)return;
  const receipt=shutdown.snapshot();
  if(receipt.status==='closing'&&receipt.safeToClose===true){closeRequested=true;clearGrace();clearRecovery();log({kind:'ui-lifecycle-safe-close',shutdown:receipt});close();return;}
  // Only timeout has an existing read-only recovery path. Keep an unconfirmed
  // native/save/analysis failure available for inspection, without retrying END.
  if(receipt.status==='failed'&&receipt.error!=='shutdown-wait-timeout')clearRecovery();
 }
 function monitor(){
  if(stopped||closeRequested)return;
  if(recoveryTimer===null){recoveryTimer=setInterval(inspect,recoveryPollMs);recoveryTimer.unref();}
  inspect();
 }
 function connected(){
  if(stopped)return;hasOpened=true;
  if(deadlineAtMs!==null)log({kind:'ui-lifecycle-reconnected',connectedTabs:getClientCount()});
  clearGrace();onChange();
 }
 function disconnected(){
  if(stopped||!hasOpened||getClientCount()>0)return;
  if(shutdown.started()){monitor();return;}
  if(graceTimer!==null)return;
  deadlineAtMs=clock()+graceMs;log({kind:'ui-lifecycle-grace-started',deadlineAtMs,graceMs});onChange();
  graceTimer=setTimeout(()=>{
   graceTimer=null;deadlineAtMs=null;
   if(stopped||getClientCount()>0)return;
   if(shutdown.started()){monitor();return;}
   shutdownRequested=true;log({kind:'ui-lifecycle-last-ui-closed'});
   try{
    const pending=shutdown.request('last-ui-'+crypto.randomUUID());monitor();
    Promise.resolve(pending).then(()=>{if(!stopped){inspect();onChange();}},error=>{requestFailure=error.message;clearRecovery();log({kind:'ui-lifecycle-request-unconfirmed',error:requestFailure});if(!stopped)onChange();});
   }catch(error){requestFailure=error.message;log({kind:'ui-lifecycle-request-unconfirmed',error:requestFailure});onChange();}
  },graceMs);graceTimer.unref();
 }
 function stop(){stopped=true;clearGrace();clearRecovery();}
 return {connected,disconnected,snapshot,stop};
}
module.exports={createUiLifecycle};
