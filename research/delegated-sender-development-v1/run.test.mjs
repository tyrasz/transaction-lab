import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTimingGate, executeFixedCases, finiteDrain, freezeRun, loadPlan, POLICY } from './run.mjs';
import { sha, copyOriginalInputs, verifyOriginalInputs, readRecordedOracle, fixedRequests, ORIGINAL_MANIFEST_SHA } from './inputs.mjs';
import { semanticAttempt, savedInputTransport, validateReplayMetadata, validateTerminalTiming } from './verify.mjs';
import { adjudicateLocalOutcome, oracleRequests } from './outcomes.mjs';
import { createCohortTransport, createCohortWireBudget } from '../standard-evm/cohort-wire.mjs';
import { executeIsolatedEthereumCall } from '../../engines/local-evm/isolated-call.js';
import { lifecycleFixture, SENDER } from '../../engines/local-evm/test/lifecycle-fixture.js';
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const temp = t => { const path = mkdtempSync('/tmp/delegated-development-test-'); t.after(() => rmSync(path, { recursive: true, force: true })); return path; };

test('fixed inherited membership, requests and eight exact oracle wires are bound without local outcomes', t => {
  const outputDirectory = temp(t), originalDirectory = join(ROOT, 'reports/ordinary-local-coverage-v1');
  const inputs = copyOriginalInputs({ originalDirectory, outputDirectory });
  assert.equal(inputs.originalManifestSha256, ORIGINAL_MANIFEST_SHA); assert.deepEqual(inputs.cases.map(c => c.id), ['002', '015']);
  assert.equal(inputs.files.some(f => f.path.endsWith('/local.json')), false);
  assert.deepEqual(verifyOriginalInputs({ outputDirectory, expected: inputs }), inputs);
  for (const item of inputs.cases) assert.equal(readRecordedOracle({ outputDirectory, item }).records.length, 4);
  const path = join(outputDirectory, 'inputs/original/cases/002/request.json'); chmodSync(path, 0o644); const value = JSON.parse(readFileSync(path)); value.projection.request.value = '1'; writeFileSync(path, JSON.stringify(value));
  assert.throws(() => verifyOriginalInputs({ outputDirectory, expected: inputs }), /original_input_differs/);
});

test('absolute deadline and backwards clocks stop dispatch without replacing fixed slots', () => {
  let wall = 1000, mono = 0; const gate = createTimingGate({ now: () => wall, monotonic: () => mono });
  assert.equal(gate.remaining(), POLICY.dispatchMs); wall += POLICY.dispatchMs + 1; assert.equal(gate.remaining(), 0);
  wall = 1000; const bad = createTimingGate({ now: () => wall, monotonic: () => mono }); wall--; assert.equal(bad.remaining(), 0);
});

test('terminal verdict binds both clocks, latches reversals, and never extends drainage', () => {
  for (const clock of ['wall', 'mono']) {
    const current = { wall: 1000, mono: 20 }, gate = createTimingGate({ now: () => current.wall, monotonic: () => current.mono });
    current[clock] += POLICY.dispatchMs + POLICY.terminalDrainMs;
    assert.equal(gate.terminal().status, 'within_budget'); current[clock]++;
    assert.equal(gate.terminal().status, 'overrun');
  }
  for (const clock of ['wall', 'mono']) {
    const current = { wall: 1000, mono: 20 }, gate = createTimingGate({ now: () => current.wall, monotonic: () => current.mono });
    current[clock] += 10; gate.remaining(); current[clock]--;
    assert.equal(gate.remaining(), 0); current[clock] += 2;
    assert.equal(gate.terminal().status, 'clock_invalid');
  }
  let mono = 0; const gate = createTimingGate({ now: () => 1000, monotonic: () => mono }); mono = NaN;
  assert.deepEqual(gate.terminal(), { status: 'clock_invalid', clockValid: false, limitMs: 355000, wallStartedAtMs: 1000, wallFinishedAtMs: 1000, wallElapsedMs: 0, monotonicElapsedMs: null });
  const result = { startedAt: new Date(1000).toISOString(), finishedAt: new Date(2000).toISOString(), executionWindowMs: 500,
    terminalTiming: { status: 'within_budget', clockValid: true, limitMs: 355000, wallStartedAtMs: 1000, wallFinishedAtMs: 1500, wallElapsedMs: 500, monotonicElapsedMs: 500 } };
  assert.doesNotThrow(() => validateTerminalTiming(result, POLICY));
  for (const change of [x => { x.terminalTiming.clockValid = false; }, x => { x.executionWindowMs++; }, x => { x.terminalTiming.wallElapsedMs++; }, x => { x.terminalTiming.wallStartedAtMs--; }]) {
    const bad = structuredClone(result); change(bad); assert.throws(() => validateTerminalTiming(bad, POLICY), /Terminal timing/);
  }
});

