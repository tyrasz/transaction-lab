import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { executeIsolatedEthereumPreview } from '../isolated-call.js';
import { EMPTY_CODE_HASH, verifyStateProof } from '../verified-state-proof.js';

// Public saved development inputs, never provider traces/diffs as input state.
// The saved request order is retained after removing only independently
// reverified empty-code reads; no saved execution result enters the child.
const PACKET = new URL('../../../reports/ethereum-lending-local-reference/', import.meta.url);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = name => readFileSync(new URL(name, PACKET));
const manifestBytes = read('manifest.json');
assert.equal(sha(manifestBytes), '34b1e325ea08604705e50f06da81e442bb48cea017faf3058671e1e1a4e8f8c5');
const manifest = JSON.parse(manifestBytes);
function fixtureJSON(name, hash) {
  const bytes = read(name), entry = manifest.files.find(row => row.path === name);
  assert.equal(sha(bytes), hash); assert.equal(entry.sha256, hash); assert.equal(entry.bytes, bytes.length);
  return JSON.parse(bytes);
}
const plan = fixtureJSON('plan.json', 'f9fb0e1b465bcf191185e1790204bf64a324634d98436ebb4a17f4cb6cd83288');
const c = plan.cases[0]; assert.equal(c.id, 'aave-usdc-supply-with-permit');
const recorded = fixtureJSON('aave-usdc-supply-with-permit-local.json', '1cbe7eeca94e528b9d5cda932524e65c0cbf6b08fb08c962aca36841dfaa1763');
const morpho = plan.cases[1]; assert.equal(morpho.id, 'morpho-kiln-usdc-deposit');
const morphoRecorded = fixtureJSON('morpho-kiln-usdc-deposit-local.json', '4e85c6c4daa5ebbb0e38536ed8b78ea5ce105adde5c9fc83d663a30de161c940');
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const ATOKEN = '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c';
const addressWord = address => address.slice(2).padStart(64, '0');
const word = value => '0x' + BigInt(value).toString(16).padStart(64, '0');
const queries = [
  { to: USDC, data: '0x70a08231' + addressWord(c.request.from) },
  { to: USDC, data: '0xdd62ed3e' + addressWord(c.request.from) + addressWord(c.request.to) },
  { to: USDC, data: '0x70a08231' + addressWord(ATOKEN) },
];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const absentProofRequest = { method: 'eth_getProof', params: [ATOKEN, [word(61)], { blockHash: c.header.hash, requireCanonical: true }] };
async function prepareReplay(caseInput, saved) {
  const rows = [], remap = new Map(), derived = new Map();
  for (const [index, row] of saved.transport.entries()) {
    assert.equal(row.requestText, JSON.stringify(row.request));
    assert.equal(row.request.id, index + 1);
    assert.equal(sha(row.responseText), row.responseSha256);
    assert.deepEqual(JSON.parse(row.responseText), row.parsed);
    if (row.request.method === 'eth_getCode' && row.parsed.result === '0x') {
      const proof = saved.transport[index - 1];
      assert.equal(proof.request.method, 'eth_getProof');
      assert.equal(proof.request.params[0], row.request.params[0]);
      assert.deepEqual(proof.request.params.at(-1), { blockHash: caseInput.header.hash, requireCanonical: true });
      assert.deepEqual(row.request.params.at(-1), proof.request.params.at(-1));
      const verified = await verifyStateProof({ stateRoot: caseInput.header.stateRoot,
        address: row.request.params[0], storageKeys: proof.request.params[1], proof: proof.parsed.result, code: '0x' });
      assert.equal(verified.account.codeHash, EMPTY_CODE_HASH);
      derived.set(row.request.id, verified.account.exists ? 'verified_account_empty_code_hash' : 'verified_account_absence');
    } else {
      rows.push(row); remap.set(row.request.id, rows.length);
    }
  }
  const inputs = structuredClone(saved.inputs);
  for (const item of inputs.provenance) {
    item.proofEvidenceId = remap.get(item.proofEvidenceId);
    assert.ok(Number.isSafeInteger(item.proofEvidenceId));
    if (derived.has(item.codeEvidenceId)) {
      item.codeDerivation = derived.get(item.codeEvidenceId); item.codeEvidenceId = null;
    } else {
      item.codeEvidenceId = remap.get(item.codeEvidenceId); assert.ok(Number.isSafeInteger(item.codeEvidenceId));
    }
    for (const slot of item.storage) { slot.evidenceId = remap.get(slot.evidenceId); assert.ok(Number.isSafeInteger(slot.evidenceId)); }
  }
  return { rows, inputs };
}
const prepared = new Map([[recorded, await prepareReplay(c, recorded)], [morphoRecorded, await prepareReplay(morpho, morphoRecorded)]]);
function playback({ allowMissingProof = false, caseInput = c, saved = recorded } = {}) {
  const { rows, inputs } = prepared.get(saved);
  let at = 0, missing = 0; const mismatches = [];
  return { expectedInputs: inputs, rpc: { async call(method, params) {
    const row = rows[at++];
    if (!row && allowMissingProof && at === rows.length + 1) {
      try { assert.deepEqual({ method, params }, absentProofRequest); }
      catch (error) { mismatches.push(error.message); throw error; }
      missing++;
      throw new Error('Recorded input set lacks this pinned aToken proof');
    }
    try {
      assert.ok(row, 'Unrecorded proof/code request');
      assert.deepEqual({ method, params }, { method: row.request.method, params: row.request.params });
      assert.ok(['eth_getProof', 'eth_getCode'].includes(method));
      assert.deepEqual(params.at(-1), { blockHash: caseInput.header.hash, requireCanonical: true });
    } catch (error) { mismatches.push(error.message); throw error; }
    return structuredClone(row.parsed.result);
  } }, assertComplete() {
    assert.deepEqual(mismatches, [], 'External mismatch latch must remain empty');
    assert.equal(at, rows.length + (allowMissingProof ? 1 : 0));
    assert.equal(missing, allowMissingProof ? 1 : 0);
  } };
}
const run = (rpc, changes = {}) => executeIsolatedEthereumPreview({ request: c.request, header: c.header, queries, rpc, ...changes });
function withheld(result, code) {
  assert.equal(result.status, 'unavailable'); assert.equal(result.preview, null);
  if (code) assert.equal(result.error.code, code);
}
function sameOriginalOutput(actual, expected = recorded.output) {
  // Preparation consumes part of the fixed shared wall budget. Its remaining
  // cooperative deadline is generated metadata; all execution fields stay exact.
  assert.ok(Number.isSafeInteger(actual.limits.wallMs) && actual.limits.wallMs > 0 && actual.limits.wallMs <= 120000);
  const normalized = structuredClone(actual);
  normalized.limits.wallMs = expected.limits.wallMs;
  // The 0.17 lifecycle label describes observed activity, replacing the old
  // blanket unsupported policy; no execution/state evidence is normalized.
  assert.equal(normalized.semantics.lifecycle, 'no_lifecycle_operation_encountered');
  assert.equal(expected.semantics.lifecycle, 'CREATE_CREATE2_SELFDESTRUCT_unsupported');
  normalized.semantics.lifecycle = expected.semantics.lifecycle;
  assert.deepEqual(normalized, expected);
}

