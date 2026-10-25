import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyzePermissions } from '../src/permissions.js';
import { measureAllowances } from '../src/allowances.js';
import { METADATA, USDC, HUSDC } from '../src/config.js';

const MAX = ((1n << 256n) - 1n).toString();
const word = value => BigInt(value).toString(16).padStart(64, '0');
async function observed(name) {
  const record = JSON.parse(await readFile(new URL(`../reports/permission-discovery/${name}-verified.json`, import.meta.url)));
  const get = key => record.captures[key].response.result;
  const tx = get('transaction'), header = get('block');
  return { request: { chainId: 999, from: tx.from, to: tx.to, data: tx.input, value: BigInt(tx.value).toString() }, trace: get('callTrace'), block: { timestamp: BigInt(header.timestamp).toString() }, metadata: METADATA };
}
const direct = await observed('permit-husdc-direct');
const nested = await observed('router-permit-candidate');
const firstPermit = result => result.observations.find(item => item.kind === 'permit_request');
function replaceWord(input, index, value) {
  const data = input.trace.input;
  input.request.data = input.trace.input = data.slice(0, 10 + index * 64) + value + data.slice(74 + index * 64);
  input.trace.calls[0].input = input.trace.input;
}

test('observed direct hUSDC permit separates owner, transaction submitter and emitted approval', () => {
  const result = analyzePermissions(direct), permit = firstPermit(result);
  assert.equal(permit.asset.address, HUSDC);
  assert.equal(permit.owner, '0x3e248867a2a2ddd1d901f7d595c4d02c6519b32a');
  assert.equal(permit.submitter, '0xe9755d57f1b933b152b5b1ef43af64a657b58ddd');
  assert.equal(permit.permitCaller, permit.submitter);
  assert.equal(permit.relayed, true);
  assert.equal(permit.amountRaw, MAX);
  assert.equal(permit.deadlineRaw, '1791213921');
  assert.equal(permit.deadlineRelation, 'not_expired_at_execution');
  assert.equal(permit.eventCorrelation, 'matched');
  assert.equal(permit.signatureVerification, 'not_independently_verified');
  assert.equal(permit.returnStatus, 'empty');
  assert.equal(result.coverage.allowanceStateVerified, false);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].code, 'MAX_UINT256_APPROVAL_EVENT');
  assert.equal(permit.r, undefined); assert.equal(permit.s, undefined);
});

test('observed nested permit keeps router caller distinct from the external sender and its own approval', () => {
  const result = analyzePermissions(nested), permit = firstPermit(result);
  assert.equal(permit.asset.address, USDC);
  assert.equal(permit.owner, '0x0c71073344e27e33cb57fcb587fc412d689dfd1d');
  assert.equal(permit.permitCaller, '0x693f12e9e6b35b34458793546065e8b08e0299d6');
  assert.equal(permit.submitter, nested.request.from);
  assert.equal(permit.relayed, nested.request.from !== permit.owner);
  assert.equal(permit.origin, 'nested_call');
  assert.equal(permit.framePath, '0.0.0');
  assert.equal(permit.eventCorrelation, 'matched');
  const approval = result.observations.find(item => item.kind === 'approval_request');
  assert.equal(approval.owner, permit.permitCaller);
  assert.equal(approval.amountRaw, '24812500');
  assert.notDeepEqual(permit.matchedEventIds, approval.matchedEventIds);
});

test('permit deadline uses the recorded execution time, not the current wall clock', () => {
  const data = structuredClone(direct);
  data.block.timestamp = '1791213921';
  assert.equal(firstPermit(analyzePermissions(data)).deadlineRelation, 'not_expired_at_execution');
  data.block.timestamp = '1791213922';
  const contradictory = analyzePermissions(data);
  assert.equal(firstPermit(contradictory).deadlineRelation, 'expired_at_execution');
  assert.ok(contradictory.coverage.reasons.some(reason => reason.includes('contradicts')));
  delete data.block;
  assert.equal(firstPermit(analyzePermissions(data)).deadlineRelation, 'unavailable');
});

test('synthetic unbounded deadline is a redemption observation, not allowance expiry or maliciousness', () => {
  const data = structuredClone(direct); replaceWord(data, 3, word(MAX));
  const result = analyzePermissions(data), permit = firstPermit(result);
  assert.equal(permit.deadlineRelation, 'unbounded');
  const finding = result.findings.find(item => item.code === 'PERMIT_UNBOUNDED_DEADLINE');
  assert.equal(finding.deadlineRaw, MAX);
  assert.match(finding.message, /not an allowance-expiration/);
  assert.match(finding.message, /does not establish signature validity or maliciousness/);
});

test('unknown tokens, implementations and unrelated delegate frames do not prove permit semantics', () => {
  for (const mutation of [
    data => { data.request.chainId = 1; },
    data => { data.trace.calls[0].to = '0x' + '1'.repeat(40); },
    data => { data.trace.calls[0].input = '0x'; },
    data => { data.trace.calls[0].from = USDC; },
    data => { data.trace.calls.push(structuredClone(data.trace.calls[0])); },
    data => { data.trace.calls = []; },
  ]) {
    const data = structuredClone(direct); mutation(data);
    const result = analyzePermissions(data);
    assert.equal(firstPermit(result), undefined);
    assert.ok(result.observations.some(item => item.kind === 'unverified_permission_call'));
  }
});

