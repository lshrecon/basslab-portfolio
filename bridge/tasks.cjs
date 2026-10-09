'use strict';
const strings=[{string:'A',midi:33},{string:'D',midi:38},{string:'G',midi:43},{string:'E',midi:28}];
const names=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const name=m=>names[m%12]+(Math.floor(m/12)-1);
const TASKS=strings.flatMap(s=>[false,true].map(chromatic=>{
 const frets=Array.from({length:32},(_,i)=>chromatic?i%4+1:0),first=s.midi+frets[0];
 return {taskId:`${s.string.toLowerCase()}-${chromatic?'chromatic':'open'}-32`,label:`${s.string}현 ${chromatic?'1–4프렛 크로매틱':'개방현'} · 32음`,firstMidi:first,firstNoteName:name(first),
  slots:frets.map(f=>({string:s.string,fret:f,noteName:name(s.midi+f),midi:s.midi+f})),instruction:'새 음을 칠 때 앞 음이 자연스럽게 뮤트되어도 됩니다.'};
}));
// Each position is one existing 32-slot recording: E,A,D,G, then G,D,A,E.
const chromaticStringOrder=['E','A','D','G','G','D','A','E'];
for(let position=3;position<=9;position++){
 const slots=chromaticStringOrder.flatMap(string=>Array.from({length:4},(_,offset)=>{
  const fret=position+offset,midi=strings.find(item=>item.string===string).midi+fret;
  return {string,fret,noteName:name(midi),midi};
 }));
 TASKS.push({taskId:`chromatic-pos-${position}`,label:`크로매틱 ${position}~${position+3}프렛(포지션 ${position})`,firstMidi:slots[0].midi,firstNoteName:slots[0].noteName,slots,instruction:'새 음을 칠 때 앞 음이 자연스럽게 뮤트되어도 됩니다. 줄을 넘을 때 앞 줄이 울리지 않게 가볍게 막아 주세요.'});
}
const fullSlots=TASKS.filter(task=>/^chromatic-pos-[3-9]$/.test(task.taskId)).flatMap(task=>task.slots.map(slot=>({...slot})));
TASKS.push({taskId:'chromatic-full-224',label:'크로매틱 3~12프렛 전체 · 224음',plannedNoteCount:224,firstMidi:fullSlots[0].midi,firstNoteName:fullSlots[0].noteName,slots:fullSlots,instruction:'포지션 3부터 9까지 이어서 연주합니다. 새 음을 칠 때 앞 음이 자연스럽게 뮤트되어도 됩니다. 줄을 넘을 때 앞 줄이 울리지 않게 가볍게 막아 주세요.'});
// Teacher aliases share the existing note plans; only the task identity and guidance differ.
const teacherTasks=[
 ['teacher-1-normal','a-open-32','선생님 1 · A현 개방현 · 평소대로','평소 치시는 대로'],
 ['teacher-2-ahead','a-open-32','선생님 2 · A현 개방현 · 일부러 클릭보다 앞서게','클릭보다 조금 앞서서'],
 ['teacher-3-behind','a-open-32','선생님 3 · A현 개방현 · 일부러 클릭보다 늦게','클릭보다 조금 늦게'],
 ['teacher-4-chromatic','d-chromatic-32','선생님 4 · D현 1–4프렛 크로매틱 · 평소대로','평소 치시는 대로'],
 ['teacher-5-accent','a-open-32','선생님 5 · A현 개방현 · 네 음마다 첫 음만 세게','1 · 5 · 9 · 13 … 번째 음만 세게, 나머지는 보통으로'],
 ['teacher-6-full','chromatic-full-224','선생님 6 · 크로매틱 3~12프렛 전체 224음 · 평소대로','평소 치시는 대로'],
];
for(const [taskId,sourceTaskId,label,instruction]of teacherTasks){
 const base=TASKS.find(task=>task.taskId===sourceTaskId);
 TASKS.push({...base,taskId,label,instruction,group:'teacher',sourceTaskId,defaultBpm:60,defaultClickMode:'sixteenth',slots:base.slots.map(slot=>({...slot}))});
}
module.exports={TASKS};
