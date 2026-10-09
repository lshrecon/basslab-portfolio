'use strict';
// Read-only inspection. This module never invokes a detector or opens an audio device.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const W = ROOT, E10 = ROOT, SINGLE = ROOT;
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function identity(file, expected) {
  const s = fs.lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink()) throw Error('plain-file-required: ' + file);
  const bytes = fs.readFileSync(file), id = { path: path.resolve(file), bytes: bytes.length, sha256: sha(bytes) };
  if (expected && (expected.bytes !== id.bytes || expected.sha256 !== id.sha256)) throw Error('identity-mismatch: ' + file);
  return id;
}
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function inspectAll(){ return {schema:'portable-input-catalogue-v1',takes:[],sources:[],deviceCalls:0}; }
function verifyCatalogue(saved){ for(const t of saved.takes||[]){identity(t.pcm.path,t.pcm);identity(t.run.path,t.run);}return {takeCount:saved.takes?.length??0,preserved:true}; }
module.exports = { ROOT, W, E10, SINGLE, identity, read, inspectAll, verifyCatalogue };
