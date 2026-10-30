import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyCohortWireRecord, verifyCollectorBindings, verifyProductBindings, verifyLocalBindings, verifyCohortEvidence } from './cohort-verify.mjs';
import { createCohortTransport, createCohortWireBudget } from './cohort-wire.mjs';
import { collectProspectiveCensus } from './cohort-collector.mjs';
import { verifyEthereumHeader } from '../../engines/local-evm/ethereum-header.js';
import { createRpcStateInputs } from '../../engines/local-evm/rpc-state-inputs.js';
import { verifyStateProof } from '../../engines/local-evm/verified-state-proof.js';
import { proofFixture, A, C } from '../../engines/local-evm/test/proof-fixture.js';
import { adjudicateCohortOutcome } from './cohort-outcomes.mjs';
const sha = v => createHash('sha256').update(v).digest('hex');
const bad = f => assert.throws(f, e => e.code === 'COHORT_EVIDENCE_INVALID');
const require = createRequire(new URL('../../engines/local-evm/package.json', import.meta.url));
const { RLP } = await import(require.resolve('@ethereumjs/rlp'));
const { keccak_256 } = await import(require.resolve('@noble/hashes/sha3.js'));
const source = readFileSync(new URL('../../reports/ethereum-proof-capability/capture.json', import.meta.url));
assert.equal(sha(source), 'd0965c21ce4f75e1c1db5df31e1a21970c9f11ffb985f24f7b911359caf0df6e');
const template = JSON.parse(source).selectedHeader, seed = '0x' + 'a'.repeat(64);
const word = n => '0x' + BigInt(n).toString(16).padStart(64, '0'), q = n => '0x' + BigInt(n).toString(16);
const EMPTY = '0x' + Buffer.from(keccak_256(RLP.encode(new Uint8Array()))).toString('hex');
const ORDER = ['parentHash', 'sha3Uncles', 'miner', 'stateRoot', 'transactionsRoot', 'receiptsRoot', 'logsBloom', 'difficulty', 'number', 'gasLimit', 'gasUsed', 'timestamp', 'extraData', 'mixHash', 'nonce', 'baseFeePerGas', 'withdrawalsRoot', 'blobGasUsed', 'excessBlobGas', 'parentBeaconBlockRoot', 'requestsHash'];
const INTEGERS = new Set(['difficulty', 'number', 'gasLimit', 'gasUsed', 'timestamp', 'baseFeePerGas', 'blobGasUsed', 'excessBlobGas']);
function headers() {
  const list = [];
  for (let i = 0; i < 4; i++) {
    const h = { ...structuredClone(template), number: q(BigInt(template.number) + BigInt(i)), timestamp: q(BigInt(template.timestamp) + BigInt(i * 12)), parentHash: i ? list.at(-1).hash : word(19), transactions: [], transactionsRoot: EMPTY, gasUsed: '0x0', withdrawals: [], uncles: [] };
    const fields = ORDER.map(k => { let x = h[k].slice(2); if (INTEGERS.has(k)) { x = BigInt(h[k]) === 0n ? '' : BigInt(h[k]).toString(16); if (x.length % 2) x = '0' + x; } return Buffer.from(x, 'hex'); });
    h.hash = '0x' + Buffer.from(keccak_256(RLP.encode(fields))).toString('hex'); list.push(h);
  }
  return list;
}
async function collection({ failAt, cancelWait = false, tips = [3, 3] } = {}) {
  const list = headers(), wires = [], events = []; let count = 0, time = Date.parse('2026-10-27T00:00:00.000Z');
  const budget = createCohortWireBudget(), controller = new AbortController();
  const transports = Object.fromEntries(['drpc', 'publicnode'].map(provider => [provider, createCohortTransport({ budget, provider, profile: 'census', save: w => { wires.push(w); }, fetchImpl: async (_url, options) => {
    const r = JSON.parse(options.body); count++;
    if (count === failAt) return new Response(JSON.stringify({ jsonrpc: '2.0', id: r.id, error: { code: -32000, message: 'synthetic failure' } }));
    const result = r.method === 'eth_chainId' ? '0x1' : r.method === 'eth_getBlockByNumber' ? list[r.params[0] === 'latest' ? 0 : tips[provider === 'drpc' ? 0 : 1]] : list.find(h => h.hash === r.params[0]);
    assert(result); return new Response(JSON.stringify({ jsonrpc: '2.0', id: r.id, result }));
  } })]));
  const selection = await collectProspectiveCensus({ transports, seed, sampleSize: 16, now: () => time, save: e => { events.push(e); }, signal: controller.signal,
    async waitUntil(deadline) { if (cancelWait) controller.abort(); else time = deadline; } });
  return { selection, wires, events, plan: { seed } };
}
const check = x => verifyCollectorBindings(x.selection, x.wires, x.events, x.plan, verifyEthereumHeader);

