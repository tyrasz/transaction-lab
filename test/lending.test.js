import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyzeTrace } from '../src/analyze.js';
import { decodeLendingCall, supportsLending } from '../src/lending.js';
import { POOL, USDC, HUSDC, VUSDC, METADATA } from '../src/config.js';

const ZERO = `0x${'0'.repeat(40)}`;
const CALLER = '0x1111111111111111111111111111111111111111';
const BENEFICIARY = '0x2222222222222222222222222222222222222222';
const OTHER = '0x4444444444444444444444444444444444444444';
const MAX = (1n << 256n) - 1n;
const RAY = 10n ** 27n;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const MINT = '0x458f5fa412d0f69b08dd84872b0215675cc67bc1d5b6fd93300a1c3878b86196';
const BURN = '0x4cf25bc1d991c17529c25213d3cc0cda295eeaad5f13f361969b12ea48015f90';
const OPERATION_TOPICS = {
  withdraw: '0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7',
  borrow: '0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0',
  repay: '0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051',
};
const word = amount => `0x${BigInt(amount).toString(16).padStart(64, '0')}`;
const addressWord = address => `0x${address.slice(2).padStart(64, '0')}`;
const encode = values => `0x${values.map(value => value.slice(2)).join('')}`;
const setArg = (data, index, value) => `${data.slice(0, 10 + index * 64)}${value.slice(2)}${data.slice(10 + (index + 1) * 64)}`;
const normalizeBlock = block => ({ number: BigInt(block.number).toString(), hash: block.hash, timestamp: BigInt(block.timestamp).toString() });

const observed = new Map();
for (const operation of ['withdraw', 'borrow', 'repay']) {
  const evidence = JSON.parse(await readFile(new URL(`../reports/lending-discovery/${operation}-evidence.json`, import.meta.url)));
  const transaction = evidence.captures.transaction.response.result;
  for (const variant of ['historical', 'current']) {
    observed.set(`${operation}-${variant}`, {
      request: { chainId: 999, from: transaction.from, to: transaction.to, data: transaction.input, value: BigInt(transaction.value).toString() },
      trace: evidence.captures[variant === 'historical' ? 'historicalTrace' : 'currentTrace'].response.result,
      block: normalizeBlock(variant === 'historical' ? evidence.captures.block.response.result : evidence.currentBlock),
      metadata: METADATA, mode: variant === 'historical' ? 'historical_trace' : 'simulation',
    });
  }
}

function frames(trace) { return [trace, ...(trace.calls ?? []).flatMap(frames)]; }
function logEntries(trace) { return frames(trace).flatMap(frame => (frame.logs ?? []).map(log => ({ frame, log }))); }
function findLog(input, token, topic) { return logEntries(input.trace).find(entry => entry.log.address.toLowerCase() === token && entry.log.topics[0] === topic).log; }
function observedInput(key) { return structuredClone(observed.get(key)); }

