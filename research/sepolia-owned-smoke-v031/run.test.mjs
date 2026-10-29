import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { POLICY, REQUEST, recorder, runSmoke, sourceIdentity, writer, sha } from './run.mjs';
import { verifyEvidence } from './verify.mjs';
import { amsterdamClearingFixture } from '../../engines/local-evm/test/amsterdam-clearing-fixture.js';

test('fixed source identity is explicit and changed saved bytes cannot be sealed', async () => {
  const source = await sourceIdentity(); assert.match(source.sha256, /^[0-9a-f]{64}$/);
  assert(source.identity.implementation.inventory.some(r => r.path.endsWith('/gas-validation.js')));
  await assert.rejects(runSmoke({ expectedSourceSha256: '0'.repeat(64), fetchImpl: () => { throw Error('No network permitted'); } }));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sepolia-owned-writer-'));
  try { const w = writer(path.join(temp,'capture')); w.save('a.json', { fixed: true }); fs.writeFileSync(path.join(temp,'capture/a.json'), '{}'); assert.throws(w.seal); }
  finally { fs.rmSync(temp, { recursive: true }); }
});

test('request bytes/envelope/errors are retained and phase/clock bounds stop dispatch', async () => {
  let calls = 0, clock = 0;
  const t = recorder({ wall: () => clock, mono: () => clock, fetchImpl: async (_url, options) => { calls++; const req = JSON.parse(options.body); return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method unavailable' } })); } });
  await assert.rejects(t.rpc('eth_chainId', [], 'selection', POLICY.selectionMs), /method unavailable/);
  assert.equal(t.rows[0].completeBody, true); assert(Buffer.from(t.rows[0].responseBase64,'base64').toString().includes('-32601'));
  clock = POLICY.selectionMs; await assert.rejects(t.rpc('eth_chainId', [], 'selection', POLICY.selectionMs)); assert.equal(calls, 1);
  clock = -1; assert.equal((await t.drain()).withinDeadline, false);
});

test('oversized and still-pending cancelled bodies are explicitly unusable', async () => {
  const oversized = recorder({ fetchImpl: async () => new Response(new Uint8Array(POLICY.responseBytes + 1)) });
  await assert.rejects(oversized.rpc('eth_chainId', [], 'selection', POLICY.selectionMs), /response_byte_limit/);
  assert.equal(oversized.rows[0].completeBody, false); assert.equal((await oversized.drain()).withinDeadline, false);
  let clock = 0;
  const pending = recorder({ wall: () => clock, mono: () => clock, fetchImpl: async () => ({ status: 200, body: { getReader: () => ({ read: () => new Promise(() => {}), cancel() { clock = POLICY.totalMs; return Promise.resolve(); } }) } }) });
  await assert.rejects(pending.rpc('eth_chainId', [], 'selection', 5), /deadline/);
  const drained = await pending.drain(); assert.equal(drained.complete, false); assert.equal(drained.active, 1);
});

test('synthetic real-child capture seals before final bracket, retains HTTP rejection and independently verifies proofs', async () => {
  const f = await amsterdamClearingFixture({ accounts: { [POLICY.sender]: { nonce: 1n, balance: 10n**18n, code: '0x' }, [POLICY.recipient]: { nonce: 0n, balance: 17n, code: '0x' } } });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sepolia-owned-e2e-')), directory = path.join(temp,'capture'), seen = [];
  const source = await sourceIdentity();
  try {
    const r = await runSmoke({ directory, expectedSourceSha256: source.sha256, fetchImpl: async (url, options) => {
      const req = JSON.parse(options.body); seen.push({url,req});
      if (url === POLICY.loopback) { assert.equal(req.chainId, POLICY.chainId); assert.equal(req.from, REQUEST.from); return new Response(JSON.stringify({ error: { code: 'UNSUPPORTED_CHAIN', message: 'Only Ethereum chain 1 is supported.' } }), {status:400}); }
      let result;
      if (req.method === 'eth_chainId') result = '0xaa36a7';
      else if (req.method === 'eth_getBlockByNumber') {
        if (req.params[0] !== 'latest') assert(fs.existsSync(path.join(directory,'PRODUCT_SEALED.json')));
        result = f.header;
      } else result = await f.rpc.call(req.method,req.params);
      return new Response(JSON.stringify({jsonrpc:'2.0',id:req.id,result}));
    } });
    assert.equal(r.status, 'completed', JSON.stringify(r)); assert.equal(r.execution.status, 'success');
    assert.equal(r.publicHttp.httpStatus, 400); assert.equal(r.publicHttp.response.error.code, 'UNSUPPORTED_CHAIN');
    const audited = await verifyEvidence({ directory, manifestSha256:r.manifestSha256 }); assert.equal(audited.verifiedAccounts, 2);
    assert.deepEqual(audited.native.map(v=>v.deltaRaw), ['-1000000000000000','1000000000000000']);
    assert.equal(audited.execution.executionGasUsed, '0'); assert.equal(audited.execution.executionStateGasUsed, '0');
    assert(seen.every(({req,url})=>url===POLICY.loopback || ['eth_chainId','eth_getBlockByNumber','eth_getProof','eth_getCode'].includes(req.method)));
    // Re-seal a coordinated value-offset forgery while leaving authentic proof
    // inputs unchanged. Arithmetic alone would pass this altered packet.
    const originals = new Map(fs.readdirSync(directory).map(name => [name, fs.readFileSync(path.join(directory,name))]));
    const put = (name,value) => fs.writeFileSync(path.join(directory,name),JSON.stringify(value,null,2)+'\n');
    const preview = JSON.parse(originals.get('preview.json')), results = JSON.parse(originals.get('results.json'));
    for (const row of [preview.preview.measurements[0], results.preview.preview.measurements[0]]) {
      row.values[0].beforeRaw = (BigInt(row.values[0].beforeRaw)+1n).toString(); row.values[0].afterRaw = (BigInt(row.values[0].afterRaw)+1n).toString();
      row.before.values[0].raw = row.values[0].beforeRaw; row.after.values[0].raw = row.values[0].afterRaw;
    }
    put('preview.json',preview);put('results.json',results);const seal=JSON.parse(originals.get('PRODUCT_SEALED.json'));seal.previewSha256=sha(fs.readFileSync(path.join(directory,'preview.json')));put('PRODUCT_SEALED.json',seal);
    const manifest=JSON.parse(originals.get('manifest.json'));for(const row of manifest.files){const b=fs.readFileSync(path.join(directory,row.path));row.bytes=b.length;row.sha256=sha(b);}put('manifest.json',manifest);
    await assert.rejects(verifyEvidence({directory,manifestSha256:sha(fs.readFileSync(path.join(directory,'manifest.json')))}));
    for(const [name,b] of originals)fs.writeFileSync(path.join(directory,name),b);
    const p = path.join(directory,'preview.json'), original = fs.readFileSync(p); fs.writeFileSync(p, Buffer.concat([original, Buffer.from(' ')]));
    await assert.rejects(verifyEvidence({directory,manifestSha256:r.manifestSha256}));
  } finally { fs.rmSync(temp, { recursive: true }); }
});

test('proof RPC rejection remains an auditable unavailable result with final header retained', async () => {
  const f = await amsterdamClearingFixture();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sepolia-owned-unavailable-')), directory = path.join(temp, 'capture');
  try {
    const source = await sourceIdentity();
    const r = await runSmoke({ directory, expectedSourceSha256: source.sha256, fetchImpl: async (url, options) => {
      const req = JSON.parse(options.body);
      if (url === POLICY.loopback) return new Response(JSON.stringify({ error: { code: 'UNSUPPORTED_CHAIN' } }), {status:400});
      if (req.method === 'eth_getProof') return new Response(JSON.stringify({ jsonrpc:'2.0', id:req.id, error:{code:-32601,message:'proof method unavailable'} }));
      return new Response(JSON.stringify({jsonrpc:'2.0',id:req.id,result:req.method === 'eth_chainId' ? '0xaa36a7' : f.header}));
    } });
    assert.equal(r.usable, false); assert.equal(r.status, 'unavailable');
    const checked = await verifyEvidence({ directory, manifestSha256:r.manifestSha256 });
    assert.equal(checked.usable, false); assert.equal(checked.verifiedAccounts, 0);
  } finally { fs.rmSync(temp, {recursive:true}); }
});
