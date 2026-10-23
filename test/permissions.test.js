import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePermissions } from '../src/permissions.js';
import { USDC, HUSDC, METADATA } from '../src/config.js';

const OWNER = '0x1111111111111111111111111111111111111111';
const SPENDER = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';
const UNKNOWN = '0x4444444444444444444444444444444444444444';
const APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
const MAX = (1n << 256n) - 1n;
const word = value => `0x${BigInt(value).toString(16).padStart(64, '0')}`;
const addressWord = value => `0x${value.slice(2).padStart(64, '0')}`;
const approve = (spender = SPENDER, amount = 100000000n) => `0x095ea7b3${addressWord(spender).slice(2)}${word(amount).slice(2)}`;
const event = ({ owner = OWNER, spender = SPENDER, amount = 100000000n, token = USDC, index = 0 } = {}) => ({
  address: token, topics: [APPROVAL, addressWord(owner), addressWord(spender)], data: word(amount), logIndex: index === null ? undefined : `0x${index.toString(16)}`,
});
function input({ amount = 100000000n, spender = SPENDER, token = USDC, logs, output = word(1n), error } = {}) {
  const data = approve(spender, amount);
  return {
    request: { chainId: 999, from: OWNER, to: token, data, value: '0' }, metadata: METADATA,
    trace: { type: 'CALL', from: OWNER, to: token, input: data, output, ...(error ? { error } : {}), logs: logs ?? [event({ spender, amount, token })] },
  };
}

test('verified ERC20 approval request and emitted evidence are distinct and correlate exactly', () => {
  const result = analyzePermissions(input());
  assert.equal(result.observations.length, 2);
  const [call, emitted] = result.observations;
  assert.equal(call.kind, 'approval_request');
  assert.equal(call.basis, 'approve_calldata');
  assert.equal(call.owner, OWNER);
  assert.equal(call.spender, SPENDER);
  assert.equal(call.amountRaw, '100000000');
  assert.equal(call.amount, '100');
  assert.equal(call.allowanceKind, 'bounded');
  assert.equal(call.returnStatus, 'returned_true');
  assert.deepEqual(call.matchedEventIds, [emitted.id]);
  assert.deepEqual(emitted.matchedRequestIds, [call.id]);
  assert.equal(emitted.basis, 'approval_event');
  assert.deepEqual(result.findings, []);
  assert.equal(result.coverage.allowanceStateVerified, false);
  assert.equal(result.security, undefined, 'permission observations must not masquerade as a security verdict');
});

test('maximum uint256 approval yields one scoped event finding, without claiming maliciousness', () => {
  const result = analyzePermissions(input({ amount: MAX }));
  assert.equal(result.observations[0].amountRaw, MAX.toString());
  assert.equal(result.observations[0].allowanceKind, 'uint256_max');
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].code, 'MAX_UINT256_APPROVAL_EVENT');
  assert.equal(result.findings[0].owner, OWNER);
  assert.equal(result.findings[0].spender, SPENDER);
  assert.equal(result.findings[0].token, USDC);
  assert.match(result.findings[0].message, /final allowance and spender trustworthiness were not verified/);
});

test('a calldata-only unlimited request never becomes a confirmed permission event', () => {
  const result = analyzePermissions(input({ amount: MAX, logs: [] }));
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].eventCorrelation, 'not_observed');
  assert.equal(result.findings[0].code, 'MAX_UINT256_APPROVAL_REQUEST');
  assert.equal(result.findings[0].basis, 'approve_calldata');
});

test('zero approvals are labeled revoke and huge non-max allowances remain exact bounded values', () => {
  const revoked = analyzePermissions(input({ amount: 0n }));
  assert.equal(revoked.observations[0].allowanceKind, 'revoke');
  assert.equal(revoked.observations[1].amount, '0');
  assert.deepEqual(revoked.findings, []);
  const amount = 123456789012345678901234567890n;
  const huge = analyzePermissions(input({ amount }));
  assert.equal(huge.observations[0].amountRaw, amount.toString());
  assert.equal(huge.observations[0].amount, '123456789012345678901234.56789');
  assert.equal(huge.observations[0].allowanceKind, 'bounded');
  assert.deepEqual(huge.findings, []);
});