// Controlled evidence fixtures exercise parser invariants; they are not public executions.
function synthetic(operation, { requested = 100000000n, actual = requested, caller = CALLER, owner = caller, recipient = caller, interest = 0n, index = RAY, positionMint = operation === 'borrow' } = {}) {
  const token = operation === 'withdraw' ? HUSDC : VUSDC;
  const onBehalfOf = operation === 'withdraw' ? caller : owner;
  const selectors = { withdraw: '0x69328dec', borrow: '0xa415bcad', repay: '0x573ade81' };
  const args = operation === 'withdraw' ? [addressWord(USDC), word(requested), addressWord(recipient)] : operation === 'borrow' ? [addressWord(USDC), word(requested), word(2n), word(0n), addressWord(onBehalfOf)] : [addressWord(USDC), word(requested), word(2n), addressWord(onBehalfOf)];
  const request = { chainId: 999, from: caller, to: POOL, data: selectors[operation] + encode(args).slice(2), value: '0' };
  const q = operation === 'repay' ? actual * RAY / index : (actual * RAY + index - 1n) / index;
  const internalSelector = { withdraw: '0xb18d6afd', borrow: '0x9ceeaca7', repay: '0xf5298aca' }[operation];
  const internalArgs = operation === 'repay' ? [addressWord(onBehalfOf), word(q), word(index)] : [addressWord(caller), addressWord(operation === 'withdraw' ? recipient : onBehalfOf), word(actual), word(q), word(index)];
  const internalInput = internalSelector + encode(internalArgs).slice(2);
  const signedDelta = operation === 'borrow' ? actual : -actual;
  const eventValue = positionMint ? signedDelta + interest : -signedDelta - interest;
  assert.ok(eventValue >= 0n, 'test fixture event amount must be nonnegative');
  const actor = operation === 'borrow' ? caller : onBehalfOf;
  const target = positionMint ? onBehalfOf : operation === 'withdraw' ? recipient : ZERO;
  const positionLogs = [
    { address: token, topics: [TRANSFER, addressWord(positionMint ? ZERO : onBehalfOf), addressWord(positionMint ? onBehalfOf : ZERO)], data: word(eventValue), index: '0x0' },
    { address: token, topics: [positionMint ? MINT : BURN, addressWord(actor), addressWord(target)], data: encode([word(eventValue), word(interest), word(index)]), index: '0x1' },
  ];
  const operationTopics = operation === 'withdraw' ? [OPERATION_TOPICS[operation], addressWord(USDC), addressWord(caller), addressWord(recipient)] : operation === 'borrow' ? [OPERATION_TOPICS[operation], addressWord(USDC), addressWord(onBehalfOf), word(0n)] : [OPERATION_TOPICS[operation], addressWord(USDC), addressWord(onBehalfOf), addressWord(caller)];
  const operationData = operation === 'withdraw' ? [word(actual)] : operation === 'borrow' ? [addressWord(caller), word(actual), word(2n), word(0n)] : [word(actual), word(0n)];
  const trace = {
    type: 'CALL', from: caller, to: POOL, input: request.data, output: operation === 'borrow' ? '0x' : word(actual), gasUsed: '0x10000',
    calls: [{ type: 'CALL', from: POOL, to: token, input: internalInput, calls: [{ type: 'DELEGATECALL', from: token, to: token === HUSDC ? '0x410aa1ab680b886c875e99a7a4bfaf188508a7a3' : '0x8158e5569475a443a5723ccac462930f590449ed', input: internalInput, logs: positionLogs }] }],
    logs: [
      { address: USDC, topics: [TRANSFER, addressWord(operation === 'repay' ? caller : HUSDC), addressWord(operation === 'repay' ? HUSDC : recipient)], data: word(actual), index: '0x2' },
      { address: POOL, topics: operationTopics, data: encode(operationData), index: '0x3' },
    ],
  };
  return { request, trace, block: { number: '1', hash: word(1n), timestamp: '1' }, metadata: METADATA, mode: 'simulation' };
}

const EXPECTED = [
  ['withdraw-historical', '503900226', '-503900226', '15036'],
  ['withdraw-current', '503900226', '-503900226', '96645'],
  ['borrow-historical', '835474410', '835474410', '1738'],
  ['borrow-current', '835474410', '835474410', '0'],
  ['repay-historical', '199626280', '-199626279', '208'],
  ['repay-current', '2', '-2', '0'],
];
for (const [key, actual, delta, interest] of EXPECTED) test(`observed ${key} reconciles exact underlying and position evidence`, () => {
  const preview = analyzeTrace(observedInput(key));
  assert.equal(preview.execution.status, 'success');
  assert.equal(preview.coverage.status, 'supported');
  assert.equal(preview.protocol.operation, key.split('-')[0]);
  assert.equal(preview.protocol.actualAmountRaw, actual);
  assert.equal(preview.protocol.positionDeltaRaw, delta);
  assert.equal(preview.protocol.reconciliation.status, 'reconciled');
  assert.equal(preview.positionChanges[0].accruedInterestRaw, interest);
  assert.equal(preview.positionChanges[0].basis, 'position_event_minus_accrued_interest');
  assert.deepEqual(preview.security, { status: 'not_assessed', findings: [] });
  assert.ok([...preview.inAssets, ...preview.outAssets].every(asset => asset.asset.address !== VUSDC));
});

test('current repay is capped by actual outstanding debt instead of the larger requested amount', () => {
  const preview = analyzeTrace(observedInput('repay-current'));
  assert.equal(preview.protocol.amountRaw, '199626280');
  assert.equal(preview.protocol.actualAmountRaw, '2');
  assert.equal(preview.outAssets.find(item => item.asset.address === USDC).transferOut[0].value, '0.000002');
  assert.ok(preview.warnings.some(warning => warning.includes('capped by outstanding debt')));
});

test('malformed ABI length, padded addresses and overflowed referral code are not decoded', () => {
  for (const operation of ['withdraw', 'borrow', 'repay']) {
    const original = observedInput(`${operation}-current`).request;
    for (const data of [original.data.slice(0, -2), original.data + '00', setArg(original.data, 0, `0x01${addressWord(USDC).slice(4)}`)]) {
      assert.equal(decodeLendingCall({ ...original, data }, METADATA), null);
    }
  }
  const borrow = observedInput('borrow-current').request;
  assert.equal(decodeLendingCall({ ...borrow, data: setArg(borrow.data, 3, word(65536n)) }, METADATA), null);
});

