// Task-list presentation only; task slots and analysis remain owned by the bridge.
function v25TaskGroups(tasks,participant="나"){
  const ordinary=(tasks||[]).filter(task=>task.group!=="teacher"),teacher=(tasks||[]).filter(task=>task.group==="teacher");
  return participant==="선생님"?{primary:teacher,secondary:ordinary,secondaryLabel:"다른 과제 보기"}:{primary:ordinary,secondary:teacher,secondaryLabel:"선생님 과제"};
}
function v25PracticeInitial(tasks,participant,initialConfig=null){
  const supplied=initialConfig&&!(V2_SESSION_CHOICES.participant===participant&&V2_SESSION_CHOICES.initialConfig===initialConfig)?initialConfig:null;
  const groups=v25TaskGroups(tasks,participant),remembered=supplied?.taskId??V2_SESSION_CHOICES.taskId;
  const task=supplied||V2_SESSION_CHOICES.participant===participant?(tasks||[]).find(item=>item.taskId===remembered):groups.primary.find(item=>item.taskId===remembered);
  const selected=task||groups.primary[0]||(tasks||[])[0],teacher=selected?.group==="teacher";
  return {taskId:selected?.taskId||"",bpm:supplied?.bpm??(teacher&&!task?selected.defaultBpm??60:V2_SESSION_CHOICES.bpm),clickMode:supplied?.clickMode??(teacher&&!task?selected.defaultClickMode??"sixteenth":V2_SESSION_CHOICES.clickMode),monitorRoute:supplied?.monitorRoute??V2_SESSION_CHOICES.monitorRoute,secondary:groups.secondary.some(item=>item.taskId===selected?.taskId)};
}
function v25TeacherTaskSelection(task,current){return task?.group==="teacher"?{...current,taskId:task.taskId,bpm:task.defaultBpm??60,clickMode:task.defaultClickMode??"sixteenth"}:{...current,taskId:task?.taskId||""};}
function v25FullChromatic(result){return result?.taskId==="chromatic-full-224"||result?.taskId==="teacher-6-full"||result?.sourceTaskId==="chromatic-full-224";}