test('reversed owner/spender and altered amount cannot be correlated to the requested approval', () => {
  for (const log of [event({ owner: SPENDER, spender: OWNER }), event({ spender: OTHER }), event({ amount: 99999999n })]) {
    const result = analyzePermissions(input({ logs: [log] }));
    const [call, emitted] = result.observations;
    assert.equal(call.eventCorrelation, 'mismatched');
    assert.deepEqual(call.matchedEventIds, []);
    assert.deepEqual(emitted.matchedRequestIds, []);
    assert.equal(result.findings[0].code, 'APPROVAL_EVENT_MISMATCH');
  }
});

test('a maximum event for another owner or spender is attributed to the event addresses', () => {
  const result = analyzePermissions(input({ logs: [event({ owner: OTHER, spender: OWNER, amount: MAX })] }));
  const finding = result.findings.find(item => item.code === 'MAX_UINT256_APPROVAL_EVENT');
  assert.equal(finding.owner, OTHER);
  assert.equal(finding.spender, OWNER);
  assert.notEqual(finding.owner, result.observations[0].owner);
});

test('whole-call failures discard all requested/event observations and findings', () => {
  for (const error of ['execution reverted', 'out of gas']) {
    const result = analyzePermissions(input({ amount: MAX, error }));
    assert.deepEqual(result.observations, []);
    assert.deepEqual(result.findings, []);
    assert.ok(result.warnings.some(warning => warning.includes('top-level call failed')));
  }
});

test('a reverted child subtree is discarded while a successful sibling approval remains', () => {
  const data = input();
  data.request.to = OTHER;
  data.request.data = '0x12345678';
  data.trace = { type: 'CALL', from: OWNER, to: OTHER, input: data.request.data, calls: [
    input({ amount: MAX, error: 'execution reverted' }).trace,
    input({ amount: 42n, logs: [event({ amount: 42n, index: 1 })] }).trace,
  ] };
  const result = analyzePermissions(data);
  assert.equal(result.observations.length, 2);
  assert.equal(result.observations[0].amountRaw, '42');
  assert.equal(result.observations[0].origin, 'nested_call');
  assert.deepEqual(result.findings, []);
});

test('duplicate indexed logs are counted once; independently emitted events remain separate', () => {
  const log = event({ amount: MAX });
  const duplicate = analyzePermissions(input({ amount: MAX, logs: [log, structuredClone(log), log] }));
  assert.equal(duplicate.observations.filter(item => item.kind === 'approval_event').length, 1);
  assert.equal(duplicate.findings.length, 1);
  const separate = analyzePermissions(input({ amount: MAX, logs: [log, event({ amount: MAX, index: 1 })] }));
  assert.equal(separate.observations.filter(item => item.kind === 'approval_event').length, 2);
  const unindexed = analyzePermissions(input({ logs: [event({ index: null }), event({ index: null })] }));
  assert.equal(unindexed.observations.filter(item => item.kind === 'approval_event').length, 2);
});

test('unknown contracts stay unverified even when supplied token metadata and familiar signatures', () => {
  const data = input({ token: UNKNOWN, amount: MAX });
  data.metadata = { ...METADATA, [UNKNOWN]: { address: UNKNOWN, symbol: 'USDC', decimals: 6 } };
  const result = analyzePermissions(data);
  assert.deepEqual(result.observations.map(item => item.kind), ['unverified_permission_call', 'unverified_permission_event']);
  for (const observation of result.observations) {
    assert.equal(observation.tokenVerified, false);
    assert.equal(observation.owner, undefined);
    assert.equal(observation.spender, undefined);
    assert.equal(observation.amountRaw, undefined);
  }
  assert.deepEqual(result.findings, []);
});

