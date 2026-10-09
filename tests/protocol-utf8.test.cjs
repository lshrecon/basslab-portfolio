'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {EventEmitter}=require('node:events');
const {enumerateWorker,analysisWorker}=require('../bridge/practice-server.cjs');
const root=path.resolve(__dirname,'..'),tempRoot=path.join(root,'.repair-test-tmp');
const chars={ko:'연습자',ja:'ベースの練習',emoji:'🎸'};
function byteChunks(text){return [...Buffer.from(text,'utf8')].map(b=>Buffer.from([b]));}
function spawnMock(stdout,stderr='',code=0){
 const counts={spawns:0,kills:0};
 const spawn=()=>{counts.spawns++;const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{counts.kills++;};
  queueMicrotask(()=>{for(const b of byteChunks(stdout))child.stdout.emit('data',b);for(const b of byteChunks(stderr))child.stderr.emit('data',b);child.emit('close',code,null);});return child;};
 return {spawn,counts};
}
function fixture(t){fs.mkdirSync(tempRoot,{recursive:true});const dir=fs.mkdtempSync(path.join(tempRoot,'worker-'));t.after(()=>{const resolved=path.resolve(dir);assert.ok(resolved.startsWith(path.resolve(tempRoot)+path.sep));fs.rmSync(resolved,{recursive:true,force:true});});return dir;}

test('device enumeration preserves Korean, Japanese and emoji across one-byte stdout chunks',async()=>{
 const expected={deviceStreamOpens:0,render:[{id:'render-id',name:chars.ko}],capture:[{id:'capture-id',name:chars.ja+' '+chars.emoji}]};
 const mock=spawnMock(JSON.stringify(expected));
 assert.deepEqual(await enumerateWorker(root,mock.spawn),expected);assert.equal(mock.counts.spawns,1);assert.equal(mock.counts.kills,0);
});
test('device enumeration preserves multibyte diagnostic text on failure',async()=>{
 const diagnostic=chars.ko+' '+chars.ja+' '+chars.emoji;const mock=spawnMock('',diagnostic,1);
 await assert.rejects(enumerateWorker(root,mock.spawn),{message:'device-list-failed: '+diagnostic});
});
test('analysis result preserves nested task and participant text across one-byte chunks',async t=>{
 const dir=fixture(t),expected={takeId:'synthetic-test',ui:{participant:chars.ko,label:chars.ja+' '+chars.emoji}};
 const logs=[],mock=spawnMock(JSON.stringify(expected));
 assert.deepEqual(await analysisWorker(dir,e=>logs.push(e),mock.spawn)({takeId:'synthetic-test'}),expected);
 assert.equal(mock.counts.spawns,1);assert.equal(logs.length,1);
});
test('analysis diagnostics preserve multibyte stderr text',async t=>{
 const dir=fixture(t),diagnostic=chars.ko+' '+chars.ja+' '+chars.emoji,logs=[];
 const mock=spawnMock('{}',diagnostic);
 await analysisWorker(dir,e=>logs.push(e),mock.spawn)({takeId:'synthetic-test'});
 assert.equal(logs[0].stderr,diagnostic);
});
test('malformed analysis JSON remains rejected without retry',async t=>{
 const dir=fixture(t),mock=spawnMock('{broken-json');
 await assert.rejects(analysisWorker(dir,()=>{},mock.spawn)({takeId:'synthetic-test'}),/analysis-worker-invalid-result/);
 assert.equal(mock.counts.spawns,1);
});
test('enumeration still rejects a worker reporting opened device streams',async()=>{
 const mock=spawnMock(JSON.stringify({deviceStreamOpens:1,render:[],capture:[]}));
 await assert.rejects(enumerateWorker(root,mock.spawn),/device-list-opened-stream/);
});
async function* requestChunks(text){yield* byteChunks(text);}
test('HTTP JSON request text preserves multibyte characters split across chunks',async()=>{
 const {readRequestText}=require('../bridge/practice-server.cjs');
 const expected={participant:chars.ko,memo:chars.ja+' '+chars.emoji};
 assert.deepEqual(JSON.parse(await readRequestText(requestChunks(JSON.stringify(expected)))),expected);
});
test('HTTP request limit counts original bytes and accepts the exact boundary',async()=>{
 const {readRequestText}=require('../bridge/practice-server.cjs');const text='{"memo":"'+chars.ko+'"}',bytes=Buffer.byteLength(text);
 assert.equal(await readRequestText(requestChunks(text),bytes),text);
 assert.equal(await readRequestText(requestChunks(text),bytes-1),null);
 assert.equal(await readRequestText(requestChunks('a'.repeat(16385))),null);
});
test('HTTP empty body and ASCII chunk behavior are preserved',async()=>{
 const {readRequestText}=require('../bridge/practice-server.cjs');
 assert.equal(await readRequestText(requestChunks('')),'');
 assert.equal(await readRequestText(requestChunks('{"type":"stop"}')),'{"type":"stop"}');
});
test('HTTP read failures propagate without parsing an incomplete payload',async()=>{
 const {readRequestText}=require('../bridge/practice-server.cjs');
 async function* failed(){yield Buffer.from('{');throw Error('simulated-read-abort');}
 await assert.rejects(readRequestText(failed()),/simulated-read-abort/);
});
test('worker decoder flushes an incomplete trailing UTF-8 sequence as a replacement character',async()=>{
 const mock=spawnMock('',Buffer.from([0xe3]),1);
 await assert.rejects(enumerateWorker(root,mock.spawn),{message:'device-list-failed: \uFFFD'});
});
