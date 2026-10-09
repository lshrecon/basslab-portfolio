'use strict';
const net=require('node:net');
const FIXED_PORT=48571,ENGINE_VERSION=21,DISCOVERY_PROTOCOL=1;
const DISCOVERY_ORIGINS=Object.freeze(['https://basslab.app','http://127.0.0.1:48572','http://localhost:48572']);
const DISCOVERY=Object.freeze({application:'basslab-engine',protocol:DISCOVERY_PROTOCOL,version:ENGINE_VERSION,analysisPath:'/analysis/'});
function probePort(port){return new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',error=>{if(error.code==='EADDRINUSE'||error.code==='EACCES')resolve(null);else reject(error);});server.listen(port,'127.0.0.1',()=>{const selected=server.address().port;server.close(error=>error?reject(error):resolve(selected));});});}
async function selectEnginePort({probe=probePort}={}){const fixed=await probe(FIXED_PORT);if(fixed===FIXED_PORT)return {port:fixed,temporaryPort:false};const port=await probe(0);if(!Number.isInteger(port)||port<1024||port>65535)throw Error('사용할 로컬 주소를 준비하지 못했습니다.');return {port,temporaryPort:true};}
module.exports={FIXED_PORT,ENGINE_VERSION,DISCOVERY_PROTOCOL,DISCOVERY_ORIGINS,DISCOVERY,probePort,selectEnginePort};
