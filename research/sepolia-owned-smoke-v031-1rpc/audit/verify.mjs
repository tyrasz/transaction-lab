// Post-seal supplement: non-200 id:null error replies remain failed transport; no result is admitted.
// Saved artifacts and MPT proofs only. This verifier never executes an EVM,
// contacts a provider, or imports a producer adjudicator.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { POLICY, REQUEST, QUERIES, sha } from '../run.mjs';

export async function verifyEvidence({ directory, manifestSha256 }) {
  const bytes = name => fs.readFileSync(path.join(directory, name));
  const read = name => JSON.parse(bytes(name));
  const manifestBytes = bytes('manifest.json'); assert.equal(sha(manifestBytes), manifestSha256);
  const manifest = JSON.parse(manifestBytes), paths = new Set();
  for (const row of manifest.files) {
    assert(/^[a-zA-Z0-9._-]+$/.test(row.path) && !paths.has(row.path)); paths.add(row.path);
    const stat = fs.lstatSync(path.join(directory, row.path)); assert(stat.isFile() && !stat.isSymbolicLink());
    const b = bytes(row.path); assert.equal(b.length, row.bytes); assert.equal(sha(b), row.sha256);
  }
  assert.deepEqual(fs.readdirSync(directory).sort(), [...paths, 'manifest.json'].sort());
  const plan = read('plan.json'), source = read('source.json'), result = read('results.json');
  assert.deepEqual(plan.policy, POLICY); assert.deepEqual(plan.request, REQUEST); assert.deepEqual(plan.queries, QUERIES);
  assert.equal(sha(JSON.stringify(source)), plan.sourceSha256);
  assert.equal(read('STARTED.json').sourceSha256, plan.sourceSha256);
  assert.equal(source.implementation.sourceSha256, sha(JSON.stringify({ files: source.implementation.inventory, runtime: source.implementation.runtime })));
  const wires = [...paths].filter(p => /^wire-\d+\.json$/.test(p)).sort().map(read), publicWires = wires.filter(r => r.url === POLICY.endpoint);
  assert(publicWires.length <= POLICY.calls && publicWires.length === result.transport.publicCalls);
  let total = 0;
  for (const [i, row] of wires.entries()) {
    assert.equal(row.index, i + 1); assert([POLICY.endpoint,POLICY.loopback].includes(row.url));
    assert.equal(Buffer.byteLength(row.requestText), row.requestBytes); assert.equal(sha(row.requestText), row.requestSha256);
    const raw = Buffer.from(row.responseBase64, 'base64'); assert.equal(raw.toString('base64'), row.responseBase64);
    assert(raw.length <= POLICY.responseBytes); assert.equal(raw.length, row.responseBytes); assert.equal(sha(raw), row.responseSha256); total += raw.length;
    for (const timing of [row.started, row.finished]) { assert(Number.isFinite(timing.wallMs) && Number.isFinite(timing.monotonicMs)); assert.equal(timing.elapsedMs, Math.max(timing.wallMs, timing.monotonicMs)); }
    row.request = JSON.parse(row.requestText);
    if (row.completeBody) { try { row.response = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { assert.equal(result.usable, false); } }
  }
  assert(total <= POLICY.totalBytes && total <= result.transport.responseBytes);
  for (const [i,row] of publicWires.entries()) {
    assert.equal(row.request.id, i + 1); assert.equal(row.request.jsonrpc, '2.0');
    assert(['eth_chainId','eth_getBlockByNumber','eth_getProof','eth_getCode'].includes(row.request.method));
    if (row.response) {
      assert.equal(row.response.jsonrpc, '2.0'); assert(Object.hasOwn(row.response, 'result') !== Object.hasOwn(row.response, 'error'));
      if (row.httpStatus === 200) assert.equal(row.response.id, row.request.id);
      else { assert.equal(result.usable, false); assert(row.error && Object.hasOwn(row.response, 'error') && !Object.hasOwn(row.response, 'result')); assert(row.response.id === null || row.response.id === row.request.id); }
    }
  }
  if (publicWires[0]) assert.deepEqual(publicWires[0].request, { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] });
  if (publicWires[1]) assert.deepEqual(publicWires[1].request, { jsonrpc: '2.0', id: 2, method: 'eth_getBlockByNumber', params: ['latest',false] });
  let verifiedAccounts = 0, native = null;
  if (paths.has('header.json')) {
    const header = read('header.json'); assert.equal(publicWires[0].response.result, '0xaa36a7'); assert.deepEqual(publicWires[1].response.result, header);
    const { verifyEthereumHeader } = await import('../../../engines/local-evm/ethereum-header.js');
    assert.deepEqual(verifyEthereumHeader({ header, expectedHash: header.hash, chainId: POLICY.chainId }), read('header-verification.json'));
    const inputs = publicWires.filter(row => row.phase === 'input');
    for (const row of inputs) {
      const p = row.request.params; assert(['eth_getProof','eth_getCode'].includes(row.request.method)); assert([POLICY.sender,POLICY.recipient].includes(p[0]));
      assert.deepEqual(p.at(-1), { blockHash: header.hash, requireCanonical: true });
      if (row.request.method === 'eth_getProof') assert.deepEqual(p[1], []);
    }
    if (paths.has('preview.json')) {
      const p = read('preview.json'); assert.deepEqual(result.preview, p);
      assert.equal(p.broker.records.length, inputs.length);
      const seal = read('PRODUCT_SEALED.json'); assert.equal(seal.previewSha256, sha(bytes('preview.json')));
      if (result.usable) assert(seal.timestamp.wallMs >= 0 && seal.timestamp.monotonicMs >= 0 && Math.max(seal.timestamp.wallMs,seal.timestamp.monotonicMs) < POLICY.productEndMs);
      assert(inputs.every(r => r.index <= seal.wireCount)); assert(publicWires.filter(r => r.phase === 'final_header').every(r => r.index > seal.wireCount));
      for (const [i, row] of p.broker.records.entries()) {
        assert.equal(row.id, i + 1); const wire = inputs[i]; assert(wire); assert.deepEqual(row.request, { method: wire.request.method, params: wire.request.params });
        if (row.status === 'received') { assert(Object.hasOwn(wire.response, 'result')); assert.equal(row.resultSha256, sha(JSON.stringify(wire.response.result))); assert.equal(row.resultBytes, Buffer.byteLength(JSON.stringify(wire.response.result))); }
        else assert.equal(row.status, 'unavailable');
      }
      if (p.preview?.inputs) {
        assert.equal(p.preview.inputEvidence.length, inputs.length);
        const { validateInputFacts } = await import('../../../engines/local-evm/input-facts.js');
        for (const view of [p.preview.original,p.preview]) {
          for (const e of view.inputEvidence) {
            const wire = inputs[e.id - 1]; assert(wire); assert.deepEqual(e.request, { method: wire.request.method, params: wire.request.params });
            if (Object.hasOwn(e,'result')) { assert(wire.response && Object.hasOwn(wire.response,'result')); assert.deepEqual(e.result, wire.response.result); }
            else assert(e.status === 'unavailable' || e.verification === 'rejected');
          }
          await validateInputFacts({ inputs: view.inputs, inputEvidence: view.inputEvidence, stateRoot: header.stateRoot, chainId: POLICY.chainId });
        }
        verifiedAccounts = Object.keys(p.preview.inputs.accounts).length;
      }
      if (result.usable) {
        assert.equal(p.status, 'completed'); assert.equal(p.preview.status, 'complete'); assert.equal(p.isolation.processClosed, true); assert.equal(p.isolation.exitCode, 0);
        assert.deepEqual(read('request.json'), { chainId: POLICY.chainId, request: REQUEST, queries: QUERIES, blockHash: header.hash });
        const original = p.preview.original.output; assert.equal(original.environment.chainId, POLICY.chainId); assert.equal(original.profile.executionBaseFee, '0'); assert.equal(original.feeAccounting, undefined);
        assert.equal(original.trace.type, 'CALL'); assert.equal(original.trace.from, REQUEST.from); assert.equal(original.trace.caller, REQUEST.from);
        assert.equal(original.trace.to, REQUEST.to); assert.equal(original.trace.executionAddress, REQUEST.to); assert.equal(original.trace.value, '0x' + BigInt(REQUEST.value).toString(16)); assert.equal(original.trace.input, REQUEST.data);
        assert.equal(original.execution.error, original.trace.error); assert.equal(original.execution.returnData, original.trace.output);
        const { ethereumCommon } = await import('../../../engines/local-evm/ethereum-profile.js');
        const { validateExecutionChanges } = await import('../../../engines/local-evm/execution-changes.js');
        const { deriveVerifiedGas } = await import('../../../engines/local-evm/gas-validation.js');
        const common = ethereumCommon(header, POLICY.chainId);
        deriveVerifiedGas({request:REQUEST,header,output:original,chainId:POLICY.chainId});
        validateExecutionChanges({changes:p.preview.original.changes,inputs:p.preview.original.inputs,output:original,sender:REQUEST.from,destination:REQUEST.to,common,request:REQUEST,header});
        assert.equal(p.preview.measurements.length, 2);
        const unit = { kind: 'native_wei', scale: '1000000000000000000' };
        native = p.preview.measurements.map((m,i) => { assert.equal(m.status, 'measured'); assert.deepEqual(m.identity, { kind: 'native_balance', account: QUERIES[i].account, chainId: String(POLICY.chainId) });
          assert.deepEqual(m.descriptor, QUERIES[i]); assert.equal(m.query, null); assert.equal(m.returnBytes, 0); assert.equal(m.values.length, 1);
          const value = m.values[0]; assert.equal(value.name, 'balance'); assert.deepEqual(value.unit, { kind: 'native_wei', scale: '1000000000000000000' });
          const account = QUERIES[i].account, initial = p.preview.inputs.accounts[account]; assert(initial && typeof initial.exists === 'boolean');
          const before = initial.exists ? BigInt(initial.balance) : 0n, change = p.preview.original.changes.accounts.find(row => row.address === account);
          const after = change?.existence?.after === false ? 0n : change?.balance ? BigInt(change.balance.after) : before;
          assert.equal(value.beforeRaw, before.toString()); assert.equal(value.afterRaw, after.toString()); assert.equal(value.deltaRaw, (after - before).toString());
          for (const [phase, expected] of [['before',before],['after',after]]) {
            const side = m[phase]; assert.equal(side.status, 'measured'); assert.equal(side.output, null); assert.equal(side.readMethod, 'proof_state_account_balance');
            assert.deepEqual(side.values, [{name:'balance',raw:expected.toString(),unit}]); assert.deepEqual(side.changesBefore, side.changesAfter);
            if (phase === 'before') assert.equal(side.changesBefore.accounts.length, 0); else assert.deepEqual(side.changesBefore, p.preview.original.changes);
          }
          return value; });
        if (original.execution.status === 'success') { assert.equal(native[0].deltaRaw, '-' + POLICY.value); assert.equal(native[1].deltaRaw, POLICY.value); }
        else { assert(['failed','reverted'].includes(original.execution.status)); assert(native.every(v => v.deltaRaw === '0')); }
      }
    }
    if (result.headerConfirmed) { assert.deepEqual(read('final-header.json'), header); const final = publicWires.find(r => r.phase === 'final_header'); assert.deepEqual(final.request.params, [header.number,false]); assert.deepEqual(final.response.result, header); }
    const http = wires.find(r => r.phase === 'public_http');
    if (http) { assert.equal(http.url, POLICY.loopback); assert.deepEqual(http.request, {chainId:POLICY.chainId,...REQUEST,block:header.hash,queries:QUERIES}); assert.equal(result.publicHttp.httpStatus,http.httpStatus); if (http.response) assert.deepEqual(result.publicHttp.response,http.response); assert.deepEqual(read('public-http.json'), {request:http.request,...result.publicHttp}); }
  }
  if (result.usable) {
    assert(result.headerConfirmed && result.sourceUnchanged && result.transport.complete && result.transport.withinDeadline && result.error === null);
    assert.equal(result.transport.active, 0); assert.equal(result.transport.cancelling, 0); assert.equal(result.transport.hardFailure, null);
    const last = result.transport.terminalAfterIntegrity; assert(last.wallMs >= 0 && last.monotonicMs >= 0 && Math.max(last.wallMs,last.monotonicMs) <= POLICY.totalMs);
  }
  return { artifactOnly: true, targetReexecuted: false, networkRequests: 0, manifestSha256, sourceSha256: plan.sourceSha256,
    files: paths.size, publicRequests: publicWires.length, verifiedAccounts, status: result.status, usable: result.usable,
    execution: result.preview?.preview?.original?.output?.execution ?? null, native, publicHttp: result.publicHttp };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) console.log(JSON.stringify(await verifyEvidence({ directory: process.argv[2], manifestSha256: process.argv[3] }), null, 2));
