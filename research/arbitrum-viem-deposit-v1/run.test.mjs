import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { executeScenario } from './run.mjs';
import { createRecordingTransport } from './transport.mjs';
import { save, text, sha, artifactWriter, inventory, SOURCE_ROOTS } from './artifacts.mjs';
import { verifyEvidence, verifyWire, replayRecorded } from './verify.mjs';
import { LIMITS, STATIC_CODE, USDC, ZERO, originalCall, validateRequest, balanceData } from './policy.mjs';

const scenario = JSON.parse(fs.readFileSync(new URL('./scenario.json', import.meta.url)));
const word = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const header = { number: '0x1234', hash: '0x' + 'ab'.repeat(32), parentHash: '0x' + 'cd'.repeat(32), timestamp: '0x6789', transactions: [], gasLimit: '0x4000000', gasUsed: '0x0', baseFeePerGas: '0x1' };
function fakeRpc(options = {}) {
  const requests = []; let simulations = 0;
  return { requests, fetch: async (url, init) => {
    assert.equal(url, 'https://arb1.arbitrum.io/rpc'); assert.equal(init.redirect, 'error');
    const r = JSON.parse(init.body); requests.push(r); let result;
    if (r.method === 'eth_chainId') result = '0xa4b1';
    else if (r.method === 'eth_getBlockByNumber') result = options.changedHeader && r.params[0] !== 'latest' ? { ...header, hash: '0x' + '99'.repeat(32) } : header;
    else if (r.method === 'eth_getCode') result = '0xef0100' + '42'.repeat(20);
    else if (r.method === 'eth_getBalance') result = '0x0';
    else if (r.method === 'eth_call') result = r.params[0].to === USDC ? word(0) : r.params[0].to ? '0x' : word(0);
    else if (r.method === 'eth_simulateV1') {
      simulations++;
      if (options.rpcFailure) return Response.json({ jsonrpc: '2.0', id: r.id, error: { code: -32000, message: 'synthetic unavailable' } });
      result = r.params[0].blockStateCalls.map((block, i) => ({ ...header, number: '0x' + (0x1235 + i).toString(16),
        calls: block.calls.map((_call, j) => ({ status: options.revert && i === 0 && j === 0 ? '0x0' : '0x1', returnData: i === 1 ? word(0) : '0x', gasUsed: '0x5208', logs: [] })) }));
    } else throw Error('Unexpected fake method');
    return Response.json({ jsonrpc: '2.0', id: r.id, result });
  }, simulations: () => simulations };
}
async function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrum-viem-offline-'));
  const write = (name, value) => save(root, name, value), rpc = fakeRpc(options);
  const recorder = createRecordingTransport({ scenario, save: write, fetchImpl: rpc.fetch });
  const result = await executeScenario({ scenario, recorder, write });
  return { root, result, rpc };
}
test('actual pinned viem runs exact request and code-only probes against synthetic responses, without repairing zero funds', async () => {
  const f = await fixture();
  try {
    assert.equal(f.result.status, 'observed', text(f.result)); assert.equal(f.result.usable, true); assert.equal(f.rpc.simulations(), 2);
    assert.equal(f.result.prechecks[3].value, '0xef0100' + '42'.repeat(20));
    const calls = f.rpc.requests.filter(r => r.method === 'eth_simulateV1');
    for (const r of calls) assert.deepEqual(r.params[0].blockStateCalls[0].calls[0], originalCall(scenario));
    assert.equal(f.result.viem.result.results[0].status, 'success');
    assert.equal(f.result.transport.calls, 11); assert.equal(f.result.transport.deniedCount, 0);
    assert.equal(f.result.transport.measurementOverrides.length, 5);
    assert.ok(f.result.transport.measurementOverrides.every(o => o.fields.join() === 'code' && o.codeSha256 === sha(Buffer.from(STATIC_CODE.slice(2), 'hex'))));
    assert.equal(calls[1].params[0].blockStateCalls[1].calls[0].gas, undefined);
    assert.equal(calls[1].params[0].blockStateCalls[0].calls[1].gas, undefined);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
test('actual viem retains a reverted exact call, and one RPC rejection is never retried', async () => {
  for (const options of [{ revert: true }, { rpcFailure: true }]) {
    const f = await fixture(options);
    try {
      assert.equal(f.result.headerConfirmed, true); assert.equal(f.result.usable, true);
      if (options.revert) { assert.equal(f.result.viem.result.results[0].status, 'failure'); assert.match(fs.readFileSync(path.join(f.root, 'viem-output.json'), 'utf8'), /ContractFunctionExecutionError/); }
      else { assert.equal(f.result.status, 'viem_unavailable'); assert.equal(f.rpc.simulations(), 1); assert.match(f.result.viem.error.message, /synthetic unavailable/); }
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});
test('changed final header withholds confirmation and decoded interpretation', async () => {
  const f = await fixture({ changedHeader: true });
  try { assert.equal(f.result.usable, false); assert.equal(f.result.status, 'unconfirmed'); assert.ok(f.result.viem.result); }
  finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
test('early sibling failure retains the final header but discarded queued probes withhold usable interpretation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrum-viem-siblings-'));
  try {
    const write = (name, value) => save(root, name, value), rpc = fakeRpc(); let simulations = 0;
    const recorder = createRecordingTransport({ scenario, save: write, fetchImpl: (url, init) => {
      const r = JSON.parse(init.body);
      if (r.method !== 'eth_simulateV1') return rpc.fetch(url, init);
      if (++simulations === 1) return Promise.resolve(Response.json({ jsonrpc: '2.0', id: r.id, error: { code: -32000, message: 'synthetic sibling failure' } }));
      return new Promise((_resolve, reject) => { init.signal.addEventListener('abort', () => reject(Error('aborted sibling')), { once: true }); if (init.signal.aborted) reject(Error('aborted sibling')); });
    } });
    const result = await executeScenario({ scenario, recorder, write, invoke: async () => {
      const request = { method: 'eth_simulateV1', params: [{ blockStateCalls: [{ calls: [originalCall(scenario)] }], traceTransfers: true, validation: false }, header.number] };
      return Promise.all([recorder.request(request), recorder.request(request), recorder.request(request)]);
    } });
    assert.equal(result.headerConfirmed, true); assert.equal(result.drain.complete, true); assert.ok(result.transport.discardedCount > 0);
    assert.equal(result.usable, false); assert.equal(result.status, 'unconfirmed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('policy rejects wallet/storage overrides, altered envelope, other blocks and unlisted methods before fetch', async () => {
  const good = { method: 'eth_simulateV1', params: [{ blockStateCalls: [{ calls: [originalCall(scenario)] }], validation: false, traceTransfers: true }, header.number], phase: 'viem', selected: header, scenario };
  validateRequest(good);
  for (const mutate of [r => r.params[0].blockStateCalls[0].calls[0].from = ZERO, r => r.params[0].blockStateCalls[0].calls[0].gas = '0x1e8481',
    r => r.params[0].blockStateCalls[0].stateOverrides = { [scenario.from]: { balance: '0xffff' } }, r => r.params[1] = 'latest', r => r.method = 'eth_sendRawTransaction']) {
    const r = structuredClone(good); mutate(r); assert.throws(() => validateRequest(r));
  }
  let dispatch = 0; const recorder = createRecordingTransport({ scenario, save: () => ({}), fetchImpl: async () => { dispatch++; } });
  await assert.rejects(recorder.request({ method: 'eth_sendRawTransaction', params: [] })); assert.equal(dispatch, 0); assert.equal(recorder.snapshot().calls, 0);
});
test('response caps retain bounded prefixes, invalid UTF-8 is unavailable and no result is invented', async () => {
  for (const body of [Buffer.alloc(LIMITS.responseBytes + 1, 32), Buffer.from([0xff, 0xfe])]) {
    const retained = new Map(), recorder = createRecordingTransport({ scenario, save: (name, value) => { retained.set(name, value); return { path: name }; }, fetchImpl: async () => new Response(body) });
    await assert.rejects(recorder.request({ method: 'eth_chainId', params: [] }));
    assert.ok(retained.get('wire/001-response.body').length <= LIMITS.responseBytes); assert.equal(recorder.snapshot().exchanges[0].status, 'unavailable');
    if (body.length > LIMITS.responseBytes) assert.equal(recorder.snapshot().hardFailure, 'Response byte budget exceeded.');
  }
});
test('explicit cancellation settles retained evidence while a late adapter cannot append output', async () => {
  const retained = new Map(); let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const recorder = createRecordingTransport({ scenario, save: (name, value) => { retained.set(name, structuredClone(value)); return { path: name }; }, fetchImpl: () => { entered(); return new Promise(resolve => { release = resolve; }); } });
  const request = recorder.request({ method: 'eth_chainId', params: [] }); await started; recorder.endPhase();
  await assert.rejects(request); const before = [...retained.entries()]; assert.equal((await recorder.drain()).complete, false); recorder.finish();
  release(Response.json({ jsonrpc: '2.0', id: 1, result: '0xa4b1' })); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...retained.entries()], before); await assert.rejects(recorder.request({ method: 'eth_chainId', params: [] }));
});
test('wall reversal and overall expiry deny dispatch; phase cancellation discards queued requests', async () => {
  for (const later of [-1, LIMITS.overallMs + 1]) {
    let clock = 100; let calls = 0; const recorder = createRecordingTransport({ scenario, save: () => ({}), now: () => clock, wall: () => clock, fetchImpl: async () => { calls++; } });
    clock += later; await assert.rejects(recorder.request({ method: 'eth_chainId', params: [] })); assert.equal(calls, 0); assert.equal(recorder.snapshot().withinBounds, false);
  }
  let dispatch = 0; const recorder = createRecordingTransport({ scenario, save: () => ({}), fetchImpl: async () => { dispatch++; return Response.json({ jsonrpc: '2.0', id: dispatch, result: '0xa4b1' }); } });
  const request = recorder.request({ method: 'eth_chainId', params: [] }); recorder.endPhase(); await assert.rejects(request); assert.equal(dispatch, 0); assert.equal(recorder.snapshot().discardedCount, 1);
});

test('viem request count and in-flight deadline preserve the final read, and body cancellation remains visible', async () => {
  let clock = 0, id = 0;
  const recorder = createRecordingTransport({ scenario, save: () => ({}), now: () => clock, wall: () => clock, fetchImpl: async () => Response.json({ jsonrpc: '2.0', id: ++id, result: header }) });
  recorder.pin(header); recorder.setPhase('viem');
  const request = { method: 'eth_simulateV1', params: [{ blockStateCalls: [{ calls: [originalCall(scenario)] }], validation: false, traceTransfers: true }, header.number] };
  for (let i = 0; i < 19; i++) await recorder.request(request);
  await assert.rejects(recorder.request(request)); assert.equal(recorder.snapshot().hardFailure, null);
  recorder.setPhase('final'); await recorder.request({ method: 'eth_getBlockByNumber', params: [header.number, false] }); assert.equal(recorder.snapshot().calls, 20);

  let releaseCancel; const cancelStarted = new Promise(resolve => { releaseCancel = resolve; }); let settleCancel, entered;
  const enteredFetch = new Promise(resolve => { entered = resolve; });
  const late = createRecordingTransport({ scenario, save: () => ({}), now: () => clock, wall: () => clock, fetchImpl: async (_url, init) => {
    entered(); return { status: 200, ok: true, headers: new Headers(), body: { getReader: () => ({
      read: () => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Error('aborted')), { once: true })),
      cancel: () => { releaseCancel(); return new Promise(resolve => { settleCancel = resolve; }); },
    }) } };
  } });
  late.pin(header); late.setPhase('viem'); clock = LIMITS.viemDispatchMs - 15;
  const pending = late.request(request); await enteredFetch; await assert.rejects(pending); await cancelStarted;
  assert.equal((await late.drain()).complete, false); assert.equal(late.snapshot().calls, 1);
  settleCancel(); await new Promise(resolve => setImmediate(resolve)); assert.equal((await late.drain()).complete, true);
});

test('durable artifact writer detects substitution and latches save failure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrum-viem-ledger-'));
  try {
    const writer = artifactWriter(root); writer.write('one.json', { value: 1 }); writer.verify();
    fs.writeFileSync(path.join(root, 'one.json'), text({ value: 2 })); assert.throws(() => writer.verify(), /changed/);
    assert.throws(() => writer.write('one.json', {})); assert.throws(() => writer.write('two.json', {})); assert.equal(fs.existsSync(path.join(root, 'two.json')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('offline raw replay matches success/revert/provider rejection and rejects resealed decoded changes', async () => {
  for (const options of [{}, { revert: true }, { rpcFailure: true }]) {
    const f = await fixture(options);
    try {
      f.result.sourceUnchanged = true;
      const { records } = verifyWire({ capture: f.root, result: f.result, scenario });
      assert.equal((await replayRecorded({ capture: f.root, result: f.result, scenario, records })).status, 'matched');
      const changed = JSON.parse(text(f.result)); changed.viem = { ...changed.viem, result: { results: [{ status: 'success', data: '0x1234' }], assetChanges: [] } };
      await assert.rejects(replayRecorded({ capture: f.root, result: changed, scenario, records }));
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('disposable complete source freeze and evidence verify portably, rejecting raw and resealed semantic tampering', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrum-viem-freeze-')); let root = path.join(temporary, 'original'); fs.mkdirSync(root);
  try {
    const sourceRoot = path.dirname(fileURLToPath(import.meta.url));
    for (const name of SOURCE_ROOTS) fs.cpSync(path.join(sourceRoot, name), path.join(root, name), { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE });
    const prepared = spawnSync(process.execPath, [path.join(root, 'prepare.mjs')], { encoding: 'utf8', timeout: 30000 }); assert.equal(prepared.status, 0, prepared.stderr);
    const planBytes = fs.readFileSync(path.join(root, 'plan.json')), plan = JSON.parse(planBytes), planSha = sha(planBytes);
    const capture = path.join(root, 'capture'); fs.mkdirSync(capture); const writer = artifactWriter(capture);
    writer.write('STARTED.json', { schemaVersion: 1, startedAt: new Date().toISOString(), pid: process.pid, planSha256: planSha, sourceManifestSha256: plan.sourceManifestSha256 });
    const rpc = fakeRpc(), recorder = createRecordingTransport({ scenario, save: writer.write, fetchImpl: rpc.fetch });
    const result = await executeScenario({ scenario, recorder, write: writer.write });
    Object.assign(result, { sourceUnchanged: true, planSha256: planSha, sourceManifestSha256: plan.sourceManifestSha256, scope: plan.scope, finishedAt: new Date().toISOString() });
    writer.write('results.json', result); writer.write('measurement-overrides.json', result.transport.measurementOverrides); writer.verify();
    const manifest = { schemaVersion: 1, planSha256: planSha, sourceManifestSha256: plan.sourceManifestSha256, files: inventory(capture, fs.readdirSync(capture)) };
    const manifestEntry = writer.write('evidence-manifest.json', manifest); writer.verify();
    const relocated = path.join(temporary, 'relocated'); fs.renameSync(root, relocated); root = relocated;
    const args = { root, expectedManifestSha256: manifestEntry.sha256, expectedPlanSha256: planSha };
    assert.equal((await verifyEvidence(args)).replay.status, 'matched');
    const wirePath = path.join(root, 'capture/wire/007-request.json'), original = fs.readFileSync(wirePath);
    fs.appendFileSync(wirePath, ' '); await assert.rejects(verifyEvidence(args)); fs.writeFileSync(wirePath, original);
    const changed = JSON.parse(text(result)); changed.viem.result.results[0].gasUsed = '1';
    fs.writeFileSync(path.join(root, 'capture/results.json'), text(changed));
    const changedManifest = { ...manifest, files: inventory(path.join(root, 'capture'), fs.readdirSync(path.join(root, 'capture')).filter(n => n !== 'evidence-manifest.json')) };
    fs.writeFileSync(path.join(root, 'capture/evidence-manifest.json'), text(changedManifest));
    await assert.rejects(verifyEvidence({ ...args, expectedManifestSha256: sha(text(changedManifest)) }));
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

export { fixture, scenario, header };
