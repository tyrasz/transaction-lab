import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyzePermissions } from '../src/permissions.js';
import { measureAllowances } from '../src/allowances.js';
import { createHistoricalStateContext } from '../src/historical-state.js';
import { USDC, HUSDC, VUSDC, METADATA } from '../src/config.js';

const addr = n => '0x' + BigInt(n).toString(16).padStart(40, '0');
const word = n => BigInt(n).toString(16).padStart(64, '0');
const aw = a => a.slice(2).padStart(64, '0');
const MAX = (1n << 256n) - 1n;
const OWNER = addr(1), SPENDER = addr(2), RECIPIENT = addr(3), SUBMITTER = addr(4), ROUTER = addr(5);
const IMPLEMENTATIONS = { [USDC]: '0x003f73f58ca78880da3642c5cb71d7459b3fe4f8', [HUSDC]: '0x410aa1ab680b886c875e99a7a4bfaf188508a7a3' };
const inputData = (owner, recipient, amount) => '0x23b872dd' + aw(owner) + aw(recipient) + word(amount);
function tokenFrame({ token = USDC, owner = OWNER, spender = SPENDER, recipient = RECIPIENT, amount = 100000000n, output = '0x' + word(1n) } = {}) {
  const input = inputData(owner, recipient, amount);
  return { type: 'CALL', from: spender, to: token, input, value: '0x0', output, gasUsed: '0x1000', calls: [
    { type: 'DELEGATECALL', from: token, to: IMPLEMENTATIONS[token] ?? addr(99), input, value: '0x0', output, gasUsed: '0xf00' },
  ] };
}
function synthetic(options = {}) {
  const request = { chainId: 999, from: SUBMITTER, to: ROUTER, data: '0x12345678', value: '0' };
  return { request, trace: { type: 'CALL', from: request.from, to: request.to, input: request.data, value: '0x0', gasUsed: '0x2000', calls: [tokenFrame(options)] }, metadata: METADATA, block: { number: '1', timestamp: '1', hash: '0x' + word(1n) }, analysis: { execution: { status: 'success' } } };
}
const transfers = input => analyzePermissions(input).observations.filter(o => o.kind === 'transfer_from_call');
function rewriteCall(input, rewrite) {
  const frame = input.trace.calls[0];
  frame.input = rewrite(frame.input);
  frame.calls[0].input = frame.input;
}
async function measured(input, { before = MAX, after = before, mutatePermissions } = {}) {
  const queries = [], permissions = analyzePermissions(input);
  mutatePermissions?.(permissions);
  const context = {
    matches: () => true,
    async readPair(q) { queries.push(q); return { before, after, delta: after - before }; },
    async verifyCanonical() {}, snapshotEvidence: () => ({ request: [], response: [] }),
    executionIdentity: { stateBlockHash: input.block.hash },
  };
  return { result: await measureAllowances({ ...input, permissions, stateContext: context }), queries };
}

test('verified transferFrom separates four roles and transfer amount from allowance requests', () => {
  const input = synthetic({ amount: MAX });
  const result = analyzePermissions(input), call = transfers(input)[0];
  assert.equal(call.owner, OWNER); assert.equal(call.spender, SPENDER);
  assert.equal(call.recipient, RECIPIENT); assert.equal(call.submitter, SUBMITTER);
  assert.equal(call.ownerIsSpender, false);
  assert.equal(call.amountRaw, MAX.toString());
  assert.equal(call.amountMeaning, 'requested_transfer_amount');
  assert.equal(call.allowanceKind, undefined);
  assert.equal(call.implementation, IMPLEMENTATIONS[USDC]);
  assert.equal(call.returnStatus, 'returned_true');
  assert.equal(call.executionStatus, 'success');
  assert.equal(call.authorizationVerification, 'not_independently_verified');
  assert.equal(call.intentVerification, 'not_assessed');
  assert.equal(call.origin, 'nested_call'); assert.equal(call.framePath, '0.0');
  assert.deepEqual(result.findings, [], 'even a maximum transfer amount is not a maximum approval request');
  assert.equal(result.coverage.allowanceStateVerified, false);
  assert.equal(result.security, undefined);
});

