'use strict';
const crypto=require('node:crypto');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const RATE=44100, BASS_GAIN=2.55, CLICK_GAIN=1.38, SAFE_PEAK=0.98;
function wav(samples){const b=Buffer.alloc(44+samples.length*4);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(3,20);b.writeUInt16LE(2,22);b.writeUInt32LE(RATE,24);b.writeUInt32LE(RATE*8,28);b.writeUInt16LE(8,32);b.writeUInt16LE(32,34);b.write('data',36);b.writeUInt32LE(samples.length*4,40);for(let i=0;i<samples.length;i++)b.writeFloatLE(samples[i],44+i*4);return b;}
function decode24(bytes){if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length%6)throw new Error('click-resource-alignment');const out=new Float64Array(bytes.length/3);for(let i=0;i<out.length;i++)out[i]=bytes.readIntLE(i*3,3)/8388608;return out;}
// Both toggles use the same whole-take gain. No clipping, resampling, or per-clip normalization.
function mixPlayback({pcm,render,accent,subdivision,lastbar,finish,bassGain=BASS_GAIN,clickGain=CLICK_GAIN,configSha256=null}){
 if(!render?.available)throw new Error('click-timeline-unavailable');if(!Buffer.isBuffer(pcm)||pcm.length%4)throw new Error('PCM alignment');
 if(![bassGain,clickGain].every(x=>Number.isFinite(x)&&x>=0))throw new Error('invalid-mix-gain');
 const resourceBytes={accent,subdivision,...(lastbar?{lastbar}:{}),...(finish?{finish}:{})};
 const resources=Object.fromEntries(Object.entries(resourceBytes).map(([k,b])=>[k,decode24(b)])),frames=pcm.length/4,mix=new Float64Array(frames*2),dry=new Float64Array(frames*2);
 for(let i=0;i<frames;i++){const v=pcm.readFloatLE(i*4);if(!Number.isFinite(v))throw new Error('nonfinite PCM');mix[i*2]=mix[i*2+1]=dry[i*2]=dry[i*2+1]=v*bassGain;}
 const events=[];
 for(const e of render.events){const h=e.h??e.timeSeconds,start=Math.round(h*RATE);if(!Number.isFinite(h)||!Number.isSafeInteger(start)||!Number.isSafeInteger(e.actualRenderFrame))throw new Error('invalid-actual-click-frame');const wave=resources[e.resource];if(!wave)throw new Error('unknown-click-resource');let used=0;
  const permittedFrames=e.playbackFrames===undefined?wave.length/2:e.playbackFrames;if(!Number.isSafeInteger(permittedFrames)||permittedFrames<0||permittedFrames>wave.length/2)throw new Error('invalid-submitted-click-length');
  for(let f=0;f<permittedFrames;f++){const target=start+f;if(target<0||target>=frames)continue;mix[target*2]+=wave[f*2]*clickGain;mix[target*2+1]+=wave[f*2+1]*clickGain;used++;}
  events.push({scheduleIndex:e.scheduleIndex,startFrame:start,actualRenderFrame:e.actualRenderFrame,countIn:!!e.countIn,resource:e.resource,mixedFrames:used,clippedByRecordingBoundary:used<wave.length/2});
 }
 let peakBefore=0,dryPeak=0;for(let i=0;i<mix.length;i++){peakBefore=Math.max(peakBefore,Math.abs(mix[i]));dryPeak=Math.max(dryPeak,Math.abs(dry[i]));}
 const commonGain=Math.min(1,SAFE_PEAK/Math.max(peakBefore,dryPeak,Number.MIN_VALUE));for(let i=0;i<mix.length;i++){mix[i]*=commonGain;dry[i]*=commonGain;}
 const on=wav(mix),off=wav(dry),metadata={schema:'click-playback-v12',available:true,sampleRate:RATE,frames,channels:2,pcmSha256:sha(pcm),configSha256,kFrames:render.kFrames,resourceIdentities:Object.fromEntries(Object.entries(resourceBytes).map(([name,b])=>[name,{bytes:b.length,sha256:sha(b)}])),bassGain,clickGain,commonGain,effectiveBassGain:bassGain*commonGain,effectiveClickGain:clickGain*commonGain,peakBefore,peakAfter:peakBefore*commonGain,dryPeakAfter:dryPeak*commonGain,safePeak:SAFE_PEAK,channelPolicy:'mono bass duplicated equally; original stereo click channels preserved',gainPolicy:'one whole-take common gain shared by click on/off; no clip normalization',countInClicks:events.filter(e=>e.countIn).length,clickCount:events.length,events,on:{bytes:on.length,sha256:sha(on)},off:{bytes:off.length,sha256:sha(off)},originalModified:false};
 return {on,off,metadata};
}
module.exports={RATE,BASS_GAIN,CLICK_GAIN,SAFE_PEAK,mixPlayback,decode24};