const timedAttempt = () => ({ status: 'completed', isolation: { childPid: 2, durationMs: 3, processClosed: true, exitCode: 0, exitSignal: null,
  wallMs: 145000, drainMs: 25000, limits: { wallMs: 145000, drainMs: 25000, killWaitMs: 1000 } },
  inputEvidence: [{ durationMs: 4, result: '0x' }], broker: { records: [{ durationMs: 5, status: 'received' }] }, changes: { nonce: '2' } });
test('replay exclusion validates bounded timing and spawned child identity first', () => {
  assert.doesNotThrow(() => validateReplayMetadata(timedAttempt()));
  for (const duration of [-1, NaN, Infinity, null, '2', 171001]) for (const target of ['isolation', 'input', 'broker']) {
    const attempt = timedAttempt(), row = target === 'isolation' ? attempt.isolation : target === 'input' ? attempt.inputEvidence[0] : attempt.broker.records[0];
    row.durationMs = duration; assert.throws(() => semanticAttempt(attempt), /duration/);
  }
  for (const pid of [null, 0, -1, 1.5, '2']) { const attempt = timedAttempt(); attempt.isolation.childPid = pid; assert.throws(() => semanticAttempt(attempt), /PID|identity/); }
  const attempt = timedAttempt(); delete attempt.isolation.durationMs; assert.throws(() => semanticAttempt(attempt), /duration/);
});

test('unexpected local failure retains both fixed slots and never opens the oracle', async () => {
  const cases = fixedRequests(join(ROOT, 'reports/ordinary-local-coverage-v1')); let oracleReads = 0;
  const result = await executeFixedCases({ cases, implementation: {}, executeLocal: async () => { throw Error('injected'); }, readOracle: () => { oracleReads++; }, save() {}, hashArtifact() {}, canAttempt: () => true, assertHealthy() {} });
  assert.equal(result.status, 'interrupted'); assert.deepEqual(result.rows.map(r => [r.id, r.status]), [['002', 'interrupted'], ['015', 'not_attempted']]); assert.equal(oracleReads, 0);
});

test('local save failure prevents oracle parsing and finite drainage cannot hang', async () => {
  const cases = fixedRequests(join(ROOT, 'reports/ordinary-local-coverage-v1')); let oracleReads = 0;
  const result = await executeFixedCases({ cases, implementation: {}, executeLocal: async () => ({ transportWireIds: [] }), readOracle: () => { oracleReads++; }, save(path) { if (path.endsWith('/local.json')) throw Object.assign(Error(), { code: 'artifact_save_failed' }); }, hashArtifact() {}, canAttempt: () => true, assertHealthy() {} });
  assert.equal(result.fatal.code, 'artifact_save_failed'); assert.equal(oracleReads, 0);
  assert.equal(await finiteDrain([{ drain: () => new Promise(() => {}) }], 5), false);
});

test('saved-input replay latches a mismatched request even if the engine catches it', async () => {
  const wire = { profile: 'local', request: { method: 'eth_getCode', params: ['a'] }, status: 'completed', parsed: { result: '0x' } };
  const play = savedInputTransport([wire]); await assert.rejects(play.rpc.call('eth_getProof', ['a'])); assert.throws(play.check, /sequence differs/);
  const failed = savedInputTransport([{ ...wire, status: 'failed', error: 'rpc_error' }]); await assert.rejects(failed.rpc.call('eth_getCode', ['a']), { code: 'rpc_error' }); assert.doesNotThrow(failed.check);
  const incomplete = savedInputTransport([wire]); assert.throws(incomplete.check, /not fully consumed/);
  const a = timedAttempt();
  const b = structuredClone(a); b.isolation.childPid = 99; b.inputEvidence[0].durationMs = 999;
  assert.deepEqual(semanticAttempt(a), semanticAttempt(b)); b.changes.nonce = '3'; assert.notDeepEqual(semanticAttempt(a), semanticAttempt(b));
});