test('malformed permits do not invent owners, values or canonical uint8 signature fields', () => {
  for (const mutation of [
    data => replaceWord(data, 0, word(0n)),
    data => replaceWord(data, 0, '1'.repeat(64)),
    data => replaceWord(data, 1, '1'.repeat(64)),
    data => replaceWord(data, 4, word(256n)),
    data => { data.request.data = data.trace.input = data.trace.calls[0].input = data.trace.input + '00'; },
    data => { data.request.value = '1'; data.trace.value = '0x1'; },
  ]) {
    const data = structuredClone(direct); mutation(data);
    assert.equal(firstPermit(analyzePermissions(data)), undefined);
  }
});

test('failed whole calls and failed permit subtrees contribute no effective permit observations', () => {
  const data = structuredClone(direct); data.trace.error = 'execution reverted';
  assert.deepEqual(analyzePermissions(data).observations, []);
  const router = structuredClone(nested); router.trace.calls[0].calls[0].error = 'execution reverted';
  const result = analyzePermissions(router);
  assert.equal(firstPermit(result), undefined);
  assert.equal(result.observations.filter(item => item.kind === 'approval_request').length, 1);
});

test('permit correlation cannot borrow a mismatched event or duplicate delegate calldata', () => {
  const data = structuredClone(direct);
  const original = analyzePermissions(data);
  assert.equal(original.observations.filter(item => item.kind === 'permit_request').length, 1);
  replaceWord(data, 2, word(100000000n));
  const mismatched = analyzePermissions(data);
  assert.equal(firstPermit(mismatched).eventCorrelation, 'mismatched');
  assert.deepEqual(firstPermit(mismatched).matchedEventIds, []);
  assert.ok(mismatched.findings.some(finding => finding.code === 'APPROVAL_EVENT_MISMATCH'));
});

// This unit context supplies recorded allowance values; the historical state
// adapter has separate replay and RPC-evidence tests. It does not make live calls.
async function measuredPermit(input, values, mutatePermissions) {
  const calls = [];
  const permissions = analyzePermissions(input);
  mutatePermissions?.(permissions);
  const stateContext = {
    allowanceMeasurementBasis: 'historical_transaction_position_allowance',
    matches: () => true,
    async readPair(query) {
      calls.push(query);
      const owner = '0x' + query.data.slice(34, 74);
      const spender = '0x' + query.data.slice(98, 138);
      const value = values.find(item => item.token === query.to && item.owner === owner && item.spender === spender);
      assert.ok(value, 'only the observed token owner and spender may be queried');
      return { before: value.before, after: value.after, delta: value.after - value.before };
    },
    async verifyCanonical() {},
    snapshotEvidence: () => ({ request: [], response: [] }),
    executionIdentity: { transactionIndex: '0', postTransactionIndex: '1' },
  };
  return { result: await measureAllowances({ ...input, analysis: { execution: { status: 'success' } }, permissions, stateContext }), calls };
}

test('relayed permit measures the token owner allowance, never the external submitter allowance', async () => {
  const permit = firstPermit(analyzePermissions(direct));
  const { result, calls } = await measuredPermit(direct, [{ token: HUSDC, owner: permit.owner, spender: permit.spender, before: 0n, after: BigInt(MAX) }]);
  assert.equal(result.status, 'measured');
  assert.equal(result.basis, 'historical_transaction_position_allowance');
  assert.equal(calls.length, 1);
  assert.equal(result.allowances[0].owner, permit.owner);
  assert.notEqual(result.allowances[0].owner, direct.request.from);
  assert.equal(result.allowances[0].consistency.requestComparison, 'matches_requested_amount');
  assert.equal(result.allowances[0].afterKind, 'uint256_max');
});

test('nested permit and router approval compare final consumed allowances against their own events', async () => {
  const permissions = analyzePermissions(nested), permit = firstPermit(permissions);
  const approval = permissions.observations.find(item => item.kind === 'approval_request');
  const { result, calls } = await measuredPermit(nested, [
    { token: USDC, owner: permit.owner, spender: permit.spender, before: 0n, after: BigInt(MAX) - 25000000n },
    { token: USDC, owner: approval.owner, spender: approval.spender, before: 0n, after: 0n },
  ]);
  assert.equal(result.status, 'measured');
  assert.equal(calls.length, 2);
  const ownerPair = result.allowances.find(pair => pair.owner === permit.owner);
  const routerPair = result.allowances.find(pair => pair.owner === approval.owner);
  assert.equal(ownerPair.afterRaw, (BigInt(MAX) - 25000000n).toString());
  assert.equal(ownerPair.afterKind, 'bounded');
  assert.equal(ownerPair.consistency.eventComparison, 'differs_from_last_observed_event');
  assert.equal(ownerPair.consistency.lastEventAmountRaw, MAX);
  assert.equal(routerPair.afterRaw, '0');
  assert.equal(routerPair.changed, false);
  assert.equal(routerPair.consistency.lastEventAmountRaw, '24812500');
  assert.equal(routerPair.consistency.requestComparison, 'differs_from_requested_amount');
});

test('stale permit owner, deadline, submitter and immediate caller cannot influence allowance queries', async () => {
  for (const field of ['owner', 'deadlineRaw', 'submitter', 'permitCaller']) {
    const { result, calls } = await measuredPermit(direct, [], permissions => {
      firstPermit(permissions)[field] = field === 'deadlineRaw' ? '1' : USDC;
    });
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(result.allowances, []);
    assert.equal(calls.length, 0);
  }
});
