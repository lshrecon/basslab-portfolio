'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const definitions=[
 {role:'detector',name:'practical-mpm.cjs',bytes:23533,sha256:'93fa1e4c8574cdbbfcbfdf37bbccdb28a84e21ebe648e01bf4071643e13c61f9'},
 {role:'evidence',name:'evidence-labels.cjs',bytes:12270,sha256:'92754df108fb8a16a7519067874a65a744d8312c74efbec0bf2fda6cf4aa8255'},
 {role:'pulse',name:'pulse-onset-r2.cjs',bytes:20951,sha256:'979a2fc87cf106e822763b3de883680166a756e880ceda0b032c7998cb0b9a1b'}
];
function verify(){
 return definitions.map(d=>{
  const file=path.join(__dirname,'frozen',d.name),stat=fs.lstatSync(file),bytes=fs.readFileSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||bytes.length!==d.bytes||sha(bytes)!==d.sha256)throw Error('frozen-source-mismatch: '+d.name);
  return {...d,path:file};
 });
}
function load(){
 const identities=verify(),detector=require('./frozen/practical-mpm.cjs'),evidence=require('./frozen/evidence-labels.cjs'),pulse=require('./frozen/pulse-onset-r2.cjs');
 verify();
 const settings={detector:detector.settings,evidence:evidence.settings,pulse:pulse.PARAMS};
 return {detector,evidence,pulse,profile:{identities,versions:{detector:detector.version,evidence:evidence.version,pulse:pulse.VERSION},settings,settingsSha256:Object.fromEntries(Object.entries(settings).map(([k,v])=>[k,sha(Buffer.from(JSON.stringify(v)))]))}};
}
if(require.main===module){
 const out=path.join(__dirname,'../FREEZE.json');
 fs.writeFileSync(out,JSON.stringify({schema:'new-recordings-frozen-chain-v1',frozenAt:new Date().toISOString(),realNewTakeAnalysisCalls:0,...load().profile},null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({path:out,...{bytes:fs.statSync(out).size,sha256:sha(fs.readFileSync(out))}}));
}
module.exports={verify,load,sha};