test('exact real transport records verify; request, body and success-label mutations fail', async () => {
  const x = await collection();
  for (const w of x.wires) assert.equal(verifyCohortWireRecord(w).status, 'completed');
  for (const mutate of [w => { w.request.params.push('extra'); }, w => { w.rawBase64 = Buffer.from('{}').toString('base64'); }, w => { w.parsed.result = 'changed'; }, w => { w.transport.observedSha256 = 'a'.repeat(64); }, w => { w.dispatched = false; }]) {
    const w = structuredClone(x.wires[0]); mutate(w); bad(() => verifyCohortWireRecord(w));
  }
});
test('RPC-error and truncated-body outcomes remain failures with explicit hash limitations', async () => {
  const failed = await collection({ failAt: 1 }); assert.equal(verifyCohortWireRecord(failed.wires[0]).status, 'failed');
  const w = structuredClone(failed.wires[0]); w.status = 'completed'; delete w.error; bad(() => verifyCohortWireRecord(w));
  const t = createCohortTransport({ budget: createCohortWireBudget(), provider: 'drpc', profile: 'census', limits: { responseBytes: 5 }, fetchImpl: async () => new Response('abcdefgh') });
  await assert.rejects(t.call('eth_chainId'));
  const audit = verifyCohortWireRecord(t.records()[0]); assert.equal(audit.unretainedObservedHashVerified, false); assert.equal(audit.retainedBytes, 5); assert.equal(audit.observedBytes, 8);
});
test('complete collector reconstruction binds actual ordered reads, seed and fixed branch', async () => {
  const x = await collection(); assert.equal(x.selection.status, 'complete');
  const input = check(x); assert.equal(input.observations.length, 2); assert.equal(input.seed, seed);
  for (const mutate of [y => { y.plan.seed = word(1); }, y => { y.wires[5].parsed.result.stateRoot = word(1); }, y => { y.selection.artifacts.observations[0].headers.reverse(); }, y => { y.wires.reverse(); }, y => { y.events[1].details.params.push('altered'); }]) {
    const y = structuredClone(x); mutate(y); bad(() => check(y));
  }
});
test('failure before anchor, aborted wait and failed ancestry retain no repaired census', async () => {
  for (const options of [{ failAt: 1 }, { failAt: 2 }, { cancelWait: true }, { failAt: 6 }, { tips: [1, 3] }]) {
    const x = await collection(options); assert.equal(x.selection.status, 'selection_failed'); assert.equal(check(x), null);
  }
});
test('terminal event mutation and premature target observation are rejected', async () => {
  const x = await collection();
  const a = structuredClone(x); a.events.find(e => e.kind === 'call_completed').details.result = '0x2'; a.selection.artifacts.stages = structuredClone(a.events); bad(() => check(a));
  const b = structuredClone(x); const attempt = b.selection.artifacts.attempts[2]; attempt.startedAt = b.selection.artifacts.anchorDeclaration.anchorObservedAt;
  for (const e of b.events) if (e.details.index === 2 && ['call_planned', 'call_completed'].includes(e.kind)) e.details.startedAt = attempt.startedAt;
  b.selection.artifacts.stages = structuredClone(b.events); bad(() => check(b));
});
test('product parsed request/response must bind actual wire and immutable HTTP bytes', async () => {
  const x = await collection(), w = x.wires[0], request = { chainId: 1, from: 'synthetic' };
  const report = { transportEvidence: [{ id: w.id, request: w.request, requestText: w.requestText, requestBytes: w.requestBytes, requestSha256: w.requestSha256, responseText: w.responseText, transport: { responseSha256: sha(w.responseText), observedBytes: w.transport.observedBytes } }] };
  const bodyText = JSON.stringify(report), inputText = JSON.stringify(request);
  const product = { dispatch: 'completed', httpStatus: 200, request: { method: 'POST', path: '/api/evm/simulate', contentType: 'application/json', bodyText: inputText, bodySha256: sha(inputText) }, response: { status: 200, bodyText, bytes: Buffer.byteLength(bodyText), sha256: sha(bodyText) }, report };
  verifyProductBindings(product, [w], request);
  const mutated = structuredClone(product); mutated.report.transportEvidence[0].responseText = '{}'; bad(() => verifyProductBindings(mutated, [w], request));
  bad(() => verifyProductBindings(product, [], request));
});
test('missing local input or unbound successful broker response cannot become verified facts', async () => {
  const x = await collection(), w = x.wires[0];
  await assert.rejects(verifyLocalBindings({ dispatch: 'completed' }, [], template, {}), /without an attempt/);
  await assert.rejects(verifyLocalBindings({ dispatch: 'unavailable' }, [w], template, {}), /without an attempt/);
  bad(() => verifyProductBindings({ dispatch: 'unavailable' }, [w], {}));
  const phase = { dispatch: 'unavailable', attempt: { status: 'unavailable', inputs: null, broker: { calls: 1, dispatches: 1, pendingAtReturn: 0, records: [{ id: 1, dispatched: true, status: 'received', request: { method: w.request.method, params: w.request.params }, resultBytes: 999, resultSha256: sha('wrong') }] } } };
  await assert.rejects(verifyLocalBindings(phase, [w], template, {}), /broker result differs/);
  phase.attempt.broker.records[0].status = 'unavailable'; phase.transportDenied = [{ method: 'eth_chainId', code: 'attempt_budget' }];
  assert.deepEqual(await verifyLocalBindings(phase, [], template, {}), { proofsVerified: 0 });
  const invalid = { dispatch: 'unavailable', attempt: { status: 'unavailable', error: { code: 'LOCAL_ISOLATED_INPUT' }, isolation: null, inputs: null, broker: { calls: 0, records: [], pendingAtReturn: 0 } } };
  assert.deepEqual(await verifyLocalBindings(invalid, [], template, {}), { proofsVerified: 0 });
  invalid.dispatch = 'completed'; await assert.rejects(verifyLocalBindings(invalid, [], template, {}), /Invalid-input/);
});
test('actual-shaped HTTP502 without internal RPC evidence retains unavailable and declares incomplete joins', async () => {
  const x = await collection(), wire = x.wires[0], request = { chainId: 1, from: '0x' + '1'.repeat(40), to: '0x' + '2'.repeat(40), data: '0x', value: '0', block: template.hash };
  const report = { error: 'Ethereum preview is unavailable.' }, bodyText = JSON.stringify(report), inputText = JSON.stringify(request);
  const product = { dispatch: 'completed', httpStatus: 502, request: { method: 'POST', path: '/api/evm/simulate', contentType: 'application/json', bodyText: inputText, bodySha256: sha(inputText) }, response: { status: 502, bodyText, bytes: Buffer.byteLength(bodyText), sha256: sha(bodyText) }, report };
  assert.deepEqual(verifyProductBindings(product, [wire], request), { independentlyJoinedWireRecords: 0, phaseDeclaredOnlyWireRecords: 1 });
  const outcome = adjudicateCohortOutcome({ transactionHash: word(1), request: { from: request.from, to: request.to, data: '0x', value: '0', gas: '5000000' }, header: template, expectedProductImplementation: {}, expectedLocalImplementation: {}, local: { dispatch: 'unavailable' }, product });
  assert.equal(outcome.outcome.execution, 'provider_unavailable'); assert.equal(outcome.outcome.comparison, 'not_comparable'); assert.equal(outcome.allChannelsComplete, false);
  const altered = structuredClone(product); delete altered.request; bad(() => verifyProductBindings(altered, [wire], request));
  const incorrect = structuredClone(product); incorrect.httpStatus = 200; bad(() => verifyProductBindings(incorrect, [wire], request));
});
test('account and storage facts reverify legacy code and proof-derived empty code, including hidden storage and absence', async () => {
  for (const [account, code] of [[A, '0x600100'], [A, '0x'], [C, '0x']]) {
    const fixture = await proofFixture({ address: account, code, requested: [word(0)] }), header = { hash: word(111), stateRoot: fixture.input.stateRoot };
    const rpc = createCohortTransport({ budget: createCohortWireBudget(), provider: 'drpc', profile: 'local', blockHash: header.hash, fetchImpl: async (_url, options) => {
      const r = JSON.parse(options.body); return new Response(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: r.method === 'eth_getCode' ? fixture.input.code : fixture.input.proof }));
    } });
    const collector = createRpcStateInputs({ chainId: 1, header, blockHash: header.hash, rpc }); await collector.getStorage(account, word(0));
    const inputEvidence = collector.snapshotEvidence(), wires = rpc.records();
    const local = { dispatch: 'completed', attempt: { status: 'completed', inputs: collector.snapshotInputs(), inputEvidence,
      broker: { calls: inputEvidence.length, dispatches: inputEvidence.length, pendingAtReturn: 0, records: inputEvidence.map(e => ({ id: e.id, request: e.request, status: 'received', dispatched: true, resultSha256: e.resultSha256, resultBytes: e.resultBytes })) } } };
    assert((await verifyLocalBindings(local, wires, header, { verifyStateProof })).proofsVerified >= 1);
    const provenance = local.attempt.inputs.provenance[0];
    if (code === '0x') {
      assert(wires.every(w => w.request.method === 'eth_getProof'));
      assert.equal(provenance.codeEvidenceId, null);
      assert.equal(provenance.codeDerivation, account === C ? 'verified_account_absence' : 'verified_account_empty_code_hash');
      for (const mutate of [
        p => { p.codeDerivation = account === C ? 'verified_account_empty_code_hash' : 'verified_account_absence'; },
        p => { p.codeDerivation = 'empty'; }, p => { p.codeEvidenceId = 1; },
        p => { delete p.codeDerivation; }, p => { p.extra = true; }, p => { p.proofEvidenceId = '1'; },
      ]) {
        const changed = structuredClone(local); mutate(changed.attempt.inputs.provenance[0]);
        await assert.rejects(verifyLocalBindings(changed, wires, header, { verifyStateProof }));
      }
    } else {
      assert(wires.some(w => w.request.method === 'eth_getCode'));
      const hidden = structuredClone(local); hidden.attempt.inputs.accounts[account].code = '0x';
      Object.assign(hidden.attempt.inputs.provenance[0], { codeEvidenceId: null, codeDerivation: 'verified_account_empty_code_hash' });
      await assert.rejects(verifyLocalBindings(hidden, wires, header, { verifyStateProof }), e => e.code === 'STATE_PROOF_INVALID');
    }
    const facts = structuredClone(local);
    if (account === A) facts.attempt.inputs.accounts[account].storage[word(0)] = word(8);
    else facts.attempt.inputs.provenance[0].storage[0].value = word(1);
    await assert.rejects(verifyLocalBindings(facts, wires, header, { verifyStateProof }), /Storage input|Absent-account storage/);
    const forged = structuredClone(local), changedWires = structuredClone(wires), e = forged.attempt.inputEvidence[0];
    e.result.accountProof[0] = e.result.accountProof[0].slice(0, -2) + (e.result.accountProof[0].endsWith('00') ? '01' : '00');
    e.resultSha256 = sha(JSON.stringify(e.result)); e.resultBytes = Buffer.byteLength(JSON.stringify(e.result));
    forged.attempt.broker.records[0].resultSha256 = e.resultSha256; forged.attempt.broker.records[0].resultBytes = e.resultBytes;
    changedWires[0].parsed.result = structuredClone(e.result);
    await assert.rejects(verifyLocalBindings(forged, changedWires, header, { verifyStateProof }), e => e.code === 'STATE_PROOF_INVALID');
  }
});
test('manifest identity, file bytes and unlisted/link artifacts fail before any archive imports', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cohort-audit-negative-'));
  try {
    const plan = '{}', manifest = { schemaVersion: '1.0', planSha256: sha(plan), sourceManifestSha256: sha(plan), files: [{ path: 'plan.json', bytes: 2, sha256: sha(plan) }, { path: 'source-manifest.json', bytes: 2, sha256: sha(plan) }] };
    await writeFile(join(dir, 'plan.json'), plan); await writeFile(join(dir, 'source-manifest.json'), plan);
    const text = JSON.stringify(manifest); await writeFile(join(dir, 'evidence-manifest.json'), text);
    await assert.rejects(verifyCohortEvidence({ outputDirectory: dir, expectedManifestSha256: '0'.repeat(64) }), /manifest identity/);
    await writeFile(join(dir, 'unlisted.json'), '{}');
    await assert.rejects(verifyCohortEvidence({ outputDirectory: dir, expectedManifestSha256: sha(text) }), /membership/);
    await rm(join(dir, 'unlisted.json')); await writeFile(join(dir, 'plan.json'), '[]');
    await assert.rejects(verifyCohortEvidence({ outputDirectory: dir, expectedManifestSha256: sha(text) }), /bytes\/hash/);
    await rm(join(dir, 'plan.json')); await symlink(join(dir, 'source-manifest.json'), join(dir, 'plan.json'));
    await assert.rejects(verifyCohortEvidence({ outputDirectory: dir, expectedManifestSha256: sha(text) }), /regular file/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('actual child ancestor inputs join captured wire and verify independently; tampering or missing archive support fails',async()=>{
 const [{fixture,blockhashCode},ancestry,{executeIsolatedEthereumCall}]=await Promise.all([
  import('../../engines/local-evm/test/ancestry-fixture.js'),import('../../engines/local-evm/authenticated-ancestry.js'),import('../../engines/local-evm/isolated-call.js')]);
 const f=await fixture(blockhashCode(2)),rpc=createCohortTransport({budget:createCohortWireBudget(),provider:'drpc',profile:'local',blockHash:f.header.hash,header:f.header,fetchImpl:async(_url,options)=>{
  const r=JSON.parse(options.body),result=await f.rpc.call(r.method,r.params);return new Response(JSON.stringify({jsonrpc:'2.0',id:r.id,result}));
 }});
 const attempt=await executeIsolatedEthereumCall({request:f.request,header:f.header,rpc}),local={dispatch:'completed',attempt},wires=rpc.records(),modules={verifyStateProof,...ancestry};
 assert.equal(attempt.output.execution.status,'success');assert.equal(wires.length,4);assert.equal(wires.filter(w=>w.request.method==='eth_getCode').length,1);wires.forEach(verifyCohortWireRecord);assert.equal(wires.at(-1).ancestorVerification,'verified');
 assert.equal((await verifyLocalBindings(local,wires,f.header,modules)).proofsVerified,2);
 for(const mutate of [x=>{x.attempt.inputs.ancestry.lookups[0].hash='0x'+'1'.repeat(64);},x=>{delete x.attempt.inputs.ancestry;},x=>{delete x.attempt.inputEvidence.find(e=>e.request.method==='eth_getBlockByHash').result;}]){
  const changed=structuredClone(local);mutate(changed);await assert.rejects(verifyLocalBindings(changed,wires,f.header,modules));
 }
 await assert.rejects(verifyLocalBindings(local,wires,f.header,{verifyStateProof}),/ancestor verifier/);
 const substituted=structuredClone(wires);substituted.at(-1).request.params[0]='0x'+'1'.repeat(64);await assert.rejects(verifyLocalBindings(local,substituted,f.header,modules),/committed next parent/);
 const bad=await fixture(blockhashCode(2),4,({method,result})=>method==='eth_getBlockByHash'?{...result,gasUsed:'0x0'}:result);
 const transport=createCohortTransport({budget:createCohortWireBudget(),provider:'drpc',profile:'local',blockHash:bad.header.hash,header:bad.header,fetchImpl:async(_url,options)=>{const r=JSON.parse(options.body);return new Response(JSON.stringify({jsonrpc:'2.0',id:r.id,result:await bad.rpc.call(r.method,r.params)}));}});
 const failed=await executeIsolatedEthereumCall({request:bad.request,header:bad.header,rpc:transport});
 assert.equal(failed.output.execution.status,'unavailable');assert.equal(transport.records().at(-1).error,'ancestor_header_invalid');transport.records().forEach(verifyCohortWireRecord);
 assert.equal((await verifyLocalBindings({dispatch:'completed',attempt:failed},transport.records(),bad.header,modules)).proofsVerified,2);
});