test('unknown assets, rate modes and pool addresses never receive supported lending coverage', () => {
  for (const operation of ['withdraw', 'borrow', 'repay']) {
    const input = observedInput(`${operation}-current`);
    input.request.data = setArg(input.request.data, 0, addressWord(OTHER));
    input.trace.input = input.request.data;
    const decoded = decodeLendingCall(input.request, METADATA);
    assert.equal(supportsLending(decoded), false);
    assert.equal(decoded.positionToken, null);
    assert.equal(decoded.positionAccount, null);
    if (operation === 'repay') assert.equal(decoded.recipient, null);
    assert.notEqual(analyzeTrace(input).coverage.status, 'supported');
  }
  for (const operation of ['borrow', 'repay']) for (const mode of [0n, 1n, 3n, MAX]) {
    const input = observedInput(`${operation}-current`);
    input.request.data = setArg(input.request.data, 2, word(mode));
    input.trace.input = input.request.data;
    const decoded = decodeLendingCall(input.request, METADATA);
    assert.equal(decoded.positionToken, null);
    assert.equal(decoded.positionAccount, null);
    if (operation === 'repay') assert.equal(decoded.recipient, null);
    assert.notEqual(analyzeTrace(input).coverage.status, 'supported');
  }
  const wrongPool = observedInput('borrow-current');
  wrongPool.request.to = OTHER; wrongPool.trace.to = OTHER;
  assert.equal(analyzeTrace(wrongPool).protocol, null);
});

test('wrong pool events, transferred amounts, recipients or return values downgrade coverage', () => {
  const mutations = [
    input => { findLog(input, POOL, OPERATION_TOPICS.withdraw).address = OTHER; },
    input => { findLog(input, POOL, OPERATION_TOPICS.withdraw).topics[3] = addressWord(OTHER); },
    input => { findLog(input, USDC, TRANSFER).data = word(1n); },
    input => { findLog(input, USDC, TRANSFER).topics[2] = addressWord(OTHER); },
    input => { input.trace.output = word(1n); },
  ];
  for (const mutate of mutations) {
    const input = observedInput('withdraw-current'); mutate(input);
    const preview = analyzeTrace(input);
    assert.equal(preview.coverage.status, 'partial');
    assert.equal(preview.protocol.reconciliation.status, 'unreconciled');
  }
});

test('repayment can emit a Mint when accrued interest exceeds the position reduction', () => {
  const preview = analyzeTrace(synthetic('repay', { actual: 50n, requested: 50n, interest: 100n, positionMint: true }));
  assert.equal(preview.coverage.status, 'supported');
  assert.equal(preview.positionChanges[0].event, 'Mint');
  assert.equal(preview.positionChanges[0].valueRaw, '50');
  assert.equal(preview.positionChanges[0].accruedInterestRaw, '100');
  assert.equal(preview.positionChanges[0].deltaRaw, '-50');
  assert.equal(preview.positionChanges[0].role, 'liability');
  assert.deepEqual(preview.inAssets, []);
  assert.deepEqual(preview.outAssets.map(item => item.asset.address), [USDC]);
});

test('changed position implementation or an incorrect scaled amount fails reconciliation', () => {
  for (const operation of ['withdraw', 'borrow', 'repay']) for (const mutation of ['implementation', 'scaled']) {
    const input = synthetic(operation);
    const positionCall = input.trace.calls[0];
    if (mutation === 'implementation') positionCall.calls[0].to = OTHER;
    else {
      positionCall.input = setArg(positionCall.input, operation === 'repay' ? 1 : 3, word(1n));
      positionCall.calls[0].input = positionCall.input;
    }
    assert.equal(analyzeTrace(input).coverage.status, 'partial');
  }
});

test('a verified sibling delegatecall cannot authenticate events from an unknown implementation', () => {
  for (const operation of ['withdraw', 'borrow', 'repay']) {
    const input = synthetic(operation);
    const positionCall = input.trace.calls[0];
    const verified = positionCall.calls[0];
    const unknown = structuredClone(verified);
    unknown.to = OTHER;
    verified.logs = [];
    positionCall.calls.push(unknown);
    assert.equal(analyzeTrace(input).coverage.status, 'partial', 'position events must belong to the verified implementation execution, not merely to its parent proxy call');
  }
});

test('top-level revert discards position evidence; reverted position subtree cannot support success', () => {
  const root = observedInput('borrow-current'); root.trace.error = 'execution reverted';
  const failed = analyzeTrace(root);
  assert.equal(failed.execution.status, 'reverted');
  assert.deepEqual(failed.positionChanges, []);
  assert.deepEqual(failed.movements, []);
  const inner = synthetic('borrow'); inner.trace.calls[0].error = 'execution reverted';
  const preview = analyzeTrace(inner);
  assert.equal(preview.execution.status, 'success');
  assert.equal(preview.coverage.status, 'partial');
  assert.deepEqual(preview.positionChanges, []);
  assert.deepEqual(preview.inAssets.map(item => item.asset.address), [USDC]);
});