test('unknown selectors create no approval request, while a valid Approval event remains separate evidence', () => {
  const data = input({ logs: [] });
  data.request.data = data.trace.input = '0x12345678';
  assert.deepEqual(analyzePermissions(data).observations, []);
  data.trace.logs.push(event());
  const result = analyzePermissions(data);
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].kind, 'approval_event');
  assert.deepEqual(result.observations[0].matchedRequestIds, []);
});

test('approve returning false is not approval success despite successful EVM execution', () => {
  const result = analyzePermissions(input({ amount: MAX, output: word(0n), logs: [] }));
  assert.equal(result.observations[0].returnStatus, 'returned_false');
  assert.deepEqual(result.findings, []);
  assert.ok(result.warnings.some(warning => warning.includes('returned false')));
  const contradictory = analyzePermissions(input({ amount: MAX, output: word(0n) }));
  assert.ok(contradictory.coverage.reasons.some(reason => reason.includes('returned false')));
  assert.equal(contradictory.findings[0].basis, 'approval_event', 'even contradictory evidence must not be described as verified allowance');
});

test('hUSDC is configured, missing decimals are not guessed, and wrong-chain identities are unverified', () => {
  const data = input({ token: HUSDC });
  assert.equal(analyzePermissions(data).observations[0].asset.symbol, 'hHyperEvmUSDC');
  data.metadata = {};
  const missing = analyzePermissions(data);
  assert.equal(missing.observations[0].amount, null);
  assert.equal(missing.observations[0].amountRaw, '100000000');
  data.request.chainId = 1;
  const wrongChain = analyzePermissions(data);
  assert.equal(wrongChain.observations[0].kind, 'unverified_permission_call');
  assert.deepEqual(wrongChain.findings, []);
});

test('proxy delegate frames do not duplicate approve requests; only the proxy-emitted Approval is decoded', () => {
  const data = input();
  const delegated = { type: 'DELEGATECALL', from: USDC, to: UNKNOWN, input: data.trace.input, logs: data.trace.logs };
  data.trace.logs = [];
  data.trace.calls = [delegated];
  const result = analyzePermissions(data);
  assert.equal(result.observations.filter(item => item.kind === 'approval_request').length, 1);
  assert.equal(result.observations.filter(item => item.kind === 'approval_event').length, 1);
  assert.equal(result.observations[0].eventCorrelation, 'matched');
});

test('malformed ABI, NFT-shaped Approval, static calls, mismatched traces and missing traces are not interpreted as approvals', () => {
  const data = input({ logs: [] });
  data.request.data = data.trace.input = `${data.trace.input}00`;
  assert.deepEqual(analyzePermissions(data).observations, []);
  const nft = input({ logs: [{ ...event(), topics: [...event().topics, word(7n)], data: '0x' }] });
  assert.equal(analyzePermissions(nft).observations.length, 1, 'malformed event omitted; requested calldata remains');
  const staticCall = input(); staticCall.trace.type = 'STATICCALL';
  assert.deepEqual(analyzePermissions(staticCall).observations, []);
  const mismatched = input(); mismatched.trace.from = OTHER;
  assert.deepEqual(analyzePermissions(mismatched).observations, []);
  assert.deepEqual(analyzePermissions({ request: data.request, trace: null }).observations, []);
});

test('a parent approve cannot claim a nested approve event as its own confirmation', () => {
  const data = input({ logs: [] });
  data.trace.calls = [input({ logs: [event({ index: 1 })] }).trace];
  const result = analyzePermissions(data);
  const calls = result.observations.filter(observation => observation.kind === 'approval_request');
  assert.equal(calls[0].eventCorrelation, 'not_observed');
  assert.equal(calls[1].eventCorrelation, 'matched');
  assert.equal(result.observations.find(observation => observation.kind === 'approval_event').matchedRequestIds.length, 1);
});

test('conflicting indexed evidence is explicitly limited instead of silently double counted', () => {
  const result = analyzePermissions(input({ logs: [event(), event({ spender: OTHER })] }));
  assert.equal(result.observations.filter(observation => observation.kind === 'approval_event').length, 1);
  assert.ok(result.coverage.reasons.some(reason => reason.includes('Conflicting global Approval log indexes')));
});
