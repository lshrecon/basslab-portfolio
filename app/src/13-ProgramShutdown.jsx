function v15ServerIdentity(value){return value&&Number.isInteger(value.pid)&&typeof value.rootFingerprint==="string"&&value.rootFingerprint?{pid:value.pid,rootFingerprint:value.rootFingerprint}:null;}
function v15SameServer(a,b){return !!a&&!!b&&a.pid===b.pid&&a.rootFingerprint===b.rootFingerprint;}
function v19ReloadForStaleToken(response,data){if(response.status===403&&data?.error==="invalid-session-token"){window.location.reload();throw new Error("프로그램이 다시 시작되어 화면을 새로 읽습니다.");}}
function v19CanReturnToTraining(state,loading,locked){return !loading&&!locked&&!v13Busy(state)&&!["LOADING","ENDING"].includes(state?.phase)&&state?.deviceReleased===true;}
function useProgramShutdown(phase){
  const [screen,setScreen]=useState({mode:"idle",message:""});
  const [lifecycle,setLifecycle]=useState(null);
  const locked=useRef(false),identity=useRef(null),receipt=useRef(null),cleanups=useRef(new Set()),updates=useRef(null),checking=useRef(false),alive=useRef(true),currentPhase=useRef(phase);
  currentPhase.current=phase;
  const registerCleanup=fn=>{cleanups.current.add(fn);return()=>cleanups.current.delete(fn);};
  const fetchStatus=async(route,body)=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),body?60000:3000);
    try{const response=await fetch("/api/"+route,{method:body?"POST":"GET",cache:"no-store",signal:controller.signal,headers:{"X-Session-Token":window.__SESSION_TOKEN__||"",...(body?{"Content-Type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{})});
      const data=await response.json();v19ReloadForStaleToken(response,data);if(!response.ok){const error=new Error(data.message||data.error||"종료 준비를 마치지 못했습니다.");error.httpStatus=response.status;throw error;}return data;
    }finally{clearTimeout(timer);}
  };
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const acceptReceipt=value=>{if(value?.lifecycle&&alive.current)setLifecycle(value.lifecycle);if(value?.safeToClose===true&&value.status==="closing"){
    const server=v15ServerIdentity(value)||identity.current;if(!server)return false;
    if(identity.current&&!v15SameServer(identity.current,server))return false;
    identity.current=server;receipt.current={...value,...server};return true;
  }return false;};
  const settle=async(initial,post,retry=false)=>{
    if(checking.current)return;checking.current=true;
    try{
      if(post&&!receipt.current){
        if(retry){const health=await fetchStatus("health"),server=v15ServerIdentity(health);if(!server||identity.current&&!v15SameServer(identity.current,server))throw new Error("처음 연습한 프로그램과 달라 종료를 다시 요청하지 않았습니다. 현재 프로그램의 화면을 확인해 주세요.");identity.current=server;}
        if(!receipt.current){if(alive.current)setScreen({mode:"closing",message:"저장과 장치 해제 상태를 다시 확인하고 종료합니다."});try{initial=await fetchStatus("shutdown",{requestId:crypto.randomUUID()});}catch(error){if(error.httpStatus)throw error;initial=null;}}
      }
      acceptReceipt(initial);
      for(let attempt=0;!receipt.current&&attempt<60&&alive.current;attempt++){
        let status;try{status=await fetchStatus("shutdown");}catch(error){if(receipt.current)break;throw error;}
        if(receipt.current)break;
        if(status.status==="failed")throw new Error(status.error||"저장과 장치 해제를 확인하지 못했습니다.");
        if(acceptReceipt(status))break;
        if(status.status!=="waiting"&&status.status!=="closing")throw new Error("종료 요청이 접수되었는지 확인하지 못했습니다.");
        await pause(1000);
      }
      if(!receipt.current)throw new Error("종료 준비 완료 응답을 확인하지 못했습니다.");
      if(!alive.current)return;
      updates.current?.(true);
      setScreen({mode:"closing",message:"저장과 장치 해제를 마쳤습니다. 프로그램이 닫힐 때까지 잠시 기다려 주세요."});
      for(let attempt=0;attempt<25&&alive.current;attempt++){
        let gone=false;
        try{const health=await fetchStatus("health"),server=v15ServerIdentity(health);gone=!!server&&!v15SameServer(receipt.current,server);}
        catch(error){gone=error instanceof TypeError;}
        if(gone){if(alive.current)setScreen({mode:"complete",message:"프로그램을 종료했습니다. 이 탭을 닫아도 됩니다"});return;}
        await pause(600);
      }
      throw new Error("저장과 장치 해제는 확인했지만, 프로그램이 닫혔는지는 아직 확인하지 못했습니다.");
    }catch(error){if(alive.current)setScreen({mode:"failed",canCheck:true,message:receipt.current?error.message:"안전한 종료를 확인하지 못했습니다. 이 탭을 열어 둔 채 종료 상태를 다시 확인해 주세요."});}
    finally{checking.current=false;}
  };
  const begin=async(initial,post)=>{
    if(locked.current)return;locked.current=true;
    const saving=["STARTING","RECORDING","STOPPING","SAVING"].includes(currentPhase.current);
    setScreen({mode:"closing",message:saving?"지금까지 녹음을 저장하고 종료합니다":"재생을 멈추고, 저장과 장치 해제를 마친 뒤 종료합니다."});
    updates.current?.(false);
    const pending=Array.from(cleanups.current,fn=>{try{return Promise.resolve(fn());}catch(error){return Promise.reject(error);}});
    document.querySelectorAll("audio").forEach(audio=>{audio.pause();audio.removeAttribute("src");audio.load();});
    try{await Promise.all(pending);if(alive.current)await settle(initial,post);}
    catch(error){if(alive.current)setScreen({mode:"failed",canCheck:false,message:"재생 정리를 마치지 못해 종료를 요청하지 않았습니다. 이 탭을 열어 두세요."});}
  };
  const observe=value=>{if(!value||value.status==="idle")return;if(locked.current){if(acceptReceipt(value))updates.current?.(true);return;}begin(value,false);};
  useEffect(()=>{alive.current=true;fetchStatus("health").then(value=>{if(!locked.current)identity.current=v15ServerIdentity(value);}).catch(()=>{});return()=>{alive.current=false;};},[]);
  return {screen,lifecycle,locked,updates,registerCleanup,observe,start:()=>begin(null,true),check:()=>settle(null,!receipt.current,true)};
}

function v18ShutdownSteps(lifecycle,complete){
  const known=!!lifecycle;
  return [
    {label:"녹음과 결과 정리",done:complete||(known&&!lifecycle.failure&&lifecycle.savePending===false&&lifecycle.analysisPending===false&&lifecycle.analysisAwaitingStart===false&&lifecycle.calibrationPending===false)},
    {label:"오디오 장치 해제",done:complete||(known&&lifecycle.deviceReleased===true&&lifecycle.nativeProcessClosed===true&&lifecycle.nativeCleanExit===true&&lifecycle.auxiliaryPending!==true)},
    {label:"프로그램 종료",done:complete}
  ];
}
