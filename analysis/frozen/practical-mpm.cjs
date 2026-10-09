'use strict';

// Original implementation of McLeod & Wyvill's published NSDF equations (2005).
// No Tartini or third-party implementation code is incorporated.
const version = 'mpm-period-correlation-20260927-v4';
const settings = Object.freeze({
  analysisRate: 6000, frameSeconds: 0.072, hopSeconds: 0.006,
  minimumHz: 36, maximumHz: 350, mpmPeakFraction: 0.9,
  clarityFloor: 0.76, energyFloorFraction: 0.02,
  stableSeconds: 0.06, bridgeSeconds: 0.072,
  reattackSeconds: 0.09, reattackRatio: 1.24,
  reattackProminence: 0.11, onsetRefineSeconds: 0.06,
  harmonicWindowSeconds: .040, harmonicHopSeconds: .005,
  harmonicFirst: 2, harmonicLast: 12, harmonicPriorMinSeconds: .010,
  harmonicPriorMaxSeconds: .040, harmonicRiseCapDb: 20,
  harmonicMinimumFlux: 15, harmonicValleyMultiplier: 3,
  harmonicSupportSeconds: .078, harmonicRiseFraction: .2,
  correlationHopSeconds: .003, correlationLowHz: 250, correlationHighHz: 1200,
  correlationMaximum: .70, correlationMinimumWindowSeconds: .04,
  correlationMergeSeconds: .07, correlationEarlyStrong: .5,
  toneDelaySeconds: .02, toneWindowSeconds: .15, toneMinimumFrames: 4, toneClarity: .7,
  muteMaximumDb: 6, noiseMarginDb: 15,
  segmentLeadSeconds: .03, segmentTailSeconds: .01, minimumVoicedFrames: 3, pitchJumpSemitones: 1.5,
  candidateMode: "rho-tracker"
});
function median(a) { if (!a.length) return 0; const b = a.slice().sort((x,y)=>x-y); return b[Math.floor(b.length/2)]; }
function percentile(a,p) { if (!a.length) return 0; const b=a.slice().sort((x,y)=>x-y); return b[Math.min(b.length-1,Math.floor(p*b.length))]; }
function clamp(v,a,b) { return Math.max(a,Math.min(b,v)); }
function hzToMidi(hz) { return 69+12*Math.log2(hz/440); }