test('actual isolated child executes original Aave once then returns three proof-backed before/after pairs', async () => {
  const f = playback(), result = await run(f.rpc);
  f.assertComplete(); assert.equal(result.status, 'completed'); assert.equal(result.error, null);
  assert.equal(result.preview.status, 'complete');
  sameOriginalOutput(result.preview.original.output);
  assert.deepEqual(result.preview.original.changes, recorded.changes);
  assert.deepEqual(result.preview.original.inputs, f.expectedInputs);
  assert.deepEqual(result.headerVerification, recorded.headerVerification);
  assert.equal(result.broker.calls, 56); assert.equal(result.broker.dispatches, 56); assert.equal(result.broker.pendingAtReturn, 0);
  assert.equal(result.isolation.processSeparated, true); assert.notEqual(result.isolation.childPid, process.pid);
  assert.equal(result.isolation.processClosed, true); assert.equal(result.isolation.exitCode, 0);
  assert.equal(result.isolation.osNetworkSandbox, false); assert.equal(result.isolation.osFilesystemSandbox, false);
  const expected = [['3962903485', '0'], ['0', '0'], ['151987610826648', '151991573730133']];
  assert.equal(result.preview.measurements.length, expected.length);
  result.preview.measurements.forEach((row, i) => {
    assert.equal(row.status, 'measured'); assert.deepEqual(row.query, queries[i]);
    assert.equal(row.identity.token, USDC); assert.equal(row.identity.contractIdentityVerified, false);
    assert.deepEqual(row.values, [{ name: i === 1 ? 'allowance' : 'balance', beforeRaw: expected[i][0], afterRaw: expected[i][1], deltaRaw: (BigInt(expected[i][1]) - BigInt(expected[i][0])).toString(), unit: { kind: 'token_raw_units', scale: null } }]);
    for (const [phase, raw] of [[row.before, expected[i][0]], [row.after, expected[i][1]]]) {
      assert.equal(phase.status, 'measured'); assert.equal(phase.output.execution.returnData, word(raw));
      assert.equal(phase.output.trace.from, c.request.from); assert.equal(phase.output.trace.to, USDC);
      assert.equal(phase.output.trace.input, queries[i].data); assert.deepEqual(phase.output.logs, []);
      assert.equal(phase.mutationValidation.status, 'verified'); assert.deepEqual(phase.inputEvidenceIds, []);
    }
  });
  assert.equal(result.preview.measurements[0].identity.account, c.request.from);
  assert.equal(result.preview.measurements[1].identity.owner, c.request.from);
  assert.equal(result.preview.measurements[1].identity.spender, c.request.to);
  assert.equal(result.preview.measurements[2].identity.account, ATOKEN);
  assert.notEqual(ATOKEN, c.request.from);
});

