const V2_BPMS=[40,50,60,70,80];
const V2_ROUTES={unknown:"모름",direct:"인터페이스에서 바로",software:"프로그램을 거쳐"};
const V2_CLICK_MODES={quarter:"4분음표마다",sixteenth:"16분음표마다"};
const V2_SESSION_CHOICES={monitorRoute:"unknown",bpm:60,clickMode:"sixteenth",taskId:""};
function v2Finite(value){return typeof value==="number"&&Number.isFinite(value);}
function v2Active(state){return ["STARTING","RECORDING","STOPPING","SAVING","ENDING"].includes(state?.phase);}
function v2Idle(){return {phase:"idle",remaining:null,noteIndex:null};}
function v24TaskNoteCount(task){const count=task?.slots?.length??task?.plannedNoteCount;return Number.isInteger(count)&&count>0&&count<=256?count:32;}
function v2Frame(bpm,elapsedSeconds,preRoll=0,plannedNoteCount=32){
  if(!V2_BPMS.includes(bpm)||!v2Finite(elapsedSeconds)||!v2Finite(preRoll)||!Number.isInteger(plannedNoteCount)||plannedNoteCount<1||plannedNoteCount>256)return v2Idle();
  const time=elapsedSeconds-preRoll,beat=60/bpm;
  if(time<0)return {...v2Idle(),phase:"preparing"};
  if(time<8*beat)return {phase:"countin",remaining:8-Math.floor(time/beat),noteIndex:null};
  if(time>=(8+plannedNoteCount/4)*beat)return {...v2Idle(),phase:"stop"};
  return {phase:"play",remaining:null,noteIndex:Math.min(plannedNoteCount,1+Math.floor((time-8*beat)/(beat/4)))};
}
function v2NativeFrame(state,receivedPerf,nowPerf){
  const mapping={DORMANT:"idle",READY:"idle",FIRST_NOTE:"firstnote",STARTING:"preparing",STOPPING:"saving",SAVING:"saving",SAVED:"saved",ENDING:"saving",ENDED:"saved",ERROR:"error"};
  if(state?.phase!=="RECORDING")return {...v2Idle(),phase:mapping[state?.phase]||"waiting"};
  const p=state.progress,age=state.serverNowMs-state.progressReceivedAtMs+nowPerf-receivedPerf;
  if(!p||!p.uiClockValid||p.operation!=="record"||p.takeId!==state.activeTakeId||!v2Finite(age)||age<0||age>300||!v2Finite(p.elapsedSeconds))return {...v2Idle(),phase:"waiting"};
  return v2Frame(state.selectedBpm,p.elapsedSeconds+age/1000,state.preRollSeconds??1.25,state.plannedNoteCount??32);
}
function v2Clicks(bpm,mode,plannedNoteCount=32){
  if(!V2_BPMS.includes(bpm)||!Object.hasOwn(V2_CLICK_MODES,mode)||!Number.isInteger(plannedNoteCount)||plannedNoteCount<1||plannedNoteCount>256)return [];
  const beat=60000/bpm,steps=mode==="quarter"?Math.ceil(plannedNoteCount/4):plannedNoteCount,division=mode==="quarter"?1:4;
  return [...Array.from({length:8},(_,i)=>({offsetMs:i*beat,frequency:500,duration:.04})),...Array.from({length:steps},(_,i)=>({offsetMs:8*beat+i*beat/division,frequency:i>=steps-division?1700:i===0?1500:i%division===0?1150:850,duration:.035})),{offsetMs:(8+plannedNoteCount/4)*beat,frequency:2100,duration:.16,kind:"finish"}];
}
function v2DriftWords(drift){
  if(!v2Finite(drift))return "끝의 위치는 재지 못함";
  const n=Math.abs(drift),amount=n<.25?"조금":n<.75?"음 하나의 절반쯤":n<1.5?"한 음쯤":"약 "+Math.round(n)+"음";
  return n<.001?"끝에서 템포 누적 차이가 거의 없음":"끝에서는 "+amount+" "+(drift>0?"뒤":"앞");
}
function v2TempoWords(tempo){
  if(!tempo||!v2Finite(tempo.actualBpm))return "실제 템포를 아직 계산하지 못했습니다.";
  return "메트로놈 "+tempo.metronomeBpm+" · 실제 약 "+Math.round(tempo.actualBpm)+(v2Finite(tempo.driftNotes)?" · "+v2DriftWords(tempo.driftNotes):"");
}
function v2Status(note){return note.status==="agreement"?"두 값 일치":note.status==="reserved"?"시작 불분명":"재지 못함";}
function v2ProvisionalMapping(result,note){return result?.positionMapping?.provisional===true||/^provisional-|^ambiguous-/.test(note?.positionMapping||"");}
function v2PositionDescription(result,note){return Number.isInteger(note?.slotIndex)?(v2ProvisionalMapping(result,note)?"임시 상대 자리 ":"대응 자리 ")+note.slotIndex:"자리 대응 없음";}
function v2TaskMismatchWords(result,note){return v2ProvisionalMapping(result,note)?"임시 자리 대응: 과제와 다른 음":"과제와 다른 음";}
function v2RoundFive(value){return v2Finite(value)?Math.round(value/5)*5:null;}
function v2ResidualWords(value){const rounded=v2RoundFive(value);return rounded===null?"시각을 재지 못함":rounded===0?"이 테이크의 흐름 근처":Math.abs(rounded)+" ms · "+(rounded>0?"늦은 쪽":"빠른 쪽");}
function v2InWindow(result){return (result?.notes||[]).filter(note=>note.inWindow!==false);}
function v2Band(result){const e=result?.evenness||{};return e.bandAllowed===true&&v2Finite(e.bandMs)&&e.bandMs>0?e.bandMs:null;}
function v2OutsideNotes(result){const band=v2Band(result);return band===null?[]:v2InWindow(result).filter(note=>note.status==="agreement"&&v2Finite(note.residualMs)&&Math.abs(note.residualMs)>band);}
function v2MarkedIndices(result){return v2OutsideNotes(result).sort((a,b)=>Math.abs(b.residualMs)-Math.abs(a.residualMs)).slice(0,3).map(note=>note.index);}
function v2OutsideWords(result){
  if(v2Band(result)===null)return "시작 시각 비교는 임시입니다. 참고 띠는 표시하지 않습니다.";
  const rows=v2OutsideNotes(result),prefix=result.evenness?.provisional?"임시 · ":"";
  if(!rows.length)return prefix+"띠 밖으로 나간 음 없음";
  return prefix+"띠 밖으로 나간 후보: "+rows.map(note=>note.index).join(" · ")+" (늦은 쪽 "+rows.filter(note=>note.residualMs>0).length+" · 빠른 쪽 "+rows.filter(note=>note.residualMs<0).length+")";
}
function v2PlaybackRange(result,note){
  const candidates=result.clickAnchor?.candidates||[],notes=(result.notes||[]).map(n=>{const candidate=candidates.find(c=>c.candidateId===n.index);return {...n,timeSeconds:v2Finite(candidate?.playbackTimeSeconds)?candidate.playbackTimeSeconds:n.timeSeconds};}).filter(n=>v2Finite(n.timeSeconds)).sort((a,b)=>a.timeSeconds-b.timeSeconds),index=notes.findIndex(n=>n.index===note.index);
  if(index<0)return null;
  const before=notes[Math.max(0,index-2)],after=notes[Math.min(notes.length-1,index+2)];
  const end=Math.min(v2Finite(result.durationSeconds)?result.durationSeconds:Infinity,after.timeSeconds+.4),start=Math.max(0,before.timeSeconds-.15);
  return end>start?{startSeconds:start,endSeconds:end}:null;
}
function v2MeasuredCoverage(result){const e=result?.evenness||{},population=e.populationCount??v2InWindow(result).length,measured=e.measuredCount??v2InWindow(result).filter(n=>n.status==="agreement").length;return {measured,population,ratio:population>0?measured/population:null};}
function v2CanCompare(a,b){const aa=v2MeasuredCoverage(a),bb=v2MeasuredCoverage(b);return aa.ratio!==null&&bb.ratio!==null&&Math.abs(aa.ratio-bb.ratio)<=.15&&a.clickMode===b.clickMode&&a.sessionOrder===b.sessionOrder;}
function v2SpreadLabel(result,key){const e=result.evenness||{};if(!(e.validAdjacentPairs>=10))return "이어진 이웃 쌍이 10개 미만이라 수치를 표시하지 않습니다.";const value=e[key];if(!v2Finite(value))return "재지 못함";return Math.floor(value)+"~"+Math.ceil(value)+" ms";}
function v2CanStart(state,task,firstNote){return state?.captureEnabled===true&&!v2Active(state)&&state.phase!=="FIRST_NOTE"&&!!task&&!!firstNote&&state.phase!=="ANALYZING"&&!v13Calibrating(state);}