test('only one CALL observation is emitted for a proxy delegate and repeated objects are not counted twice', () => {
  const input = synthetic();
  assert.equal(transfers(input).length, 1);
  input.trace.calls.push(input.trace.calls[0]);
  assert.equal(transfers(input).length, 1);
  input.trace.calls.push(structuredClone(input.trace.calls[0]));
  assert.equal(transfers(input).length, 2, 'separate identical calls remain separate observations');
});

test('a direct hUSDC transferFrom keeps its top-level submitter and calldata owner distinct', () => {
  const input = synthetic({ token: HUSDC });
  input.trace = input.trace.calls[0];
  input.request = { chainId: 999, from: SPENDER, to: HUSDC, data: input.trace.input, value: '0' };
  const observed = transfers(input)[0];
  assert.equal(observed.origin, 'top_level_request');
  assert.equal(observed.framePath, '0');
  assert.equal(observed.owner, OWNER);
  assert.equal(observed.spender, SPENDER);
  assert.equal(observed.submitter, SPENDER);
  assert.equal(observed.implementation, IMPLEMENTATIONS[HUSDC]);
});

test('unknown token, chain, delegate implementation or proxy provenance cannot establish transfer arguments', () => {
  const mutations = [
    input => { input.request.chainId = 1; },
    input => { input.trace.calls[0].to = addr(99); },
    input => { input.trace.calls[0].to = VUSDC; },
    input => { input.trace.calls[0].calls[0].to = addr(99); },
    input => { input.trace.calls[0].calls[0].from = HUSDC; },
    input => { input.trace.calls[0].calls[0].input = '0x'; },
    input => { input.trace.calls[0].calls[0].value = '0x1'; },
    input => { input.trace.calls[0].calls[0].error = 'execution reverted'; },
    input => { input.trace.calls[0].calls[0].type = 'CALL'; },
    input => { input.trace.calls[0].calls = []; },
    input => { input.trace.calls[0].calls.push(structuredClone(input.trace.calls[0].calls[0])); },
    input => { input.trace.calls[0].output = '0x' + word(0n); },
  ];
  for (const mutate of mutations) {
    const input = synthetic(); mutate(input);
    const result = analyzePermissions(input);
    assert.equal(transfers(input).length, 0);
    const unknown = result.observations.find(o => o.kind === 'unverified_permission_call');
    assert.equal(unknown.tokenVerified, false);
    assert.equal(unknown.owner, undefined); assert.equal(unknown.amountRaw, undefined);
  }
});

test('transferFrom ABI requires exactly three canonical words and zero native value', () => {
  for (const mutate of [
    input => rewriteCall(input, data => data + '00'),
    input => rewriteCall(input, data => data.slice(0, -2)),
    input => rewriteCall(input, data => data.slice(0, 10) + '1' + data.slice(11)),
    input => rewriteCall(input, data => data.slice(0, 74) + '1' + data.slice(75)),
    input => rewriteCall(input, data => data.slice(0, -1) + 'z'),
    input => { input.trace.calls[0].value = '0x1'; },
    input => { input.trace.calls[0].from = [SPENDER]; },
    input => { input.trace.calls[0].input = [input.trace.calls[0].input]; },
  ]) {
    const input = synthetic(); mutate(input);
    assert.equal(transfers(input).length, 0);
  }
  const input = synthetic({ token: HUSDC, amount: 123456789012345678901234567890n });
  const observed = transfers(input)[0];
  assert.equal(observed.amount, '123456789012345678901234.56789');
  input.metadata = {};
  assert.equal(transfers(input)[0].amount, null, 'decimals are not inferred from symbol or address alone');
});

test('failed roots, failed ancestors, and static ancestors exclude transferFrom descendants', () => {
  for (const mutate of [
    input => { input.trace.error = 'execution reverted'; },
    input => { input.trace.calls[0].error = 'execution reverted'; },
    input => { input.trace.calls = [{ type: 'CALL', from: ROUTER, to: SPENDER, error: 'execution reverted', calls: input.trace.calls }]; },
    input => { input.trace.calls = [{ type: 'STATICCALL', from: ROUTER, to: SPENDER, calls: input.trace.calls }]; },
    input => { input.trace.calls[0].type = 'STATICCALL'; },
  ]) {
    const input = synthetic(); mutate(input);
    assert.equal(transfers(input).length, 0);
  }
});