test('actual child handles eight Morpho queries with 229 required proof/code calls and exact account identities', async () => {
  const wallet = morpho.request.from, wrapper = morpho.request.to;
  const vault = '0xbeef01735c132ada46aa9aa4c54623caa92a64cb';
  const blue = '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb';
  const feeAccount = '0x255c7705e8bb334dfcae438197f7c4297988085a';
  const balance = (token, account) => [{ to: token, data: '0x70a08231' + addressWord(account) }, { kind: 'balanceOf', token, account }];
  const allowance = (token, owner, spender) => [{ to: token, data: '0xdd62ed3e' + addressWord(owner) + addressWord(spender) }, { kind: 'allowance', token, owner, spender }];
  const rows = [
    [...balance(wrapper, wallet), '1151370388097', '1481867899909'],
    [...balance(USDC, wallet), '704323976173', '354323976173'],
    [...allowance(USDC, wallet, wrapper), '350000000000', '0'],
    [...balance(wrapper, wrapper), '18022867783', '18078180423'],
    [...balance(USDC, wrapper), '20083625', '20083625'],
    [...balance(USDC, blue), '128890534855869', '129240534855869'],
    [...balance(USDC, vault), '6011', '6011'],
    [...balance(vault, feeAccount), '34363220714011809188525', '34390568084318171872187'],
  ];
  const f = playback({ caseInput: morpho, saved: morphoRecorded });
  const result = await executeIsolatedEthereumPreview({ request: morpho.request, header: morpho.header, rpc: f.rpc, queries: rows.map(row => row[0]) });
  f.assertComplete(); assert.equal(result.status, 'completed'); assert.equal(result.error, null);
  assert.equal(result.preview.status, 'complete');
  sameOriginalOutput(result.preview.original.output, morphoRecorded.output);
  assert.deepEqual(result.preview.original.changes, morphoRecorded.changes);
  assert.deepEqual(result.preview.original.inputs, f.expectedInputs);
  assert.deepEqual(result.headerVerification, morphoRecorded.headerVerification);
  assert.equal(result.broker.calls, 229); assert.equal(result.broker.dispatches, 229); assert.equal(result.broker.pendingAtReturn, 0);
  assert.equal(result.isolation.processSeparated, true); assert.notEqual(result.isolation.childPid, process.pid);
  assert.equal(result.isolation.processClosed, true); assert.equal(result.isolation.exitCode, 0);
  assert.equal(result.isolation.v8OldSpaceMiB, 256); assert.equal(result.preview.usage.executions, 17);
  assert.equal(result.preview.measurements.length, 8);
  result.preview.measurements.forEach((measurement, i) => {
    const [query, identity, before, after] = rows[i];
    assert.equal(measurement.status, 'measured'); assert.deepEqual(measurement.query, query);
    assert.deepEqual(measurement.identity, { ...identity, chainId: '1', contractIdentityVerified: false });
    assert.deepEqual(measurement.values, [{ name: identity.kind === 'allowance' ? 'allowance' : 'balance', beforeRaw: before, afterRaw: after, deltaRaw: (BigInt(after) - BigInt(before)).toString(), unit: { kind: 'token_raw_units', scale: null } }]);
    for (const [phase, raw] of [[measurement.before, before], [measurement.after, after]]) {
      assert.equal(phase.status, 'measured'); assert.equal(phase.output.execution.returnData, word(raw));
      assert.equal(phase.output.trace.from, wallet); assert.equal(phase.output.trace.to, query.to);
      assert.equal(phase.output.trace.input, query.data); assert.deepEqual(phase.output.logs, []);
      assert.equal(phase.mutationValidation.status, 'verified'); assert.deepEqual(phase.inputEvidenceIds, []);
    }
    assert.deepEqual(measurement.after.changesBefore, morphoRecorded.changes);
  });
  assert.notEqual(result.preview.measurements[3].identity.account, wallet);
  assert.equal(result.preview.measurements[7].identity.account, feeAccount);
  assert.notEqual(feeAccount, wallet);
});