test('adapted comparator accepts a real delegated child and rejects nonce, metadata, and raw-oracle substitutions', async () => {
  const delegate = '0x4444444444444444444444444444444444444444', f = await lifecycleFixture({ accounts: { [SENDER]: { nonce: 1n, balance: 1000000n, code: '0xef0100' + delegate.slice(2) }, [delegate]: { nonce: 1n, code: '0x00' } } }); f.request.to = SENDER;
  const attempt = await executeIsolatedEthereumCall({ request: f.request, header: f.header, rpc: f.rpc }); assert.equal(attempt.status, 'completed'); assert.equal(attempt.output.execution.status, 'success');
  const implementation = { name: 'Synthetic isolated test', version: 'test', sourceSha256: 'a'.repeat(64), sourceFiles: ['synthetic.js'] };
  const local = { dispatch: 'completed', implementation, attempt }, expected = oracleRequests({ request: f.request, header: f.header });
  const responses = [f.header, { type: 'CALL', from: SENDER, to: SENDER, input: '0x', output: '0x', value: '0x0', gas: '0x4c4b40', gasUsed: '0x' + BigInt(attempt.output.gasAccounting.gasUsed).toString(16) }, { pre: { [SENDER]: { nonce: 1 } }, post: { [SENDER]: { nonce: 2 } } }, f.header];
  let cursor = 0; const wire = createCohortTransport({ budget: createCohortWireBudget(), profile: 'product', provider: 'drpc', blockHash: f.header.hash, fetchImpl: async (_url, options) => { const request = JSON.parse(options.body); assert.equal(request.method, expected[cursor].method); assert.deepEqual(request.params, expected[cursor].params); return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: responses[cursor++] })); } });
  for (const item of expected) await wire.call(item.method, item.params); const oracle = { dispatch: 'completed', records: wire.records() };
  const input = { transactionHash: '0x' + '11'.repeat(32), request: f.request, header: f.header, expectedLocalImplementation: implementation, local, oracle };
  assert.equal((await adjudicateLocalOutcome(input)).outcome.comparison, 'match');
  for (const change of [i => { i.local.attempt.changes.accounts[0].nonce.after = '0x3'; }, i => { i.local.attempt.output.semantics.senderDelegation.address = SENDER; }, i => { i.oracle.records[1].parsed.result.output = '0x01'; }, i => { i.local.attempt.inputs.accounts[SENDER].code = '0x'; }]) {
    const bad = structuredClone(input); change(bad); assert.notEqual((await adjudicateLocalOutcome(bad)).outcome.comparison, 'match');
  }
});

