const V13_FEEDBACK={"false-positive":"음이 없는데 있다고 나옴","missed-note":"음이 있는데 없다고 나옴","timing-mismatch":"앞뒤가 귀와 다름"};
const V21_UNCALIBRATED_WARNING="이 장치에서 지연을 재지 않았습니다. 그림의 클릭 선과 다시 듣기의 클릭도 같은 값으로 놓이므로 앞·뒤를 믿을 수 없습니다. 음 사이의 고르기와 클릭 없는 다시 듣기만 보세요";
const V21_INPUT_WARNING="입력 소리가 없습니다. 입력 채널(1/2), 게인, 케이블을 확인하세요";
const V21_TIMING_UNAVAILABLE="시작 시각을 정하지 못함 · 앞뒤 값 없음";
function v26TimingUnavailableWords(value){return value?.timingUnavailableText||V21_TIMING_UNAVAILABLE;}
function v21CurrentCalibrationValid(settings){return settings?.calibration?.accepted===true&&!!settings.deviceKey&&settings.calibration.deviceKey===settings.deviceKey;}
function v21ResultCalibrationValid(result){return result?.clickAnchor?.calibration?.validatedForThisEngine===true;}
function v21CalibrationDate(value){if(typeof value?.measuredAt!=="string"||!value.measuredAt.trim())return "잰 날짜 기록 없음";const date=new Date(value.measuredAt);return Number.isNaN(date.getTime())?"잰 날짜 기록 없음":"잰 날짜 · "+date.toLocaleString("ko-KR",{year:"numeric",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit",hour12:false,timeZone:"Asia/Seoul"});}
// Only the native first-note display's real level samples are used; this is not a new detector.
function v21FirstNoteInput(previous,state,taskId,nowMs){
  const started=state?.firstNoteStartedAtMs;
  if(state?.phase!=="FIRST_NOTE"||state.selectedTaskId!==taskId||!v2Finite(started)||!v2Finite(nowMs)||nowMs<started)return null;
  const current=previous?.startedAtMs===started&&previous.taskId===taskId?{...previous}:{startedAtMs:started,taskId,hasLevel:false,heardInput:false};
  const sample=state.firstNote,received=Date.parse(sample?.receivedAt);
  if(sample?.taskId===taskId&&v2Finite(received)&&received>=started&&received<=nowMs&&v2Finite(sample.levelDbfs)){current.hasLevel=true;if(sample.levelDbfs>=-55)current.heardInput=true;}
  current.noInput=nowMs-started>=5000&&current.hasLevel&&!current.heardInput;return current;
}
function v13Calibrating(state){return ["CALIBRATING","CALIBRATION_ANALYZING"].includes(state?.phase);}
function v13Busy(state){return v2Active(state)||v13Calibrating(state)||["FIRST_NOTE","ANALYZING"].includes(state?.phase);}
function v13DeviceReady(settings){return !!settings?.selection&&settings.selectionValid===true;}
function v13CalibrationWords(value){if(!value)return null;const accepted=value.accepted===true||(value.accepted===undefined&&value.stable===true);const k=value.kFrames??value.medianFrames,reference=value.defaultKFrames??8842;if(!accepted)return {accepted:false,title:"지연이 일정하지 않아 저장하지 않았습니다",detail:"케이블과 볼륨을 확인해 주세요. 이전에 저장된 값이나 기본값을 그대로 사용합니다."};if(!v2Finite(k))return {accepted:false,title:"측정 결과를 확인하지 못했습니다",detail:"기록을 내보내면 원인을 살펴볼 수 있습니다."};const diff=k-reference;return {accepted:true,title:"지연 값을 저장했습니다",detail:(k/44.1).toFixed(2)+" ms · 기본값보다 "+(diff===0?"차이 없음":(Math.abs(diff)/44.1).toFixed(2)+" ms "+(diff>0?"큼":"작음")),kFrames:k};}
function v13Error(error){const m=String(error||"");if(!m)return "";if(/^[가-힣]/.test(m))return m;if(/capture-unavailable/i.test(m))return "이번 실행에서는 더 녹음할 수 없습니다. 프로그램 종료 뒤 BassLab.exe 를 다시 실행해 주세요.";if(/diagnostic-export-too-large/i.test(m))return "내보낼 기록이 너무 큽니다. 함께 보낼 녹음 소리의 선택을 줄여 다시 시도해 주세요.";if(/unsupported.format|format.unsupported|44100|44\.1|88890008/i.test(m))return "인터페이스를 44.1 kHz · 24비트로 맞춰 주세요. 이 버전은 이 형식만 지원합니다.";if(/device.in.use|exclusive.*busy|8889000a|device.busy/i.test(m))return "다른 프로그램이 오디오 장치를 쓰고 있습니다. 그 프로그램을 닫고 다시 시도해 주세요.";if(/exclusive.mode.disabled/i.test(m))return "소리 설정 → 장치 속성 → 고급 → 응용 프로그램이 이 장치를 단독으로 제어할 수 있도록 허용을 켜 주세요.";if(/buffer.size.unsupported/i.test(m))return "이 장치가 현재 지원하는 버퍼와 맞지 않습니다. 이 버전은 441 표본 버퍼만 지원합니다.";if(/selection|device.not.found|device.unavailable|endpoint.not.found|missing.device/i.test(m))return "선택한 장치를 찾지 못했습니다. 장치 설정에서 입력과 출력을 다시 골라 주세요.";if(/input.channel|channel.unsupported/i.test(m))return "선택한 입력 채널을 사용할 수 없습니다. 입력 1 또는 2를 확인해 주세요.";if(/calibrat|latency|correlation/i.test(m))return "지연 측정을 마치지 못했습니다. 케이블과 입력 레벨을 확인해 주세요. 기존 값은 보존합니다.";return v12FriendlyError(m);}
function v13FeedbackKey(takeId,slotIndex){return takeId+":"+slotIndex;}
function v13SetSpeed(audio,speed){if(!audio||![1,.5,.25].includes(speed))return false;audio.playbackRate=speed;audio.preservesPitch=true;if("webkitPreservesPitch" in audio)audio.webkitPreservesPitch=true;return true;}
function v20SessionTerminal(state){const lifecycle=state?.shutdown?.lifecycle;return state?.sessionEnded===true||["ENDED","ENDING"].includes(state?.phase)||state?.childExit!=null||(state?.phase==="ERROR"&&state?.deviceReleased!==true)||lifecycle?.endRequested===true||lifecycle?.shutdownRequested===true||["waiting","closing","failed"].includes(state?.shutdown?.status);}
function v20SessionMessage(state){return state?.phase==="ENDING"||state?.deviceReleased!==true?"연습을 마치는 중이거나 장치 해제를 확인하지 못했습니다. 위의 ‘프로그램 종료’에서 완료를 확인한 뒤 BassLab.exe를 다시 실행해 주세요.":"이 연습 세션을 마쳤습니다. 녹음 결과는 계속 들을 수 있습니다. 다시 녹음하려면 위의 ‘프로그램 종료’에서 완료를 확인한 뒤 BassLab.exe를 다시 실행해 주세요.";}
function v20RetryConfig(result,tasks){
  const unavailable=reason=>({config:null,reason});
  if(!result||typeof result!=="object")return unavailable("다시 연습할 녹음을 선택해 주세요.");
  if(typeof result.taskId!=="string"||!Array.isArray(tasks)||!tasks.some(task=>task.taskId===result.taskId))return unavailable("이 녹음의 과제를 현재 연습 목록에서 확인할 수 없습니다. 연습 화면에서 과제를 직접 골라 주세요.");
  const hasTempo=result.tempo&&Object.hasOwn(result.tempo,"metronomeBpm"),hasBpm=Object.hasOwn(result,"bpm"),bpm=hasTempo?result.tempo.metronomeBpm:result.bpm;
  if(hasTempo&&hasBpm&&result.bpm!==bpm)return unavailable("이 녹음에 저장된 빠르기 값이 서로 다릅니다. 연습 화면에서 직접 골라 주세요.");
  if(!V2_BPMS.includes(bpm)||bpm>80)return unavailable("이 녹음의 빠르기를 확인할 수 없거나 현재 연습 범위를 벗어납니다. 연습 화면에서 직접 골라 주세요.");
  if(!Object.hasOwn(V2_ROUTES,result.monitorRoute))return unavailable("이 녹음의 모니터 경로가 저장되어 있지 않거나 지원되지 않습니다. 연습 화면에서 직접 골라 주세요.");
  if(!Object.hasOwn(V2_CLICK_MODES,result.clickMode))return unavailable("이 녹음의 클릭 설정을 확인할 수 없습니다. 연습 화면에서 직접 골라 주세요.");
  return {config:{taskId:result.taskId,bpm,monitorRoute:result.monitorRoute,clickMode:result.clickMode},reason:""};
}
function v20PracticeAgainAvailability(result,tasks,state,loading=false,locked=false){
  if(v20SessionTerminal(state))return {allowed:false,reason:v20SessionMessage(state)};
  if(loading||locked||!state||state.phase==="LOADING")return {allowed:false,reason:"현재 상태를 확인한 뒤 다시 연습할 수 있습니다."};
  if(v13Busy(state)||state.deviceReleased!==true)return {allowed:false,reason:"녹음·저장과 장치 해제가 끝나면 다시 연습할 수 있습니다."};
  const retry=v20RetryConfig(result,tasks);return {allowed:!!retry.config,reason:retry.reason};
}
