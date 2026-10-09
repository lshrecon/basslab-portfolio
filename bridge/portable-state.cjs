'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const safeId=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(id);
function plain(p,dir=false){const s=fs.lstatSync(p);if(s.isSymbolicLink()||!(dir?s.isDirectory():s.isFile()))throw Error('plain-path-required');return s;}
function chain(p,root){let d=path.dirname(p);while(d===root||d.startsWith(root+path.sep)){plain(d,true);if(d===root)return;d=path.dirname(d);}throw Error('path-outside-package');}
function localTake(root,id,name='pcm.f32le'){if(!safeId(id)||!['pcm.f32le','run.json','feedback.jsonl'].includes(name))throw Error('invalid-take-path');const p=path.join(root,'takes',id,name);chain(p,root);return p;}
function writeJson(p,v){const tmp=p+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(v,null,2)+'\n',{flag:'wx'});fs.renameSync(tmp,p);}
function createSettings(root,{machine=()=>({hostname:os.hostname(),platform:os.platform(),arch:os.arch()})}={}){
 const dir=path.join(root,'settings');fs.mkdirSync(dir,{recursive:true});plain(dir,true);const file=path.join(dir,'devices.json'),calFile=path.join(dir,'calibrations.json');
 const read=(p,d)=>{try{plain(p);return JSON.parse(fs.readFileSync(p,'utf8'));}catch(e){if(e.code==='ENOENT')return d;throw e;}};
 let devices=null;
 function key(selection){if(!selection)return null;const exe=path.join(root,'native','bin','practice-engine-v2.exe');const engine=fs.existsSync(exe)?hash(fs.readFileSync(exe)):null;const resources=Object.fromEntries(['accent','subdivision','lastbar','finish'].map(n=>{const p=path.join(root,'resources',n+'.pcm24-stereo.bin');return [n,fs.existsSync(p)?hash(fs.readFileSync(p)):null];}));return hash(JSON.stringify({resources,machine:machine(),renderId:selection.renderId,captureId:selection.captureId,inputChannel:selection.inputChannel,format:{rate:44100,bits:24,buffer:441,exclusive:true},engine}));}
 function valid(selection){return !!selection&&!!devices&&devices.render.some(d=>d.id===selection.renderId)&&devices.capture.some(d=>d.id===selection.captureId);}
 function snapshot(){const selection=read(file,null),deviceKey=key(selection),calibration=read(calFile,[]).find(c=>c.deviceKey===deviceKey&&c.accepted===true)||null;return {selection,selectionValid:valid(selection),devicesEnumerated:devices!==null,calibration,kFrames:calibration?.kFrames??8842,defaultKFrames:8842,deviceKey};}
 function acceptDevices(v){if(!v||!Array.isArray(v.render)||!Array.isArray(v.capture))throw Error('invalid-device-list');for(const d of [...v.render,...v.capture])if(typeof d.id!=='string'||!d.id||typeof d.name!=='string')throw Error('invalid-device-entry');devices={render:v.render,capture:v.capture};return {...devices,selectionValid:valid(read(file,null))};}
 function save(v){if(!devices)throw Error('device-list-required');if(![1,2].includes(v.inputChannel))throw Error('input-channel-required');const r=devices.render.find(d=>d.id===v.renderId),c=devices.capture.find(d=>d.id===v.captureId);if(!r||!c)throw Error('selected-device-missing');writeJson(file,{renderId:r.id,renderName:r.name,captureId:c.id,captureName:c.name,inputChannel:v.inputChannel,savedAt:new Date().toISOString()});return snapshot();}
 function binding(){const s=snapshot();if(!s.selection||!s.selectionValid)throw Error('selected-device-missing');return {deviceSelection:s.selection,clickCalibration:s.calibration?{kFrames:s.calibration.kFrames,validatedForThisEngine:true,measurementId:s.calibration.measurementId,source:'measured-loopback-16-clicks',deviceKey:s.deviceKey}:{kFrames:8842,validatedForThisEngine:false,source:'previous-desktop-default',deviceKey:s.deviceKey}};}
 function storeCalibration(result,measurementId,bound){const entry={...result,measurementId,deviceKey:bound.deviceKey,selection:bound.selection,measuredAt:new Date().toISOString(),defaultKFrames:8842,deltaFrames:Number.isFinite(result.kFrames)?result.kFrames-8842:null,stable:result.accepted===true};if(entry.accepted){const list=read(calFile,[]).filter(c=>c.deviceKey!==entry.deviceKey);list.push(entry);writeJson(calFile,list);}return entry;}
 return {snapshot,acceptDevices,save,binding,storeCalibration};
}
// Uncompressed ZIP, using only Node built-ins. Files are deliberately selected by the caller.
const crcTable=Array.from({length:256},(_,n)=>{let c=n;for(let i=0;i<8;i++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function crc32(b){let c=0xffffffff;for(const n of b)c=crcTable[(c^n)&255]^(c>>>8);return(c^0xffffffff)>>>0;}
function zip(entries){const chunks=[],central=[];let offset=0;for(const e of entries){const name=Buffer.from(e.name.replace(/\\/g,'/'),'utf8'),data=Buffer.isBuffer(e.data)?e.data:Buffer.from(e.data),crc=crc32(data),h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt16LE(0x800,6);h.writeUInt32LE(crc,14);h.writeUInt32LE(data.length,18);h.writeUInt32LE(data.length,22);h.writeUInt16LE(name.length,26);chunks.push(h,name,data);const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8);c.writeUInt32LE(crc,16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE(offset,42);central.push(c,name);offset+=h.length+name.length+data.length;}const size=central.reduce((n,b)=>n+b.length,0),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(size,12);end.writeUInt32LE(offset,16);return Buffer.concat([...chunks,...central,end]);}
function diagnosticZip(root,include=[]){
 if(!Array.isArray(include)||include.some(id=>!safeId(id)))throw Error('invalid-export-selection');
 for(const id of include)plain(localTake(root,id));
 const entries=[];let totalBytes=0;
 const add=(p,name)=>{chain(p,root);const stat=plain(p);totalBytes+=stat.size;if(stat.size>128*1024*1024||totalBytes>256*1024*1024)throw Error('diagnostic-export-too-large');entries.push({name,data:fs.readFileSync(p)});};
 for(const folder of ['settings','runtime']){const dir=path.join(root,folder);if(!fs.existsSync(dir))continue;plain(dir,true);const files=[];
  function walk(base,relative,depth){for(const n of fs.readdirSync(base)){const p=path.join(base,n),st=fs.lstatSync(p);if(st.isSymbolicLink())throw Error('diagnostic-reparse-path');if(st.isDirectory()){if(depth<3)walk(p,relative+'/'+n,depth+1);}else if(st.isFile()&&/\.(json|jsonl|log)$/.test(n))files.push({p,name:relative+'/'+n,t:st.mtimeMs});}}
  walk(dir,folder,0);files.sort((a,b)=>b.t-a.t);for(const f of files.slice(0,folder==='runtime'?80:40))add(f.p,f.name);
 }
 for(const folder of ['takes','calibrations']){const dir=path.join(root,folder);if(!fs.existsSync(dir))continue;plain(dir,true);for(const id of fs.readdirSync(dir)){if(!safeId(id))continue;plain(path.join(dir,id),true);for(const n of ['run.json','feedback.jsonl','measurement.json']){const p=path.join(dir,id,n);if(fs.existsSync(p))add(p,folder+'/'+id+'/'+n);}if(folder==='takes'&&include.includes(id))add(localTake(root,id),'takes/'+id+'/pcm.f32le');}}
 entries.push({name:'EXPORT.json',data:JSON.stringify({createdAt:new Date().toISOString(),includedPcmTakeIds:include,automaticAudioInclusion:false,recentRuntimeFileLimit:80},null,2)});return zip(entries);
}

module.exports={createSettings,diagnosticZip,zip,crc32,localTake,safeId,writeJson,chain,plain};