// Disposable source archive only. Public fetch is replaced before dispatch and
// every proof request returns a synthetic provider error. No target EVM runs.
test('archived driver retains two failed proofs, seals once, and offline replay preserves unavailable outcomes', async t => {
  const outputDirectory = join(temp(t), 'capture'), frozen = await freezeRun({ repoRoot: ROOT, outputDirectory });
  const loaded = await loadPlan({ outputDirectory, expectedPlanSha256: frozen.planSha256 }); assert.deepEqual(loaded.plan.policy, POLICY);
  const runner = await import(pathToFileURL(join(outputDirectory, 'runtime', 'research/delegated-sender-development-v1/run.mjs'))), realFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async (_url, options) => { calls++; const request = JSON.parse(options.body); assert.equal(request.method, 'eth_getProof'); assert.deepEqual(request.params[1], []); return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'synthetic unavailable proof' } })); };
  let result;
  try {
    result = await runner.runFrozen({ outputDirectory, expectedPlanSha256: frozen.planSha256 });
    assert.equal(result.terminalTiming.status, 'within_budget'); assert.equal(result.terminalTiming.monotonicElapsedMs, result.executionWindowMs);
    assert.equal(result.status, 'complete', JSON.stringify(result.failures)); assert.equal(calls, 2); assert.equal(result.caseRun.rows.length, 2);
    assert(result.caseRun.rows.every(r => r.outcome.execution === 'provider_unavailable' && r.outcome.comparison === 'not_comparable'));
    for (const id of ['002', '015']) assert(existsSync(join(outputDirectory, `cases/${id}/LOCAL_SEALED.json`)));
    await assert.rejects(runner.runFrozen({ outputDirectory, expectedPlanSha256: frozen.planSha256 }), { code: 'artifact_save_failed' }); assert.equal(calls, 2);
  } finally { globalThis.fetch = realFetch; }
  const verifier = await import(pathToFileURL(join(outputDirectory, 'runtime', 'research/delegated-sender-development-v1/verify.mjs')));
  globalThis.fetch = async () => { throw Error('Offline audit cannot use public network'); };
  try {
    const args = { outputDirectory, expectedManifestSha256: result.evidence.manifestSha256, expectedPlanSha256: frozen.planSha256, replay: true };
    const verified = await verifier.verifyEvidence(args); assert.equal(verified.status, 'verified'); assert.equal(verified.replayed, 2); assert.equal(verified.freshInputWires, 2);
    await assert.rejects(verifier.verifyEvidence({ ...args, expectedPlanSha256: '0'.repeat(64) }));
    const manifestPath = join(outputDirectory, 'evidence-manifest.json'), manifestBytes = readFileSync(manifestPath);
    chmodSync(manifestPath, 0o644);
    for (const [path, change, resealLocal] of [
      ['cases/002/LOCAL_SEALED.json', x => { x.sha256 = '0'.repeat(64); }],
      ['cases/002/outcome.json', x => { x.outcome.comparison = 'match'; }],
      ['cases/002/local.json', x => { x.transportWireIds = [2]; }],
      ['wire/000001.json', x => { x.parsed.error.code = 1; }],
      ['cases/002/RECORDED_ORACLE_USED.json', x => { x.at = '2000-01-01T00:00:00.000Z'; }],
      ['results.json', x => { x.scope.heldOut = true; }],
      ['results.json', x => { x.executionWindowMs = 355001; x.durationMs = 355001; x.terminalTiming.monotonicElapsedMs = 355001; }],
      ['results.json', x => { x.terminalTiming.wallFinishedAtMs = x.terminalTiming.wallStartedAtMs + 355001; x.terminalTiming.wallElapsedMs = 355001; x.finishedAt = new Date(x.terminalTiming.wallFinishedAtMs).toISOString(); }],
      ['results.json', x => { x.terminalTiming.clockValid = false; }],
      ['cases/002/local.json', x => { x.attempt.isolation.childPid = 0; }, true],
      ['cases/002/local.json', x => { x.attempt.isolation.durationMs = 171001; }, true],
      ['cases/002/local.json', x => { x.attempt.inputEvidence[0].durationMs = null; }, true],
      ['cases/002/local.json', x => { x.attempt.broker.records[0].durationMs = -1; }, true],
    ]) {
      const absolute = join(outputDirectory, path), original = readFileSync(absolute); chmodSync(absolute, 0o644); writeFileSync(absolute, JSON.stringify(changeValue(JSON.parse(original), change)));
      // Rehash the disposable outer inventory to reach semantic binding checks.
      // The independently frozen plan/original-report hashes remain unchanged.
      const changed = readFileSync(absolute), manifest = JSON.parse(manifestBytes), row = manifest.files.find(f => f.path === path);
      Object.assign(row, { bytes: changed.length, sha256: sha(changed) });
      const sealPath = 'cases/002/LOCAL_SEALED.json', sealAbsolute = join(outputDirectory, sealPath), originalSeal = readFileSync(sealAbsolute);
      if (resealLocal) {
        const seal = JSON.parse(originalSeal); Object.assign(seal, { bytes: changed.length, sha256: sha(changed) }); chmodSync(sealAbsolute, 0o644); writeFileSync(sealAbsolute, JSON.stringify(seal));
        const sealBytes = readFileSync(sealAbsolute); Object.assign(manifest.files.find(f => f.path === sealPath), { bytes: sealBytes.length, sha256: sha(sealBytes) });
      }
      writeFileSync(manifestPath, JSON.stringify(manifest));
      await assert.rejects(verifier.verifyEvidence({ ...args, replay: false, expectedManifestSha256: sha(readFileSync(manifestPath)) }));
      writeFileSync(absolute, original); if (resealLocal) writeFileSync(sealAbsolute, originalSeal); writeFileSync(manifestPath, manifestBytes);
    }
  } finally { globalThis.fetch = realFetch; }
});
function changeValue(value, change) { change(value); return value; }

// Clock injection changes only the terminal wall observation after the final
// synthetic failed input. It must suppress already-retained comparisons.
test('archived driver with a terminal wall overrun retains cases but withholds comparisons', async t => {
  const outputDirectory = join(temp(t), 'capture'), frozen = await freezeRun({ repoRoot: ROOT, outputDirectory });
  const runner = await import(pathToFileURL(join(outputDirectory, 'runtime', 'research/delegated-sender-development-v1/run.mjs')));
  const realFetch = globalThis.fetch, realNow = Date.now; let calls = 0, jump = 0;
  Date.now = () => realNow() + jump;
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body); assert.equal(request.method, 'eth_getProof');
    if (++calls === 2) jump = 355001;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'synthetic unavailable proof' } }));
  };
  try {
    const result = await runner.runFrozen({ outputDirectory, expectedPlanSha256: frozen.planSha256 });
    assert.equal(calls, 2); assert.equal(result.status, 'interrupted'); assert.equal(result.comparisonsUsable, false);
    assert.equal(result.terminalTiming.status, 'overrun'); assert(result.terminalTiming.wallElapsedMs > 355000);
    assert(result.failures.some(f => f.code === 'terminal_deadline_exceeded')); assert.equal(result.caseRun.rows.length, 2);
    assert(result.caseRun.rows.every(r => r.status === 'retained'));
  } finally { globalThis.fetch = realFetch; Date.now = realNow; }
});
