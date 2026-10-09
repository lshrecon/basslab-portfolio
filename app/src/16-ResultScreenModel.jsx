// Result-screen helpers only. Stored analysis, pairing and calibration stay unchanged.
function v22TaskName(result){
  if(/^teacher-[1-6]-/.test(result?.taskId||""))return result.taskLabel||(typeof result.label==="string"?result.label.replace(result.taskId+" · ",""):null)||"선생님 과제";
  if(result?.taskId==="chromatic-full-224")return "크로매틱 전체 · 포지션 3–9 · 224음";
  const position=/^chromatic-pos-([3-9])$/.exec(result?.taskId||"");if(position){const fret=Number(position[1]);return "크로매틱 "+fret+"~"+(fret+3)+"프렛(포지션 "+fret+")";}
  const known=/^([eadg])-(open|chromatic)-32$/.exec(result?.taskId||"");
  if(known)return known[1].toUpperCase()+"현 "+(known[2]==="open"?"개방현":"1–4프렛 크로매틱");
  const label=typeof result?.label==="string"?result.label.split("·").map(part=>part.trim()).filter(part=>part&&part!==result.taskId&&!/^(?:[a-z]+-){1,}[a-z0-9-]+$/i.test(part)&&!/^N\d+$/.test(part)).join(" · "):"";
  return label||"이름을 확인하지 못한 과제";
}
function v22RecordedTime(result){const raw=result?.recordedAt||result?.finishedAt||result?.createdAt;if(typeof raw!=="string"||!raw.trim())return null;const time=Date.parse(raw);return v2Finite(time)?time:null;}
function v22RecordedLabel(result){const time=v22RecordedTime(result);return time===null?"날짜 기록 없음":new Date(time).toLocaleString("ko-KR",{year:"numeric",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false,timeZone:"Asia/Seoul"});}
function v22ResultLabel(result){const bpm=result?.tempo?.metronomeBpm,click=({sixteenth:"16분 클릭",quarter:"4분 클릭"})[result?.clickMode]||"클릭 기록 없음";return [v22TaskName(result),v2Finite(bpm)?bpm+" BPM":"빠르기 기록 없음",click,v22RecordedLabel(result)].join(" · ");}
function v22NewestResults(results){return (results||[]).map((result,order)=>({result,order,time:v22RecordedTime(result)})).sort((a,b)=>(b.time??-Infinity)-(a.time??-Infinity)||a.order-b.order).map(item=>item.result);}
function v22PlotTop(deltaMs){return v2Finite(deltaMs)?50-Math.max(-100,Math.min(100,deltaMs))*.43:null;}
function v22BeatGroups(slots){const groups=[];for(const slot of slots||[]){if(!Number.isInteger(slot.index)||slot.index<1)continue;const ordinal=Math.floor((slot.index-1)/4),last=groups.at(-1);if(last?.ordinal===ordinal)last.count++;else groups.push({ordinal,bar:Math.floor(ordinal/4)+1,beat:ordinal%4+1,count:1});}return groups;}
function v22SoundPosition(result,candidateId){const slot=v12Anchor(result)?.slots.find(item=>item.candidateId===candidateId);return slot?"음 "+slot.index+"번째":"짝 없는 소리";}
function v22SegmentView(result,blockStart=null){
  const anchor=v12Anchor(result);
  if(!anchor||!v21ResultCalibrationValid(result))return {visible:false,segments:[],text:"",caution:""};
  const planned=v25FullChromatic(result)?224:result.plannedNoteCount??Math.max(32,...anchor.slots.map(slot=>slot.index));
  if(blockStart===null&&planned>32){const rows=Array.from({length:Math.ceil(Math.min(planned,256)/32)},(_,index)=>({position:v25FullChromatic(result)?index+3:null,first:index*32+1,last:Math.min(planned,(index+1)*32),...v22SegmentView(result,index*32+1)}));return {visible:true,rows,segments:rows.flatMap(row=>row.segments),text:rows.map(row=>(row.position?"포지션 "+row.position:row.first+"–"+row.last+"번째")+" · "+row.text).join("\n"),caution:rows[0]?.caution||""};}
  const missing=new Set(v17UnclearSound(result).missingSlotIndices),extras=(anchor.extras||[]).filter(extra=>extra.kind==="extra"&&Number.isInteger(extra.nearestSlotIndex));
  const segments=Array.from({length:4},(_,ordinal)=>{
    const first=(blockStart??1)+ordinal*8,last=first+7,slots=anchor.slots.filter(slot=>slot.index>=first&&slot.index<=last),timed=slots.filter(slot=>slot.candidateId!=null&&slot.timingUnavailable!==true&&v2Finite(slot.deltaMs));
    const ambiguousPairing=slots.some(slot=>missing.has(slot.index))&&extras.some(extra=>extra.nearestSlotIndex>=first&&extra.nearestSlotIndex<=last),eligible=timed.length>=5&&!ambiguousPairing;
    const meanMs=eligible?timed.reduce((sum,slot)=>sum+slot.deltaMs,0)/timed.length:null;
    return {ordinal,bar:Math.floor(ordinal/2)+1,beats:ordinal%2===0?"1–2박":"3–4박",first,last,total:slots.length,count:timed.length,ambiguousPairing,eligible,meanMs,direction:eligible&&Math.abs(meanMs)>=30?(meanMs<0?"앞":"뒤"):null};
  });
  const eligible=segments.filter(segment=>segment.eligible),phrases=[];
  for(const direction of ["앞","뒤"]){const chosen=segments.filter(segment=>segment.direction===direction);if(!chosen.length)continue;let previousBar=null;const positions=chosen.map(segment=>{const words=(segment.bar===previousBar?"":segment.bar+"마디 ")+segment.beats;previousBar=segment.bar;return words;});phrases.push(positions.join(" · ")+"이 클릭보다 "+direction);}
  const text=phrases.length?phrases.join(", "):!eligible.length?"구간의 앞뒤를 살필 음이 충분하지 않습니다.":eligible.length===4?"30 ms 넘게 쏠린 구간 없음":"확인 가능한 구간 중 30 ms 넘게 쏠린 구간 없음";
  return {visible:true,segments,text,caution:result.monitorRoute==="software"?"(프로그램을 거쳐 들으면 앞뒤가 실제와 다를 수 있음)":""};
}