test('actual child preserves a partial preview when an explicitly missing proof poisons later queries', async () => {
  const f = playback({ allowMissingProof: true });
  const aTokenQuery = { to: ATOKEN, data: '0x70a08231' + addressWord(c.request.from) };
  const result = await run(f.rpc, { queries: [queries[0], aTokenQuery, queries[1]] });
  f.assertComplete(); assert.equal(result.status, 'completed'); assert.equal(result.error, null);
  assert.equal(result.preview.status, 'partial');
  sameOriginalOutput(result.preview.original.output);
  assert.deepEqual(result.preview.original.changes, recorded.changes);
  assert.equal(result.preview.original.inputUsage.status, 'available');
  assert.equal(result.preview.inputUsage.status, 'unavailable');
  const [measured, missing, later] = result.preview.measurements;
  assert.equal(measured.status, 'measured'); assert.equal(measured.values[0].beforeRaw, '3962903485'); assert.equal(measured.values[0].afterRaw, '0');
  assert.equal(missing.status, 'unavailable'); assert.equal(missing.values, null); assert.deepEqual(missing.query, aTokenQuery);
  assert.equal(later.status, 'not_attempted'); assert.equal(later.values, null); assert.deepEqual(later.query, queries[1]);
  assert.equal(result.broker.calls, 57); assert.equal(result.broker.dispatches, 57);
  assert.equal(result.broker.records.at(-1).status, 'unavailable');
  assert.equal(result.broker.pendingAtReturn, 0); assert.equal(result.isolation.processClosed, true);
});

test('parent rejects bad queries and unbound inputs before fork or any provider dispatch', async t => {
  let calls = 0;
  const mock = t.mock.method(childProcess, 'fork', () => { throw Error('Must not fork'); });
  const rpc = { async call() { calls++; throw Error('Must not dispatch'); } };
  for (const changes of [
    { queries: [] }, { queries: [queries[0], queries[0]] },
    { queries: Array.from({ length: 9 }, (_, i) => ({ to: USDC, data: '0x70a08231' + word(i).slice(2) })) },
    { queries: [{ ...queries[0], expected: '1' }] },
    { queries: [{ kind: 'aave_v3_user_account_data', contract: c.request.to, user: 'not-an-address' }] },
    { queries: [{ kind: 'morpho_blue_position', contract: c.request.to, user: c.request.from, marketId: '0x1' }] },
    { header: { ...c.header, stateRoot: word(1) } },
    { request: { ...c.request, stateOverrides: {} } },
    { request: { ...c.request, gas: '5000001' } },
    { limits: { calls: 257 } }, { expected: {} },
  ]) withheld(await run(rpc, changes), 'LOCAL_ISOLATED_INPUT');
  assert.equal(mock.mock.callCount(), 0); assert.equal(calls, 0);
  const controller = new AbortController(); controller.abort();
  withheld(await run(rpc, { signal: controller.signal }), 'LOCAL_ISOLATED_CANCELLED');
  assert.equal(mock.mock.callCount(), 0); assert.equal(calls, 0);
});

test('hard deadline kills an actual stopped child and withholds the entire preview', async t => {
  const fork = childProcess.fork; let calls = 0;
  t.mock.method(childProcess, 'fork', (...args) => { const child = fork(...args); child.kill('SIGSTOP'); return child; });
  const result = await run({ call() { calls++; throw Error('Must not dispatch'); } }, { limits: { wallMs: 100, drainMs: 20 } });
  withheld(result, 'LOCAL_ISOLATED_TIMEOUT');
  assert.equal(result.isolation.processClosed, true); assert.equal(result.isolation.exitSignal, 'SIGKILL');
  assert.equal(result.isolation.terminateRequested, true); assert.equal(calls, 0);
  assert.equal(result.broker.pendingAtReturn, 0); assert.ok(result.isolation.durationMs < 3000);
});