test('borrow on behalf of another account separates caller cash from beneficiary liability', () => {
  const preview = analyzeTrace(synthetic('borrow', { owner: BENEFICIARY }));
  assert.equal(preview.coverage.status, 'supported');
  assert.equal(preview.protocol.account, CALLER);
  assert.equal(preview.protocol.positionAccount, BENEFICIARY);
  assert.equal(preview.protocol.recipient, CALLER);
  assert.equal(preview.positionChanges[0].account, BENEFICIARY);
  assert.deepEqual(preview.inAssets.map(item => item.asset.address), [USDC]);
});

test('repay on behalf of another account spends caller USDC and reduces the other liability', () => {
  const preview = analyzeTrace(synthetic('repay', { owner: BENEFICIARY }));
  assert.equal(preview.coverage.status, 'supported');
  assert.equal(preview.protocol.account, CALLER);
  assert.equal(preview.positionChanges[0].account, BENEFICIARY);
  assert.deepEqual(preview.inAssets, []);
  assert.deepEqual(preview.outAssets.map(item => item.asset.address), [USDC]);
});

test('withdrawal to another recipient does not fabricate incoming cash for the caller', () => {
  const preview = analyzeTrace(synthetic('withdraw', { recipient: BENEFICIARY }));
  assert.equal(preview.coverage.status, 'supported');
  assert.equal(preview.protocol.recipient, BENEFICIARY);
  assert.equal(preview.positionChanges[0].account, CALLER);
  assert.deepEqual(preview.inAssets, []);
  assert.deepEqual(preview.outAssets.map(item => item.asset.address), [HUSDC]);
});

test('maximum withdrawal and repayment are request modes, with finite actual amounts kept separately', () => {
  for (const operation of ['withdraw', 'repay']) {
    const preview = analyzeTrace(synthetic(operation, { requested: MAX, actual: 100n }));
    assert.equal(preview.coverage.status, 'supported');
    assert.equal(preview.protocol.amountMode, 'all');
    assert.equal(preview.protocol.amountRaw, MAX.toString());
    assert.equal(preview.protocol.actualAmountRaw, '100');
    assert.equal(preview.protocol.positionDeltaRaw, '-100');
    assert.ok([...preview.inAssets, ...preview.outAssets].flatMap(a => [...a.transferIn, ...a.transferOut]).every(transfer => BigInt(transfer.rawValue) === 100n));
  }
  const request = synthetic('borrow', { requested: MAX, actual: 100n }).request;
  assert.equal(decodeLendingCall(request, METADATA).amountMode, 'exact', 'borrow has no withdraw-all sentinel');
});

test('withdraw-all position reduction must equal the entire reported underlying balance exactly', () => {
  const valid = synthetic('withdraw', { requested: MAX, actual: 100n, index: 15n * RAY / 10n });
  assert.equal(analyzeTrace(valid).coverage.status, 'supported');
  const inconsistent = structuredClone(valid);
  const positionTransfer = findLog(inconsistent, HUSDC, TRANSFER);
  const positionBurn = findLog(inconsistent, HUSDC, BURN);
  positionTransfer.data = word(101n);
  positionBurn.data = encode([word(101n), word(0n), word(15n * RAY / 10n)]);
  const preview = analyzeTrace(inconsistent);
  assert.equal(preview.coverage.status, 'partial', 'burning all q shares gives a zero post-balance; its balance delta is exactly minus floor(q*index/RAY), not either rounding endpoint');
});

test('repay-all or debt-capped repayment must reduce the full outstanding liability exactly', () => {
  for (const requested of [MAX, 1000n]) {
    const valid = synthetic('repay', { requested, actual: 101n, index: 15n * RAY / 10n });
    assert.equal(analyzeTrace(valid).coverage.status, 'supported');
    const inconsistent = structuredClone(valid);
    findLog(inconsistent, VUSDC, TRANSFER).data = word(100n);
    findLog(inconsistent, VUSDC, BURN).data = encode([word(100n), word(0n), word(15n * RAY / 10n)]);
    assert.equal(analyzeTrace(inconsistent).coverage.status, 'partial', 'repayment capped below the request burns all scaled debt; a one-unit residual is inconsistent with the cap evidence');
  }
});

test('duplicate operation events and extra token movements prevent complete reconciliation', () => {
  const duplicate = synthetic('repay');
  duplicate.trace.logs.push({ ...structuredClone(duplicate.trace.logs[1]), index: '0x8' });
  assert.equal(analyzeTrace(duplicate).coverage.status, 'partial');
  const additional = synthetic('borrow');
  additional.trace.logs.push({ address: HUSDC, topics: [TRANSFER, addressWord(ZERO), addressWord(CALLER)], data: word(1n), index: '0x8' });
  assert.equal(analyzeTrace(additional).coverage.status, 'partial');
});