function biquad(samples, rate, cutoff, highpass) {
  const omega = 2*Math.PI*cutoff/rate, co=Math.cos(omega), alpha=Math.sin(omega)/Math.SQRT2;
  const a0=1+alpha, a1=-2*co/a0, a2=(1-alpha)/a0;
  const b0=(highpass?(1+co):(1-co))/2/a0, b1=(highpass?-(1+co):(1-co))/a0, b2=b0;
  const out=new Float32Array(samples.length); let x1=0,x2=0,y1=0,y2=0;
  for(let i=0;i<samples.length;i++) { const x=Number.isFinite(samples[i])?samples[i]:0; const y=b0*x+b1*x1+b2*x2-a1*y1-a2*y2; out[i]=y; x2=x1;x1=x;y2=y1;y1=y; }
  return out;
}
function prepare(samples, rate, target) {
  // Filtering before resampling prevents high harmonics aliasing into bass pitches.
  const low=biquad(biquad(samples,rate,Math.min(1500,rate*.22),false),rate,Math.min(1500,rate*.22),false);
  const n=Math.floor(samples.length*target/rate), out=new Float32Array(n);
  for(let i=0;i<n;i++) { const x=i*rate/target, k=Math.floor(x), f=x-k; out[i]=(low[k]||0)*(1-f)+(low[k+1]||0)*f; }
  return biquad(out,target,18,true);
}
function fft(re,im,inverse) {
  const n=re.length;
  for(let i=1,j=0;i<n;i++) { let bit=n>>1; for(;j&bit;bit>>=1)j^=bit; j^=bit; if(i<j) { let v=re[i];re[i]=re[j];re[j]=v;v=im[i];im[i]=im[j];im[j]=v; } }
  for(let len=2;len<=n;len<<=1) {
    const angle=(inverse?2:-2)*Math.PI/len, wr0=Math.cos(angle),wi0=Math.sin(angle);
    for(let i=0;i<n;i+=len) { let wr=1,wi=0;
      for(let j=0;j<len/2;j++) { const a=i+j,b=a+len/2, vr=re[b]*wr-im[b]*wi,vi=re[b]*wi+im[b]*wr;
        re[b]=re[a]-vr;im[b]=im[a]-vi;re[a]+=vr;im[a]+=vi;
        const old=wr;wr=old*wr0-wi*wi0;wi=old*wi0+wi*wr0;
      }
    }
  }
  if(inverse)for(let i=0;i<n;i++){re[i]/=n;im[i]/=n;}
}
function nsdfPitch(x, start, size, rate, cfg, memory) {
  const {re,im,sums,nsdf}=memory;re.fill(0);im.fill(0);
  let mean=0; for(let i=0;i<size;i++) mean+=x[start+i]||0; mean/=size;
  sums[0]=0;
  for(let i=0;i<size;i++) { const v=(x[start+i]||0)-mean;re[i]=v;sums[i+1]=sums[i]+v*v; }
  const rms=Math.sqrt(sums[size]/size);
  if(rms<1e-9)return {rms,midi:null,clarity:0,candidates:[]};
  fft(re,im,false); for(let i=0;i<re.length;i++){re[i]=re[i]*re[i]+im[i]*im[i];im[i]=0;} fft(re,im,true);
  const minLag=Math.floor(rate/cfg.maximumHz),maxLag=Math.min(size-3,Math.ceil(rate/cfg.minimumHz));
  for(let lag=0;lag<=maxLag+1;lag++){const denom=sums[size-lag]+sums[size]-sums[lag];nsdf[lag]=denom>0?2*re[lag]/denom:0;}
  const peaks=[]; let passedZero=false, best=-1;
  function pushPeak() {
    if(best>=minLag && best<maxLag) {
      const a=nsdf[best-1],b=nsdf[best],c=nsdf[best+1],den=a-2*b+c;
      const shift=den?clamp(.5*(a-c)/den,-.5,.5):0,lag=best+shift;
      const hz=rate/lag, clarity=clamp(b-.25*(a-c)*shift,0,1);
      if(hz>=cfg.minimumHz&&hz<=cfg.maximumHz)peaks.push({midi:hzToMidi(hz),clarity,lag});
    }
    best=-1;
  }
  for(let lag=1;lag<=maxLag;lag++) {
    if(nsdf[lag]<=0){passedZero=true;if(best>=0)pushPeak();}
    else if(passedZero && nsdf[lag]>=nsdf[lag-1]&&nsdf[lag]>=nsdf[lag+1]&&(best<0||nsdf[lag]>nsdf[best])) best=lag;
  }
  if(best>=0)pushPeak();
  const max=peaks.reduce((v,p)=>Math.max(v,p.clarity),0), selected=peaks.find(p=>p.clarity>=max*cfg.mpmPeakFraction);
  return {rms,midi:selected?selected.midi:null,clarity:selected?selected.clarity:0,candidates:peaks};
}
// Free analysis passes only PCM and a signal-derived pitch-run label. The
// separately exported helper also supports explicitly task-guided analysis.
// No score, grid, annotation, task name or expected note enters free analyze().
function harmonicFlux(mono, sampleRate, label, startSeconds, endSeconds, cfg=settings) {
  const size=Math.max(4,Math.round(sampleRate*cfg.harmonicWindowSeconds)),hop=Math.max(1,Math.round(sampleRate*cfg.harmonicHopSeconds));
  const half=Math.floor(size/2), first=Math.max(0,Math.floor((startSeconds-cfg.harmonicPriorMaxSeconds)*sampleRate/hop));
  const last=Math.min(Math.floor((mono.length-1)/hop),Math.ceil(endSeconds*sampleRate/hop));
  const win=Float64Array.from({length:size},(_,i)=>.5-.5*Math.cos(2*Math.PI*i/size));
  const f0=440*Math.pow(2,(label-69)/12), harmonics=[];
  for(let k=cfg.harmonicFirst;k<=cfg.harmonicLast;k++)if(k*f0<sampleRate/2)harmonics.push({k,coef:2*Math.cos(2*Math.PI*k*f0/sampleRate)});
  const amplitudes=[];
  for(let frame=first;frame<=last;frame++) {
    const offset=frame*hop-half,a=[];
    for(const {coef} of harmonics) {
      let s1=0,s2=0;
      for(let i=0;i<size;i++){const value=mono[offset+i],v=Number.isFinite(value)?value:0,s=v*win[i]+coef*s1-s2;s2=s1;s1=s;}
      a.push(10*Math.log10(Math.max(0,s1*s1+s2*s2-coef*s1*s2)/size+1e-14));
    }
    amplitudes.push(a);
  }
  const minPrior=Math.max(1,Math.ceil(cfg.harmonicPriorMinSeconds*sampleRate/hop)),maxPrior=Math.max(minPrior,Math.round(cfg.harmonicPriorMaxSeconds*sampleRate/hop));
  const trace=[];
  for(let i=maxPrior;i<amplitudes.length;i++){
    let value=0;
    for(let k=0;k<harmonics.length;k++){
      let prior=-Infinity;for(let j=minPrior;j<=maxPrior;j++)prior=Math.max(prior,amplitudes[i-j][k]);
      value+=Math.min(cfg.harmonicRiseCapDb,Math.max(0,amplitudes[i][k]-prior));
    }
    trace.push({time:(first+i)*hop/sampleRate,value});
  }
  const valleys=[];
  for(let i=1;i<trace.length-1;i++)if(trace[i].time>=startSeconds&&trace[i].value<=trace[i-1].value&&trace[i].value<trace[i+1].value)valleys.push(trace[i].value);
  const valleyMedian=median(valleys),threshold=Math.max(cfg.harmonicMinimumFlux,valleyMedian*cfg.harmonicValleyMultiplier);
  const candidates=[];
  for(let i=1;i<trace.length-1;i++){
    const q=trace[i];if(q.time<startSeconds||q.value<threshold)continue;
    // A 15 ms neighbourhood suppresses ripples within one spectral attack.
    let maximum=true;for(let j=Math.max(0,i-3);j<=Math.min(trace.length-1,i+3);j++)if(trace[j].value>q.value||(j<i&&trace[j].value===q.value))maximum=false;
    if(!maximum)continue;
    let rise=i;const floor=Math.max(threshold*.25,q.value*cfg.harmonicRiseFraction);
    while(rise>0&&q.time-trace[rise-1].time<=cfg.harmonicWindowSeconds&&trace[rise-1].value>=floor&&trace[rise-1].value<=trace[rise].value)rise--;
    candidates.push({time:trace[rise].time,peakTime:q.time,strength:q.value});
  }
  return {trace,candidates,threshold,valleyMedian,harmonics:harmonics.map(h=>h.k)};
}
function pitchForSegment(frames,startSeconds,endSeconds,cfg=settings) {
  const supported=frames.filter(f=>f.voiced&&Number.isFinite(f.midi)&&f.time>=startSeconds+cfg.segmentLeadSeconds&&f.time<endSeconds-cfg.segmentTailSeconds);
  const values=supported.map(f=>f.midi),medianMidi=values.length?median(values):null;
  const pitchRangeSemitones=values.length?Math.max(...values)-Math.min(...values):null;
  const glide=pitchRangeSemitones!==null&&pitchRangeSemitones>cfg.pitchJumpSemitones;
  const uncertain=supported.length<cfg.minimumVoicedFrames;
  return {midi:medianMidi===null?null:Math.round(medianMidi),medianMidi,
    confidence:supported.length?clamp(median(supported.map(f=>f.clarity)),0,1):0,
    uncertain,glide,pitchRangeSemitones,voicedFrameCount:supported.length,
    reasons:[...(uncertain?['limited-pitch-support']:[]),...(glide?['unstable-pitch-glide']:[])]};
}
function trackerCandidates(mono,sampleRate,options={}) {
  if(!(mono instanceof Float32Array)&&!ArrayBuffer.isView(mono)&&!Array.isArray(mono))throw new TypeError('mono must contain PCM samples');
  if(!Number.isFinite(sampleRate)||sampleRate<1000)throw new TypeError('sampleRate must be >= 1000 Hz');
  const cfg={...settings,...(options.settings||{})};
  const rate=Math.min(sampleRate,cfg.analysisRate),x=prepare(mono,sampleRate,rate),size=Math.round(cfg.frameSeconds*rate),hop=Math.round(cfg.hopSeconds*rate),dt=hop/rate;
  let fftSize=1;while(fftSize<size+Math.ceil(rate/cfg.minimumHz)+2)fftSize<<=1;
  const memory={re:new Float64Array(fftSize),im:new Float64Array(fftSize),sums:new Float64Array(size+1),nsdf:new Float64Array(size+2)};
  const frames=[];
  // Centred pitch windows and independently centred cycle-length energy windows.
  const power=new Float64Array(x.length+1);for(let i=0;i<x.length;i++)power[i+1]=power[i]+x[i]*x[i];
  const halfEnergy=Math.round(rate*.014);
  for(let center=0;center<x.length;center+=hop) {
    const f=nsdfPitch(x,center-Math.floor(size/2),size,rate,cfg,memory);
    const lo=Math.max(0,center-halfEnergy),hi=Math.min(x.length,center+halfEnergy);
    f.energy=Math.sqrt(Math.max(0,power[hi]-power[lo])/Math.max(1,hi-lo));f.time=center/rate;frames.push(f);
  }
  const robustPeak=percentile(frames.map(f=>f.energy),.95),noise=percentile(frames.map(f=>f.energy),.02);
  const gate=Math.max(1e-7,robustPeak*cfg.energyFloorFraction,Math.min(noise*3,robustPeak*.08));
  for(const f of frames) {
    f.voiced=f.energy>=gate&&f.clarity>=cfg.clarityFloor&&f.midi!==null;
  }
  // A small majority filter removes transition-window one-frame pitch guesses.
  for(let i=0;i<frames.length;i++) {
    const pool=[];for(let j=Math.max(0,i-2);j<=Math.min(frames.length-1,i+2);j++)if(frames[j].voiced)pool.push(frames[j].midi);
    frames[i].label=pool.length>=3&&frames[i].energy>=gate?Math.round(median(pool)):null;
  }
  // The bounded fallback uses tracking only for local period and segment labels.
  // Label crossings, energy rises and harmonic flux do not generate candidates.
  // Continuous voiced glides therefore remain one segment unless the waveform
  // itself supplies a qualifying reset. This also avoids unused flux computation.
  if(cfg.candidateMode==='rho-tracker')return {frames,candidates:[],settings:cfg,
    diagnostics:{frameCount:frames.length,energyGate:gate,robustPeak,pitchRuns:null,harmonicRuns:[],rejected:[],candidateMode:cfg.candidateMode}};
  function runsFromLabels(){const runs=[];for(let i=0;i<frames.length;){const start=i,label=frames[i].label;while(i<frames.length&&frames[i].label===label)i++;runs.push({start,end:i,label});}return runs;}
  // In a mixed attack window the longer period may dominate briefly. Extend a
  // clearly supported following octave only through a short, weaker prefix;
  // long genuine octave changes remain separate.
  const octaveRuns=runsFromLabels().filter(r=>r.label!==null);
  for(let i=0;i<octaveRuns.length-1;i++) {
    const a=octaveRuns[i],b=octaveRuns[i+1];
    if((a.end-a.start)*dt>.102||(b.start-a.end)*dt>.018||(b.end-b.start)*dt<.03||b.label-a.label!==12)continue;
    const ca=median(frames.slice(a.start,a.end).map(f=>f.clarity)),cb=median(frames.slice(b.start,b.end).map(f=>f.clarity));
    if(ca<.87&&cb>.87&&cb>ca+.03)for(let j=a.start;j<b.start;j++)frames[j].label=b.label;
  }
  // Bridge short incoherent attack gaps before pruning short voiced islands.
  // Short islands must be flanked by the same pitch on both sides: a short
  // initial pitch-change guess must not move the following onset backwards.
  // Otherwise a supported weak attack can be erased first, making the combined
  // null region longer than the unchanged 72 ms bridge limit.
  const initialRuns=runsFromLabels(),initialBridge=Math.ceil(cfg.bridgeSeconds/dt),minimumIsland=Math.max(3,Math.ceil(cfg.stableSeconds/dt));
  for(let i=1;i<initialRuns.length-1;i++) {
    const r=initialRuns[i],a=initialRuns[i-1],b=initialRuns[i+1];
    if(r.label===null&&a.label!==null&&a.label===b.label&&r.end-r.start<=initialBridge
      &&(a.end-a.start>=minimumIsland||initialRuns[i-3]?.label===a.label)
      &&(b.end-b.start>=minimumIsland||initialRuns[i+3]?.label===b.label))
      for(let j=r.start;j<r.end;j++)frames[j].label=a.label;
  }
  const stableFrames=Math.max(3,Math.ceil(cfg.stableSeconds/dt));
  for(const r of runsFromLabels())if(r.label!==null&&r.end-r.start<stableFrames)for(let i=r.start;i<r.end;i++)frames[i].label=null;
  const runs0=runsFromLabels(),bridge=Math.ceil(cfg.bridgeSeconds/dt);
  for(let i=1;i<runs0.length-1;i++) {const r=runs0[i],a=runs0[i-1],b=runs0[i+1];if(r.label===null&&r.end-r.start<=bridge&&a.label===b.label)for(let j=r.start;j<r.end;j++)frames[j].label=a.label;}
  const pitchRuns=runsFromLabels().filter(r=>r.label!==null&&r.end-r.start>=stableFrames);
  const onsets=[],rejected=[],harmonicRuns=[];
  const maxEnergy=(a,b)=>{let v=0;for(let i=Math.max(0,a);i<Math.min(frames.length,b);i++)v=Math.max(v,frames[i].energy);return v;};
  const avgEnergy=(a,b)=>{let sum=0,n=0;for(let i=Math.max(0,a);i<Math.min(frames.length,b);i++){sum+=frames[i].energy;n++;}return n?sum/n:0;};
  const localRise=(i)=>{const span=Math.max(2,Math.round(.03/dt));const before=avgEnergy(i-span,i),after=avgEnergy(i,i+span);return {before,after,ratio:after/Math.max(before,gate),delta:after-before};};
  for(const r of pitchRuns) {
    const peak=maxEnergy(r.start,r.end),clarity=median(frames.slice(r.start,r.end).map(f=>f.clarity));
    const preceding=maxEnergy(r.start-Math.round(.5/dt),r.start);
    if(peak<gate*2||clarity<cfg.clarityFloor+.025||(preceding>0&&peak<preceding*.09)) {rejected.push({...r,reason:'weak-or-incoherent-pitch-region',peak,clarity});continue;}
    const previousRun=onsets.length?onsets[onsets.length-1]:null;
    const gap=previousRun?(r.start-previousRun.runEnd)*dt:Infinity;
    // A low-level different pitch after a muted note is residual resonance.
    if(previousRun&&gap<.18&&peak<previousRun.peak*.20) {rejected.push({...r,reason:'weak-resonance-after-note',peak,clarity});continue;}
    let start=r.start;
    const search=Math.round(cfg.onsetRefineSeconds/dt);
    let best=-Infinity,bestIndex=start;
    for(let i=Math.max(1,start-search);i<=Math.min(frames.length-2,start+Math.round(.025/dt));i++) {
      const q=localRise(i),score=q.delta;
      if(score>best){best=score;bestIndex=i;}
    }
    if(best>peak*.10)start=bestIndex;
    else start=Math.max(0,start-Math.round(.010/dt));
    // A mute can change the surviving resonance's pitch while all of its
    // energy falls. Low-confidence short tails require a positive attack.
    if((r.end-r.start)*dt<.12&&clarity<.90&&best<peak*.10) {rejected.push({...r,reason:'falling-energy-short-resonance',peak,clarity});continue;}
    const first={index:start,label:r.label,runStart:r.start,runEnd:r.end,peak,clarity,reasons:['stable-pitch-region']};
    const candidates=[first];
    const refractory=Math.ceil(cfg.reattackSeconds/dt),span=Math.round(.03/dt);
    for(let i=r.start+refractory;i<r.end-stableFrames;i++) {
      const q=localRise(i);
      const precedingPeak=maxEnergy(i-Math.round(.25/dt),i);
      if(q.ratio<cfg.reattackRatio||q.delta<Math.max(peak*cfg.reattackProminence,gate*2)||q.after<precedingPeak*.38)continue;
      if(q.delta<localRise(i-1).delta||q.delta<localRise(i+1).delta)continue;
      candidates.push({index:i,label:r.label,runStart:r.start,runEnd:r.end,peak,clarity,reasons:['same-pitch-positive-energy-reattack'],strength:q.delta});
    }
    const harmonic=harmonicFlux(mono,sampleRate,r.label,r.start*dt,r.end*dt,cfg);
    const accepted=[];
    for(const c of harmonic.candidates) {
      // Candidate admission is shared with every other source below.
      const index=c.time/dt;
      if(index<r.start)continue;
      const event={index,label:r.label,runStart:r.start,runEnd:r.end,peak,clarity,reasons:['same-pitch-harmonic-flux-reattack'],strength:c.strength,peakSeconds:c.peakTime};
      candidates.push(event);accepted.push({startSeconds:c.time,peakSeconds:c.peakTime,strength:c.strength});
    }
    harmonicRuns.push({label:r.label,startSeconds:r.start*dt,endSeconds:r.end*dt,threshold:harmonic.threshold,valleyMedian:harmonic.valleyMedian,candidates:accepted});
    onsets.push(...candidates);
  }
  onsets.sort((a,b)=>a.index-b.index);
  return {frames,candidates:onsets.map(o=>({time:o.index*dt,peakTime:o.peakSeconds??o.index*dt,
    pitchHint:o.label,fluxStrength:o.reasons.includes('same-pitch-harmonic-flux-reattack')?(o.strength??0):0,
    reasons:o.reasons.slice()})),diagnostics:{frameCount:frames.length,pitchRuns:pitchRuns.length,energyGate:gate,robustPeak,rejected,harmonicRuns},settings:cfg};
}
function onePeriodCorrelation(x,a,b,size) {
  let cross=0,aa=0,bb=0;
  for(let i=0;i<size;i++){const u=x[a+i],v=x[b+i];cross+=u*v;aa+=u*u;bb+=v*v;}
  return aa>0&&bb>0?clamp(cross/Math.sqrt(aa*bb),-1,1):0;
}
function periodCorrelation(mono,sampleRate,frames,cfg=settings) {
  const low=Math.min(cfg.correlationHighHz,sampleRate*.45),high=Math.min(cfg.correlationLowHz,low*.8);
  let x=biquad(biquad(mono,sampleRate,low,false),sampleRate,low,false);
  x=biquad(biquad(x,sampleRate,high,true),sampleRate,high,true);
  const dt=frames.length>1?frames[1].time-frames[0].time:cfg.hopSeconds,hop=Math.max(1,Math.round(sampleRate*cfg.correlationHopSeconds));
  const indexAt=t=>Math.round(t/dt);
  function pitchAt(time) {
    const i=indexAt(time),ahead=frames.slice(i+3,Math.min(frames.length,i+14)).filter(f=>f.voiced&&Number.isFinite(f.midi));
    if(ahead.length>=3)return median(ahead.map(f=>f.midi));
    const before=frames.slice(Math.max(0,i-12),Math.max(0,i)).filter(f=>f.voiced&&Number.isFinite(f.midi));
    return before.length>=3?median(before.map(f=>f.midi)):null;
  }
  const trace=[];
  for(let i=0;i<Math.floor(x.length/hop);i++){
    const center=i*hop,time=center/sampleRate,midi=pitchAt(time);let rho=1,periodFrames=null;
    if(midi!==null){periodFrames=Math.round(sampleRate/(440*Math.pow(2,(midi-69)/12)));const a=center-periodFrames,b=center,half=Math.round(periodFrames/2);
      if(a-half>=0&&b+periodFrames<x.length)rho=Math.min(onePeriodCorrelation(x,a,b,periodFrames),onePeriodCorrelation(x,a-half,b-half,periodFrames));}
    trace.push({time,rho,midi,periodFrames});
  }
  const radius=Math.floor(cfg.correlationMinimumWindowSeconds*sampleRate/hop),candidates=[];
  for(let i=radius;i<trace.length-radius;i++){
    const q=trace[i];if(q.rho>cfg.correlationMaximum)continue;
    let minimum=true;for(let j=i-radius;j<=i+radius;j++)if(trace[j].rho<q.rho||(j<i&&trace[j].rho===q.rho)){minimum=false;break;}
    if(minimum)candidates.push({time:q.time,peakTime:q.time,rho:q.rho,pitchHint:q.midi,fluxStrength:0,reasons:['one-period-waveform-reset']});
  }
  return {trace,candidates,hopSeconds:hop/sampleRate,pitchAt};
}
function candidateGate(candidate,frames,cfg=settings,floorDb) {
  const dt=frames.length>1?frames[1].time-frames[0].time:cfg.hopSeconds,indexAt=t=>Math.round(t/dt);
  const energies=frames.map(f=>20*Math.log10(f.energy+1e-9));
  if(floorDb===undefined)floorDb=percentile(energies,.02);
  const meanDb=(a,b)=>{const lo=clamp(indexAt(a),0,frames.length),hi=clamp(indexAt(b),0,frames.length);const v=hi>lo?energies.slice(lo,hi):[];return v.length?v.reduce((s,x)=>s+x,0)/v.length:-99;};
  const time=candidate.time,beforeDb=meanDb(time-.08,time-.02),afterDb=meanDb(time+.02,time+.08);
  const toneFrames=frames.slice(Math.max(0,indexAt(time+cfg.toneDelaySeconds)),Math.min(frames.length,indexAt(time+cfg.toneWindowSeconds))).filter(f=>f.voiced&&f.clarity>=cfg.toneClarity).length;
  const gates={toneAfter:toneFrames>=cfg.toneMinimumFrames,notMute:afterDb>=beforeDb-cfg.muteMaximumDb,aboveFloor:afterDb>=floorDb+cfg.noiseMarginDb};
  return {accepted:Object.values(gates).every(Boolean),gates,toneFrames,beforeDb,afterDb,deltaDb:afterDb-beforeDb,floorDb,marginDb:afterDb-floorDb};
}
function mergeOnsetCandidates(candidates,cfg=settings) {
  const output=[];
  for(const c of candidates.slice().sort((a,b)=>a.time-b.time)){
    const previous=output.at(-1);
    if(previous&&c.time-previous.time<cfg.correlationMergeSeconds){
      const allReasons=Array.from(new Set(previous.reasons.concat(c.reasons)));
      if(!(previous.rho<=cfg.correlationEarlyStrong)&&c.rho<previous.rho)output[output.length-1]={...c,reasons:allReasons};
      else previous.reasons=allReasons;
    }else output.push({...c,reasons:c.reasons.slice()});
  }
  return output;
}
function analyze(mono,sampleRate,options={}) {
  const tracked=trackerCandidates(mono,sampleRate,options),cfg=tracked.settings,frames=tracked.frames;
  const correlation=periodCorrelation(mono,sampleRate,frames,cfg),rhoAt=t=>correlation.trace[Math.min(correlation.trace.length-1,Math.max(0,Math.round(t/correlation.hopSeconds)))]?.rho??1;
  const tracker=tracked.candidates.map(c=>({...c,rho:rhoAt(c.time)}));
  const candidates=cfg.candidateMode==='rho-tracker'?correlation.candidates:tracker.concat(correlation.candidates);
  const floorDb=percentile(frames.map(f=>20*Math.log10(f.energy+1e-9)),.02),accepted=[],rejected=[];
  for(const c of candidates){const evidence=candidateGate(c,frames,cfg,floorDb);const q={...c,gateEvidence:evidence};if(evidence.accepted)accepted.push(q);else rejected.push(q);}
  const merged=mergeOnsetCandidates(accepted,cfg),duration=mono.length/sampleRate,notes=[];
  for(let i=0;i<merged.length;i++){
    const o=merged[i],end=merged[i+1]?.time??duration,pitch=pitchForSegment(frames,o.time,end,cfg);
    notes.push({startSeconds:o.time,endSeconds:Math.max(o.time+1/sampleRate,end),...pitch,
      reasons:Array.from(new Set(o.reasons.concat(pitch.reasons))),onsetEvidence:{rho:o.rho,peakSeconds:o.peakTime,fluxStrength:o.fluxStrength,gateEvidence:o.gateEvidence}});
  }
  for(const f of frames)f.rho=rhoAt(f.time);
  return {notes,...(options.frames?{frames,rhoTrace:correlation.trace}:{}),version,settings:cfg,
    diagnostics:{...tracked.diagnostics,correlation:{hopSeconds:correlation.hopSeconds,candidateCount:correlation.candidates.length,floorDb},candidateCount:candidates.length,acceptedCandidates:accepted,rejectedCandidates:rejected}};
}
module.exports={analyze,version,settings,harmonicFlux,pitchForSegment,periodCorrelation,candidateGate,mergeOnsetCandidates,onePeriodCorrelation};
