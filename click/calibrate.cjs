'use strict';
// Resource correlation only. Never imports or invokes the note/onset detectors.
const crypto=require('node:crypto');
const RATE=44100,DEFAULT_K=8842,SEARCH_FRAMES=22050,MIN_CORRELATION=0.8,TOLERANCE_FRAMES=2;
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function fft(re,im,inverse=false){
 const n=re.length;if(n!==im.length||(n&(n-1)))throw Error('fft-power-of-two-required');
 for(let i=1,j=0;i<n;i++){let bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j){[re[i],re[j]]=[re[j],re[i]];[im[i],im[j]]=[im[j],im[i]];}}
 for(let len=2;len<=n;len<<=1){const a=(inverse?2:-2)*Math.PI/len,wr=Math.cos(a),wi=Math.sin(a);for(let i=0;i<n;i+=len){let ur=1,ui=0;for(let j=0;j<len/2;j++){const p=i+j,q=p+len/2,tr=re[q]*ur-im[q]*ui,ti=re[q]*ui+im[q]*ur;re[q]=re[p]-tr;im[q]=im[p]-ti;re[p]+=tr;im[p]+=ti;const next=ur*wr-ui*wi;ui=ur*wi+ui*wr;ur=next;}}}
 if(inverse)for(let i=0;i<n;i++){re[i]/=n;im[i]/=n;}
}
function correlationPeak(samples,template,lo,hi){
 const m=template.length;if(m<2||!Number.isInteger(lo)||!Number.isInteger(hi)||lo<0||hi<lo||hi+m>samples.length)throw Error('correlation-search-bound');
 const mean=template.reduce((a,b)=>a+b,0)/m,t=Float64Array.from(template,v=>v-mean),energy=t.reduce((a,b)=>a+b*b,0);
 if(!(energy>1e-15))throw Error('silent-click-resource');
 const signalLength=hi-lo+m;let n=1;while(n<signalLength+m-1)n*=2;
 const ar=new Float64Array(n),ai=new Float64Array(n),br=new Float64Array(n),bi=new Float64Array(n);
 for(let i=0;i<signalLength;i++)ar[i]=samples[lo+i];for(let j=0;j<m;j++)br[j]=t[m-1-j];
 fft(ar,ai);fft(br,bi);for(let i=0;i<n;i++){const real=ar[i]*br[i]-ai[i]*bi[i];ai[i]=ar[i]*bi[i]+ai[i]*br[i];ar[i]=real;}fft(ar,ai,true);
 let sum=0,squares=0;for(let j=0;j<m;j++){const v=samples[lo+j];sum+=v;squares+=v*v;}
 let best=-Infinity,position=lo;
 for(let p=lo;p<=hi;p++){
  if(p>lo){const a=samples[p-1],b=samples[p+m-1];sum+=b-a;squares+=b*b-a*a;}
  const variance=Math.max(0,squares-sum*sum/m),rho=variance>1e-16?ar[p-lo+m-1]/Math.sqrt(variance*energy):-Infinity;
  if(rho>best){best=rho;position=p;}
 }
 // Recompute the selected normalized score directly, independent of FFT rounding.
 let dot=0,s=0,ss=0;for(let j=0;j<m;j++){const x=samples[position+j];dot+=x*t[j];s+=x;ss+=x*x;}
 const variance=Math.max(0,ss-s*s/m),rho=variance>1e-16?dot/Math.sqrt(variance*energy):null;
 return{position,correlation:rho,fftCorrelation:Number.isFinite(best)?best:null,searchFirst:lo,searchLast:hi,boundaryPeak:position===lo||position===hi};
}
function decideOffsets(rows){
 const result={accepted:false,kFrames:null,defaultKFrames:DEFAULT_K,defaultDifferenceFrames:null,defaultDifferenceMs:null,offsetsFrames:rows.map(r=>r.offsetFrames),rows,toleranceFrames:TOLERANCE_FRAMES,minCorrelation:MIN_CORRELATION};
 if(rows.length!==16)return{...result,reason:'sixteen-clicks-required'};
 if(rows.some(r=>!Number.isSafeInteger(r.offsetFrames)||r.offsetFrames<0||r.offsetFrames>SEARCH_FRAMES||!Number.isFinite(r.correlation)||r.correlation<MIN_CORRELATION||r.boundaryPeak))return{...result,reason:'click-correlation-unreliable'};
 const ordered=result.offsetsFrames.slice().sort((a,b)=>a-b),k=Math.round((ordered[7]+ordered[8])/2),maxDeviation=Math.max(...ordered.map(x=>Math.abs(x-k))),spread=ordered.at(-1)-ordered[0];
 Object.assign(result,{candidateKFrames:k,spreadFrames:spread,maxDeviationFrames:maxDeviation});
 if(maxDeviation>TOLERANCE_FRAMES)return{...result,reason:'click-offsets-not-stable'};
 return{...result,accepted:true,reason:null,kFrames:k,defaultDifferenceFrames:k-DEFAULT_K,defaultDifferenceMs:(k-DEFAULT_K)*1000/RATE};
}
function measureCalibration({pcm,run,resources}){
 const fail=reason=>({accepted:false,kFrames:null,reason,defaultKFrames:DEFAULT_K,rows:[]});
 if(!run||run.deviceReleased!==true||run.complete!==true||run.valid!==true||run.interrupted)return fail('complete-released-calibration-required');
 if(run.pcm?.sampleRate!==RATE||run.pcm?.channels!==1||run.format?.sampleRate!==RATE||run.pcm?.firstFrame!==0)return fail('unsupported-calibration-coordinates');
 let samples;if(Buffer.isBuffer(pcm)){if(pcm.length%4)return fail('pcm-alignment');samples=new Float64Array(pcm.length/4);for(let i=0;i<samples.length;i++)samples[i]=pcm.readFloatLE(i*4);}else if(pcm instanceof Float32Array||pcm instanceof Float64Array)samples=pcm;else return fail('pcm-required');
 if(samples.length!==run.pcm.frameCount||samples.some(v=>!Number.isFinite(v)))return fail('pcm-length-or-values-invalid');
 const schedule=run.schedule;if(!Array.isArray(schedule)||schedule.length!==16||schedule.some(c=>!Number.isSafeInteger(c.actualRenderFrame)||c.actualRenderFrame<0||c.submitted!==true||c.submittedWaveformBytes!==13230))return fail('sixteen-complete-click-submissions-required');
 const templates={};for(const name of ['accent','subdivision']){const bytes=resources?.[name],identity=run.sourceAndBuildIdentities?.[name+'Resource'];if(!Buffer.isBuffer(bytes)||bytes.length!==13230||!identity||bytes.length!==identity.bytes||sha(bytes)!==identity.sha256)return fail('calibration-resource-identity-mismatch');templates[name]=Float64Array.from({length:2205},(_,i)=>bytes.readIntLE(i*6,3)/8388608);}
 const rows=[];for(const c of schedule){const name=c.accent?'accent':'subdivision',lo=c.actualRenderFrame,hi=Math.min(lo+SEARCH_FRAMES,samples.length-2205);if(hi<lo)return fail('calibration-pcm-too-short');const p=correlationPeak(samples,templates[name],lo,hi);rows.push({scheduleIndex:c.index,resource:name,actualRenderFrame:c.actualRenderFrame,arrivalFrame:p.position,offsetFrames:p.position-c.actualRenderFrame,...p});}
 return{schema:'portable-click-calibration-v13',measuredAt:new Date().toISOString(),method:'integer-frame zero-mean normalized resource correlation; FFT then direct peak score',sampleRate:RATE,searchFrames:SEARCH_FRAMES,...decideOffsets(rows)};
}
module.exports={measureCalibration,decideOffsets,correlationPeak,fft,RATE,DEFAULT_K,SEARCH_FRAMES,MIN_CORRELATION,TOLERANCE_FRAMES};