test('false and missing boolean returns remain call evidence without claiming successful token movement', async () => {
  const input = synthetic({ output: '0x' + word(0n) });
  const observed = transfers(input)[0];
  assert.equal(observed.returnStatus, 'returned_false');
  assert.equal(observed.executionStatus, 'success', 'EVM return status is separate from token operation success');
  assert.ok(analyzePermissions(input).warnings.some(w => w.includes('does not establish that tokens moved')));
  const { result } = await measured(input, { before: 5n, after: 5n });
  assert.equal(result.status, 'measured');
  assert.equal(result.allowances[0].changed, false);
  assert.deepEqual(result.allowances[0].consistency.falseReturnObservationIds, [observed.id]);
  for (const output of ['0x', '0x01', '0x' + word(2n)]) {
    const missing = synthetic({ output });
    assert.ok(['empty', 'malformed'].includes(transfers(missing)[0].returnStatus));
    assert.ok(analyzePermissions(missing).coverage.reasons.some(reason => reason.includes('canonical boolean return')));
  }
  const unavailable = synthetic();
  delete unavailable.trace.calls[0].output;
  delete unavailable.trace.calls[0].calls[0].output;
  assert.equal(transfers(unavailable)[0].returnStatus, 'unavailable');
});

test('measured unchanged maximum allowance does not erase an observed transferFrom', async () => {
  const input = synthetic({ amount: 100000000n });
  const { result, queries } = await measured(input);
  assert.equal(result.status, 'measured');
  const pair = result.allowances[0];
  assert.deepEqual(queries, [{ to: USDC, data: '0xdd62ed3e' + aw(OWNER) + aw(SPENDER) }]);
  assert.equal(pair.beforeRaw, MAX.toString()); assert.equal(pair.afterRaw, MAX.toString());
  assert.equal(pair.changed, false); assert.equal(pair.deltaRaw, '0');
  assert.equal(pair.consistency.requestComparison, 'no_request', 'transfer amount is not an approval/permit request');
  assert.equal(pair.consistency.eventComparison, 'no_event');
  assert.equal(pair.consistency.transferComparison, 'not_compared_to_allowance');
  assert.deepEqual(pair.consistency.transferObservationIds, ['permission-1']);
  assert.match(pair.consistency.explanation, /unchanged allowance does not establish that no spending occurred/);
  assert.equal(transfers(input).length, 1);
});

test('self-owner spender remains explicit and zero allowance does not imply failed authorization', async () => {
  const input = synthetic({ token: HUSDC, spender: OWNER });
  const observed = transfers(input)[0];
  assert.equal(observed.ownerIsSpender, true);
  assert.equal(observed.authorizationVerification, 'not_independently_verified');
  const { result, queries } = await measured(input, { before: 0n, after: 0n });
  assert.equal(result.status, 'measured');
  assert.deepEqual(queries, [{ to: HUSDC, data: '0xdd62ed3e' + aw(OWNER) + aw(OWNER) }]);
  assert.equal(result.allowances[0].changed, false);
  assert.equal(result.allowances[0].consistency.transferComparison, 'not_compared_to_allowance');
});

test('stale transfer owner/spender/recipient/submitter/provenance is rejected before state queries', async () => {
  for (const field of ['owner', 'spender', 'recipient', 'submitter', 'implementation', 'amountRaw', 'amountMeaning', 'returnStatus', 'ownerIsSpender', 'executionStatus', 'authorizationVerification', 'intentVerification']) {
    const { result, queries } = await measured(synthetic(), { mutatePermissions: permissions => {
      permissions.observations[0][field] = field === 'ownerIsSpender' ? true : field === 'amountRaw' ? '9' : 'changed';
    } });
    assert.equal(result.status, 'unavailable', field);
    assert.deepEqual(queries, []);
  }
});

test('transferFrom allowance candidates obey eight-pair and 256-observation bounds before RPC', async () => {
  for (const kind of ['pairs', 'observations']) {
    const input = synthetic();
    input.trace.calls = Array.from({ length: kind === 'pairs' ? 9 : 257 }, (_, index) => tokenFrame({ owner: kind === 'pairs' ? addr(index + 100) : OWNER }));
    const { result, queries } = await measured(input);
    assert.equal(result.status, 'unavailable'); assert.deepEqual(queries, []);
    assert.ok(result.warnings.some(w => w.includes(kind === 'pairs' ? 'eight-pair' : '256-observation')));
  }
});

