const V17_UNCLEAR_LABEL="소리는 났지만 음이 또렷하지 않음";

// UI annotations only: rejected sound evidence never becomes a note or an onset.
function v17UnclearSound(result){
  const anchor=v12Anchor(result),slots=anchor?.slots||[],matched=slots.filter(slot=>slot.candidateId!=null),unmatched=slots.filter(slot=>slot.candidateId==null);
  const view={bySlot:{},unclearSlotIndices:[],matchedCount:matched.length,missingSlotIndices:unmatched.map(slot=>slot.index),totalSlots:slots.length};
  const duration=v2Finite(result?.durationSeconds)&&result.durationSeconds>=0?result.durationSeconds:null;
  const inRecording=time=>v2Finite(time)&&time>=0&&(duration===null||time<duration);
  const ordered=slots.filter(slot=>slot.recorded!==false&&inRecording(slot.clickTimeSeconds)).slice().sort((a,b)=>a.clickTimeSeconds-b.clickTimeSeconds);
  if(!ordered.length||ordered.some((slot,i)=>i>0&&slot.clickTimeSeconds<=ordered[i-1].clickTimeSeconds)||new Set(ordered.map(slot=>slot.index)).size!==ordered.length)return view;
  const bpm=result?.tempo?.metronomeBpm??result?.bpm,subdivision=result?.subdivision??4;
  const nominal=v2Finite(bpm)&&bpm>0&&v2Finite(subdivision)&&subdivision>0?60/bpm/subdivision:null;
  if(ordered.length===1&&nominal===null)return view;
  // Every slot owns its local half-interval, including matched slots. Midpoint
  // ties belong to the later slot; the outer half-intervals stay bounded.
  const windows=ordered.map((slot,i)=>{
    const time=slot.clickTimeSeconds,previous=ordered[i-1]?.clickTimeSeconds,next=ordered[i+1]?.clickTimeSeconds;
    return {slot,start:previous==null?time-(next==null?nominal:next-time)/2:(previous+time)/2,end:next==null?time+(previous==null?nominal:time-previous)/2:(time+next)/2};
  });
  const evidence=new Map();
  for(const[candidateOrder,candidate]of(Array.isArray(result?.rejectedCandidates)?result.rejectedCandidates:[]).entries()){
    if(candidate?.gateEvidence?.gates?.aboveFloor!==true||!inRecording(candidate.timeSeconds))continue;
    const owner=windows.find(window=>candidate.timeSeconds>=window.start&&candidate.timeSeconds<window.end);
    if(!owner||owner.slot.candidateId!=null)continue;
    const group=evidence.get(owner.slot.index)||[];
    group.push({id:candidate.id,time:candidate.timeSeconds,distance:Math.abs(candidate.timeSeconds-owner.slot.clickTimeSeconds),order:candidateOrder});
    evidence.set(owner.slot.index,group);
  }
  for(const slot of slots){
    const group=evidence.get(slot.index);if(!group?.length)continue;
    group.sort((a,b)=>a.distance-b.distance||a.time-b.time||String(a.id??"").localeCompare(String(b.id??""))||a.order-b.order);
    view.bySlot[slot.index]={state:"unclear-sound",label:V17_UNCLEAR_LABEL,rejectedCandidateIds:[...new Set(group.map(item=>item.id).filter(id=>id!=null))]};
    view.unclearSlotIndices.push(slot.index);
  }
  view.missingSlotIndices=unmatched.filter(slot=>!view.bySlot[slot.index]).map(slot=>slot.index);
  return view;
}
