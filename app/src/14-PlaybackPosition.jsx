// Playback positions stay in the original recording's seconds at every listening speed.
function v16PlaybackTimeline(result){
  const duration=v2Finite(result?.durationSeconds)&&result.durationSeconds>0?result.durationSeconds:null;
  const inRecording=time=>v2Finite(time)&&time>=0&&(duration===null||time<duration);
  const anchor=v12Anchor(result),slots=(anchor?.slots||[]).filter(s=>inRecording(s.clickTimeSeconds)).slice().sort((a,b)=>a.clickTimeSeconds-b.clickTimeSeconds);
  const source=Array.isArray(result?.clickAnchor?.candidates)?result.clickAnchor.candidates.map(c=>({index:c.candidateId,timeSeconds:v2Finite(c.playbackTimeSeconds)?c.playbackTimeSeconds:c.timeSeconds,timeSource:c.measuredTimingCandidate===false?"rho":c.timingUnavailable?"withheld-locator":c.timeSource,agreement:c.agreement,kind:c.kind})):(result?.notes||[]).map(n=>({index:n.index,timeSeconds:v2Finite(n.measuredOnsetTime)?n.measuredOnsetTime:n.listeningLocatorOnly!==true&&n.status==="agreement"?n.timeSeconds:null,timeSource:"measured",agreement:n.status==="agreement"}));
  const candidates=source.filter(c=>c.index!=null&&c.kind!=="invalid"&&c.timeSource!=="rho"&&["r2","knee","measured","withheld-locator"].includes(c.timeSource)&&inRecording(c.timeSeconds)).sort((a,b)=>a.timeSeconds-b.timeSeconds);
  const last=slots.at(-1),previous=slots.at(-2),interval=last&&previous?last.clickTimeSeconds-previous.clickTimeSeconds:null;
  const finish=(anchor?.clickEvents||[]).find(e=>e.kind==="finish"&&inRecording(e.timeSeconds)&&e.timeSeconds>last?.clickTimeSeconds)?.timeSeconds;
  const lastEnd=last?Math.min(duration??Infinity,finish??Infinity,interval>0?last.clickTimeSeconds+interval:finish??last.clickTimeSeconds):null;
  return {duration,slots,candidates,lastEnd,unknownCandidates:Math.max(0,(result?.notes?.length||source.length)-candidates.length)};
}
function v16PlaybackAt(timeline,time){
  if(!v2Finite(time))return {slot:null,candidate:null};
  const slot=timeline.slots.find((s,i)=>time>=s.clickTimeSeconds&&time<(timeline.slots[i+1]?.clickTimeSeconds??timeline.lastEnd))||null;
  // A short onset marker is a locator, not an inferred duration or a new detection.
  const candidate=timeline.candidates.find((c,i)=>time>=c.timeSeconds&&time<Math.min(c.timeSeconds+.2,timeline.candidates[i+1]?.timeSeconds??Infinity))||null;
  return {slot,candidate};
}
function v16FormatTime(value){if(!v2Finite(value))return "—";const tenths=Math.floor(Math.max(0,value)*10+1e-6),seconds=Math.floor(tenths/10);return Math.floor(seconds/60)+":"+String(seconds%60).padStart(2,"0")+"."+tenths%10;}
function useV16Playback(audio,onError){
  const [position,setPosition]=useState({phase:"idle",time:null,duration:null});
  const generation=useRef(0),frame=useRef(null),range=useRef(null),pending=useRef(null),mounted=useRef(true),transition=useRef(false),internalPause=useRef(false),media=useRef(null);
  const cancelFrame=()=>{if(frame.current!==null)cancelAnimationFrame(frame.current);frame.current=null;};
  const update=patch=>{if(mounted.current)setPosition(old=>({...old,...patch}));};
  const stop=(phase="idle",time=null)=>{generation.current++;range.current=null;transition.current=false;internalPause.current=false;cancelFrame();pending.current?.();pending.current=null;const a=media.current||audio.current;media.current=null;if(a){a.pause();a.removeAttribute("src");a.load();}update({phase,time,duration:null});};
  const current=(token,a)=>mounted.current&&token===generation.current&&audio.current===a&&!!range.current;
  // Register before assigning currentTime: a seek can complete synchronously or later.
  const seekStart=(a,start)=>new Promise((resolve,reject)=>{
    const cleanup=()=>{a.removeEventListener("seeked",ready);a.removeEventListener("error",error);if(pending.current===cancel)pending.current=null;};
    const ready=()=>{if(a.seeking)return;cleanup();resolve(true);};
    const error=()=>{cleanup();reject(new Error("녹음 재생 파일을 열지 못했습니다."));};
    const cancel=()=>{cleanup();resolve(false);};pending.current=cancel;
    a.addEventListener("seeked",ready);a.addEventListener("error",error);
    try{a.currentTime=start;if(!a.seeking)ready();}catch(error){cleanup();reject(error);}
  });
  const repeat=async()=>{
    const a=audio.current,r=range.current;if(!a||!r?.ready||!r.loop||transition.current)return;
    const token=generation.current;transition.current=true;cancelFrame();internalPause.current=!a.paused;a.pause();update({phase:"seeking"});
    try{
      if(!await seekStart(a,r.startSeconds)||!current(token,a))return;
      update({time:a.currentTime});await a.play();
      if(current(token,a)){transition.current=false;if(!a.paused)startFrames();}
    }catch(error){if(current(token,a)){stop("error");onError(error.message);}}
  };
  const finish=()=>{const r=range.current;if(!r||transition.current)return;if(r.loop)repeat();else stop("ended",r.endSeconds);};
  const sample=()=>{const a=audio.current,r=range.current;if(!a||!r?.ready||transition.current)return false;const time=a.currentTime;if(!v2Finite(time))return false;if(time>=r.endSeconds){finish();return false;}update({time});return true;};
  const startFrames=()=>{const a=audio.current;if(!range.current?.ready||transition.current||!a||a.paused||a.seeking)return;cancelFrame();update({phase:"playing"});const token=generation.current;const tick=()=>{if(!current(token,a))return;frame.current=null;if(a.paused||a.seeking)return;if(sample())frame.current=requestAnimationFrame(tick);};tick();};
  const suspend=phase=>{const a=audio.current,r=range.current;if(!a||!r)return;cancelFrame();if(!transition.current)update({phase,...(v2Finite(a.currentTime)?{time:Math.min(a.currentTime,r.endSeconds)}:{})});};
  const paused=()=>{
    if(internalPause.current){internalPause.current=false;return;}
    const a=audio.current,r=range.current;if(!a||!r||!a.paused)return;
    // Browsers may dispatch pause immediately before ended at the physical file end.
    if(a.ended){cancelFrame();return;}
    r.loop=false;
    // An external pause also cancels an in-flight seek/play, so it cannot resume later.
    if(transition.current)stop("paused",v2Finite(a.currentTime)?a.currentTime:null);else suspend("paused");
  };
  const fail=()=>{if(!range.current)return;stop("error");onError("녹음 재생 파일을 열지 못했습니다.");};
  const play=async(url,wanted,speed,options={})=>{
    stop();const a=audio.current;if(!mounted.current)return false;if(!a||!url||!wanted||!v2Finite(wanted.startSeconds)||(!v2Finite(wanted.endSeconds)&&!(options?.loop!==true&&wanted.endSeconds===Infinity))||wanted.startSeconds<0||!(wanted.endSeconds>wanted.startSeconds)){update({phase:"error"});onError("이 구간의 재생 자료를 준비하지 못했습니다.");return false;}
    const token=generation.current;media.current=a;range.current={...wanted,loop:options?.loop===true,ready:false};transition.current=true;update({phase:"loading",time:null,duration:null});a.src=url;
    try{
      const loaded=await new Promise((resolve,reject)=>{const cleanup=()=>{a.removeEventListener("loadedmetadata",ready);a.removeEventListener("error",error);if(pending.current===cancel)pending.current=null;};const ready=()=>{if(a.readyState<1)return;cleanup();resolve(true);};const error=()=>{cleanup();reject(new Error("녹음과 클릭 재생 파일을 열지 못했습니다."));};const cancel=()=>{cleanup();resolve(false);};pending.current=cancel;a.addEventListener("loadedmetadata",ready);a.addEventListener("error",error);a.load();});
      if(!loaded||!current(token,a))return false;
      const end=v2Finite(a.duration)?Math.min(wanted.endSeconds,a.duration):wanted.endSeconds;
      if(!v2Finite(end)||!(end>wanted.startSeconds))throw new Error("이 구간의 재생 자료를 준비하지 못했습니다.");
      range.current={startSeconds:wanted.startSeconds,endSeconds:end,loop:options?.loop===true,ready:true};v13SetSpeed(a,speed);
      if(!await seekStart(a,wanted.startSeconds)||!current(token,a))return false;
      update({time:a.currentTime,duration:v2Finite(a.duration)?a.duration:null});
      await a.play();if(current(token,a)){transition.current=false;if(!a.paused)startFrames();}return current(token,a)&&!a.paused;
    }catch(error){if(current(token,a)){stop("error");onError(error.message);}return false;}
  };
  useEffect(()=>{
    mounted.current=true;
    const leave=()=>stop("paused"),hidden=()=>{if(document.hidden)leave();};
    document.addEventListener("visibilitychange",hidden);window.addEventListener("pagehide",leave);
    return()=>{mounted.current=false;document.removeEventListener("visibilitychange",hidden);window.removeEventListener("pagehide",leave);stop();};
  },[]);
  return {position,stop,play,active:["loading","playing","waiting","seeking","paused"].includes(position.phase),handlers:{onPlaying:startFrames,onPause:paused,onWaiting:()=>suspend("waiting"),onStalled:()=>{if(audio.current?.readyState<3)suspend("waiting");},onSeeking:()=>suspend("seeking"),onSeeked:()=>{if(!range.current||transition.current)return;sample();if(audio.current?.paused)suspend("paused");else if(audio.current?.readyState<3)suspend("waiting");else startFrames();},onTimeUpdate:sample,onEnded:()=>{const a=audio.current;if(range.current?.ready&&!transition.current&&(a?.ended||a?.currentTime>=range.current.endSeconds))finish();},onError:fail}};
}