test('duplicate pairs are queried once while distinct successful calls retain their observations', async () => {
  const input = synthetic();
  input.trace.calls.push(tokenFrame({ amount: 7n }));
  const failed = tokenFrame({ owner: RECIPIENT }); failed.error = 'execution reverted';
  input.trace.calls.push(failed);
  const { result, queries } = await measured(input, { before: 100000010n, after: 3n });
  assert.equal(result.status, 'measured'); assert.equal(queries.length, 1);
  assert.equal(result.allowances[0].observationIds.length, 2);
  assert.equal(result.allowances[0].consistency.transferObservationIds.length, 2);
  assert.equal(result.allowances[0].consistency.requestComparison, 'no_request');
});

const views = JSON.parse(await readFile(new URL('../reports/historical-permissions/view-probes.json', import.meta.url)));
const supplyRun = JSON.parse(await readFile(new URL('../reports/historical-permissions/view-module-validation.json', import.meta.url))).runs[0];
test('observed historical supply transferFrom identifies the Pool and measures its recorded allowance decrease', async () => {
  const capture = Object.fromEntries(views.providers[0].captures.map(c => [c.label, c.response.result]));
  const calls = [];
  const rpc = { async call(method, params) {
    calls.push({ method, params });
    const saved = supplyRun.evidence.request.find(r => r.method === method && JSON.stringify(r.params) === JSON.stringify(params));
    assert.ok(saved, 'only captured original-position read requests may execute in this offline test');
    return structuredClone(supplyRun.evidence.response.find(r => r.id === saved.id).result);
  } };
  const input = { request: supplyRun.request, block: supplyRun.block, transaction: capture.transaction, receipt: capture.receipt, trace: capture.trace, rpc, metadata: METADATA, analysis: { execution: { status: 'success' } } };
  const observed = transfers(input);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].owner, input.request.from);
  assert.equal(observed[0].spender, input.request.to);
  assert.equal(observed[0].amountRaw, '15066115');
  const result = await measureAllowances({ ...input, permissions: analyzePermissions(input), stateContext: createHistoricalStateContext(input) });
  assert.equal(result.status, 'measured');
  assert.equal(result.basis, 'historical_transaction_position_allowance');
  assert.equal(result.allowances.length, 1);
  assert.equal(result.allowances[0].deltaRaw, '-15066115');
  assert.equal(result.allowances[0].consistency.requestComparison, 'no_request');
  assert.equal(result.allowances[0].consistency.transferComparison, 'not_compared_to_allowance');
  assert.ok(calls.length > 0);
});

test('observed router transferFrom calls retain owner versus router spending roles after permit', async () => {
  const saved = JSON.parse(await readFile(new URL('../reports/permission-discovery/router-permit-candidate-verified.json', import.meta.url)));
  const tx = saved.captures.transaction.response.result;
  const input = { request: { chainId: 999, from: tx.from, to: tx.to, data: tx.input, value: '0' }, trace: saved.captures.callTrace.response.result, metadata: METADATA };
  const result = analyzePermissions(input), observed = transfers(input);
  assert.equal(observed.length, 2);
  assert.equal(observed[0].owner, '0x0c71073344e27e33cb57fcb587fc412d689dfd1d');
  assert.equal(observed[0].spender, '0x693f12e9e6b35b34458793546065e8b08e0299d6');
  assert.equal(observed[0].recipient, observed[0].spender);
  assert.equal(observed[0].amountRaw, '25000000');
  assert.equal(observed[1].owner, observed[0].spender);
  assert.equal(observed[1].spender, '0x04de1ef694923844bae419d4f832196f21767f86');
  assert.equal(observed[1].amountRaw, '24812500');
  assert.ok(observed.every(call => call.submitter === tx.from));
  assert.equal(result.observations.find(o => o.kind === 'permit_request').amountRaw, MAX.toString());
  assert.equal(result.observations.find(o => o.kind === 'approval_request').amountRaw, '24812500');
});
