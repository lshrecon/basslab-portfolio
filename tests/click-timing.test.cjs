'use strict';
// Pure click/result logic only: no detector, HTTP server, device or recording.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(process.env.BASSLAB_LOGIC_ROOT||path.join(__dirname,'..'));
const model=require(path.join(root,'click/model.cjs'));
const config={...model.CONFIG,kFrames:0};
const run={bpm:60,plannedNoteCount:2,clickMode:'sixteenth',format:{sampleRate:44100},pcm:{sampleRate:44100,firstFrame:0,frameCount:88200},schedule:[44100,55125].map((frame,index)=>({index,actualRenderFrame:frame,pcmLocalFrame:frame,submitted:true,submittedWaveformBytes:13230,kind:'practice'}))};
const unmeasured={id:1,rhoTime:1.06,selectedState:{state:'unmeasured',reason:'both-estimators-unavailable'}};
const measured={id:2,rhoTime:1.23,r2:{pulseOnsetTime:1.23},knee:{time:1.23276,periodSeconds:.02},selectedState:{state:'agree'}};
const anchor=candidates=>model.buildClickAnchor({run,candidates,config});
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-8,`${actual} != ${expected}`);
const ui=vm.createContext({});
for(const file of ['10-ObservationModel.jsx','11-ClickModel.jsx','12-PortableModel.jsx','14-PlaybackPosition.jsx'])vm.runInContext(fs.readFileSync(path.join(root,'app/src',file),'utf8'),ui,{filename:file});

test('rho-only candidate keeps its listening locator without claiming an onset',()=>{
 const value=model.extractTime(unmeasured,config);
 assert.equal(value.timeSeconds,null);assert.equal(value.deltaMs,undefined);
 assert.equal(value.timeSource,null);assert.equal(value.measuredTimingCandidate,false);
 assert.equal(value.timingUnavailable,true);assert.equal(value.timingUnavailableReason,'no-measured-onset');
 assert.equal(value.playbackTimeSeconds,1.06);assert.equal(value.pairingTimeSeconds,1.06);
});

test('a locator can own a slot but cannot change measured timing aggregates',()=>{
 const value=anchor([unmeasured,measured]);
 assert.equal(value.available,true);assert.equal(value.counts.matched,2);
 assert.equal(value.slots[0].candidateId,1);assert.equal(value.slots[0].deltaMs,null);
 assert.equal(value.summary.measuredTimingCount,1);assert.equal(value.summary.timingUnavailableCount,1);
 assert.equal(value.summary.within40Count,1);near(value.summary.meanMs,-20);near(value.summary.populationSdMs,0);
});

test('an all-unmeasured take has no numerical timing verdict',()=>{
 const value=anchor([unmeasured,{...unmeasured,id:2,rhoTime:1.25}]);
 assert.equal(value.counts.matched,2);assert.equal(value.summary.measuredTimingCount,0);
 assert.equal(value.summary.meanMs,null);assert.equal(value.summary.populationSdMs,null);
 assert.equal(value.summary.minimumMs,null);assert.equal(value.summary.within40Count,0);
});

test('measured r2-only, knee-only and agreed candidates retain their times',()=>{
 for(const candidate of [measured,{id:3,r2:{pulseOnsetTime:1.1}},{id:4,knee:{time:1.2}}]){
  const value=model.extractTime(candidate,config);
  assert.equal(value.timingUnavailable,false);assert.equal(value.measuredTimingCandidate,true);
  assert.equal(value.timeSeconds,candidate.r2?.pulseOnsetTime??candidate.knee.time);
 }
});

test('one-period disagreement remains withheld and retains a listening locator',()=>{
 const value=model.extractTime({r2:{pulseOnsetTime:1.04},knee:{time:1.00276,periodSeconds:.02},selectedState:{state:'hold',reason:'estimator-disagreement'}},config);
 assert.equal(value.timingUnavailable,true);assert.equal(value.timeSeconds,null);
 assert.equal(value.timingUnavailableReason,'estimator-disagreement-one-period');
 assert.equal(value.playbackTimeSeconds,1.00276);
});

test('missing and out-of-recording locators remain invalid rather than occupying slots',()=>{
 const value=anchor([{id:1,selectedState:{state:'unmeasured'}},{id:2,rhoTime:-1},{id:3,rhoTime:2}]);
 assert.equal(value.counts.invalid,3);assert.equal(value.counts.matched,0);
 assert.equal(value.summary.measuredTimingCount,0);
});

test('a measured candidate still wins a collision against a closer unmeasured locator',()=>{
 const value=anchor([{...unmeasured,rhoTime:1},{...measured,r2:{pulseOnsetTime:1.04},knee:{time:1.04276}}]);
 assert.equal(value.slots[0].candidateId,2);assert.equal(value.extras[0].candidateId,1);
});

test('rho-only audio remains listenable without becoming an onset tick on the playback timeline',()=>{
 const result={durationSeconds:2,notes:[{index:1,timeSeconds:1.06,listeningLocatorOnly:true,status:'unmeasured'}],clickAnchor:anchor([unmeasured])};
 const timeline=ui.v16PlaybackTimeline(result),range=ui.v2PlaybackRange(result,result.notes[0]);
 assert.equal(timeline.candidates.length,0);assert.equal(timeline.unknownCandidates,1);
 assert.ok(range.startSeconds<=1.06&&range.endSeconds>1.06);
});

test('default and accepted calibration validity remain distinct',()=>{
 const defaultAnchor=model.buildClickAnchor({run,candidates:[]});
 assert.equal(ui.v21ResultCalibrationValid({clickAnchor:defaultAnchor}),false);
 const acceptedRun={...run,clickCalibration:{validatedForThisEngine:true,kFrames:8778,measurementId:'fixture-measurement',deviceKey:'fixture-device'}};
 const acceptedAnchor=model.buildClickAnchor({run:acceptedRun,candidates:[]});
 assert.equal(acceptedAnchor.calibration.kFrames,8778);
 assert.equal(ui.v21ResultCalibrationValid({clickAnchor:acceptedAnchor}),true);
});

test('withheld labels describe the actual reason, not an invented estimator disagreement',()=>{
 const value=anchor([unmeasured]).slots[0];
 assert.equal(value.timingUnavailableText,'음 시작을 측정하지 못함 · 주변 듣기 위치만 있음');
 if(typeof ui.v26TimingUnavailableWords==='function')assert.equal(ui.v26TimingUnavailableWords(value),value.timingUnavailableText);
});