test('cancellation aborts and drains the actual child proof read before returning no preview', async () => {
  const controller = new AbortController(); let calls = 0, finished = false, signalled = false;
  const result = await run({ call(_method, _params, { signal }) {
    calls++; setTimeout(() => controller.abort(), 5);
    return new Promise((_, reject) => signal.addEventListener('abort', () => {
      signalled = true; setTimeout(() => { finished = true; reject(new Error('PRIVATE_PREVIEW_ABORT')); }, 15);
    }, { once: true }));
  } }, { signal: controller.signal });
  withheld(result, 'LOCAL_ISOLATED_CANCELLED');
  assert.equal(calls, 1); assert.equal(signalled, true); assert.equal(finished, true);
  assert.equal(result.isolation.processClosed, true); assert.equal(result.broker.pendingAtReturn, 0);
  assert.equal(JSON.stringify(result).includes('PRIVATE_PREVIEW_ABORT'), false);
});

test('late uncooperative read cannot revive measurements or mutate sealed unavailable preview evidence', async () => {
  const controller = new AbortController(); let release;
  const result = await run({ call() {
    setTimeout(() => controller.abort(), 5); return new Promise(resolve => { release = resolve; });
  } }, { signal: controller.signal, limits: { drainMs: 20 } });
  withheld(result, 'LOCAL_ISOLATED_CANCELLED'); assert.equal(result.broker.pendingAtReturn, 1);
  const sealed = JSON.stringify(result); release('0x'); await delay(25);
  assert.equal(JSON.stringify(result), sealed);
});

test('actual child IPC mutations cannot substitute query identities, amounts, return words or original evidence', async t => {
  const fork = childProcess.fork;
  const controls = [
    preview => { preview.measurements[0].identity.account = ATOKEN; },
    preview => { preview.measurements[0].query.to = ATOKEN; },
    preview => { preview.measurements[0].values[0].afterRaw = '1'; },
    preview => { preview.measurements[0].before.output.execution.returnData = word(1); },
    preview => { preview.original.inputEvidence[0].result.nonce = '0x0'; },
    preview => { preview.original.output.trace.input = '0x'; },
    preview => { preview.headerVerification.stateRoot = word(1); },
    preview => { delete preview.inputEvidence[0].result; delete preview.original.inputEvidence[0].result; },
  ];
  for (const mutate of controls) {
    let altered = false;
    const mock = t.mock.method(childProcess, 'fork', (...args) => {
      const child = fork(...args), emit = child.emit;
      child.emit = function (event, ...values) {
        if (event === 'message' && typeof values[0] === 'string') {
          const message = JSON.parse(values[0]);
          if (message.type === 'result') { mutate(message.result.preview); altered = true; values[0] = JSON.stringify(message); }
        }
        return emit.call(this, event, ...values);
      };
      return child;
    });
    const f = playback(), result = await run(f.rpc); mock.mock.restore();
    f.assertComplete(); assert.equal(altered, true); withheld(result, 'LOCAL_ISOLATED_PROTOCOL');
  }
});

test('synthetic fake child cannot invent a complete preview without parent proof evidence', async t => {
  let calls = 0;
  t.mock.method(childProcess, 'fork', () => {
    const child = new EventEmitter(); Object.assign(child, { connected: true, pid: 999999, stdout: new PassThrough(), stderr: new PassThrough() });
    child.send = (raw, callback) => { callback?.(); if (JSON.parse(raw).type === 'start') queueMicrotask(() => child.emit('message', JSON.stringify({ v: 1, type: 'result', id: 1, result: { preview: { status: 'complete', measurements: [{ status: 'measured', values: [{ beforeRaw: '0', afterRaw: '1', deltaRaw: '1' }] }] } } }))); return true; };
    child.kill = signal => { child.connected = false; queueMicrotask(() => child.emit('close', null, signal)); return true; };
    return child;
  });
  const result = await run({ call() { calls++; throw Error('Must not dispatch'); } });
  withheld(result, 'LOCAL_ISOLATED_PROTOCOL'); assert.equal(calls, 0);
});
