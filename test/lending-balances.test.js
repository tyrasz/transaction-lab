import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyzeTrace } from '../src/analyze.js';
import { measureLendingBalances } from '../src/lending-balances.js';
import { createStateContext, UINT256_MAX } from '../src/state.js';
import { USDC, HUSDC, VUSDC, METADATA } from '../src/config.js';

const observed = Object.fromEntries(await Promise.all(['withdraw', 'borrow', 'repay'].map(async operation => [operation, JSON.parse(await readFile(new URL(`../reports/lending-discovery/${operation}-evidence.json`, import.meta.url)))])));
const CALLER = '0x9a1dbc6a6e7e59f6beb23db0d00b603fc90e94d0';
const OTHER = '0x1111111111111111111111111111111111111111';
const word = amount => `0x${BigInt(amount).toString(16).padStart(64, '0')}`;
const addressWord = account => account.slice(2).padStart(64, '0');
const pairKey = (account, token) => `${account}:${token}`;

// These are synthetic RPC balance responses. The input and call traces are real
// captured observations; balance tests must not claim these mocks are on-chain evidence.
function setup(operation, { mutate, overrideCall } = {}) {
  const source = observed[operation];
  const header = structuredClone(source.currentBlock);
  const request = { ...structuredClone(source.captures.currentTrace.request.params[0]), chainId: 999 };
  const block = { number: BigInt(header.number).toString(), hash: header.hash, timestamp: BigInt(header.timestamp).toString() };
  const analysis = analyzeTrace({ request, block, metadata: METADATA, trace: source.captures.currentTrace.response.result });
  const input = { request, block, analysis, metadata: structuredClone(METADATA) };
  const delta = new Map();
  const put = (account, token, value) => delta.set(pairKey(account, token), BigInt(value));
  if (operation === 'withdraw') { put(CALLER, USDC, 503900226n); put(HUSDC, USDC, -503900226n); put(CALLER, HUSDC, -503900226n); }
  if (operation === 'borrow') { put(CALLER, USDC, 835474410n); put(HUSDC, USDC, -835474410n); put(CALLER, VUSDC, 835474410n); }
  if (operation === 'repay') { put(CALLER, USDC, -2n); put(HUSDC, USDC, 2n); put(CALLER, VUSDC, -2n); }
  const calls = [];
  input.rpc = { async call(method, params) {
    calls.push({ method, params });
    const custom = await overrideCall?.(method, params, input);
    if (custom !== undefined) return custom;
    if (method === 'eth_getBlockByHash' || method === 'eth_getBlockByNumber') return structuredClone(header);
    if (method === 'debug_traceCall') return { pre: { [USDC]: { storage: { [word(1)]: word(100) } } }, post: { [USDC]: { storage: { [word(1)]: word(101) } } } };
    if (method === 'eth_call') {
      const account = `0x${params[0].data.slice(-40)}`;
      const change = delta.get(pairKey(account, params[0].to)) ?? 0n;
      const baseline = change < 0n ? -change + 10000000n : 10000000n;
      return word(baseline + (params.length === 3 ? change : 0n));
    }
    throw new Error('Unexpected test RPC method');
  } };
  mutate?.(input, put, delta);
  return { input, calls, put };
}
const find = (result, account, token) => result.assets.find(entry => entry.account === account && entry.asset.address === token);

for (const [operation, cash, positionToken, position] of [
  ['withdraw', '503900226', HUSDC, '-503900226'],
  ['borrow', '835474410', VUSDC, '835474410'],
  ['repay', '-2', VUSDC, '-2'],
]) test(`${operation}: measured cash and position reconcile independently with reserve custody`, async () => {
  const { input, calls } = setup(operation);
  const result = await measureLendingBalances(input);
  assert.equal(result.status, 'measured');
  assert.equal(find(result, CALLER, USDC).deltaRaw, cash);
  assert.equal(find(result, HUSDC, USDC).deltaRaw, (-BigInt(cash)).toString());
  assert.equal(find(result, CALLER, positionToken).deltaRaw, position);
  assert.equal(find(result, CALLER, VUSDC).asset.role, 'liability');
  assert.equal(find(result, CALLER, VUSDC).asset.transferable, false);
  assert.ok(find(result, HUSDC, USDC).accountRoles.includes('reserve_custody'));
  assert.equal(result.assets.length, 6);
  assert.equal(calls.filter(call => call.method === 'debug_traceCall').length, 1);
  assert.equal(calls.filter(call => call.method === 'eth_call').length, 12);
  assert.equal(result.executionIdentity.stateBlockHash, input.block.hash);
  assert.equal(result.evidence.request.length, calls.length);
  assert.equal(result.evidence.response.length, calls.length);
  for (const call of calls.filter(call => ['eth_call', 'debug_traceCall'].includes(call.method))) assert.deepEqual(call.params[1], { blockHash: input.block.hash, requireCanonical: true });
  if (operation === 'repay') assert.ok(result.warnings.some(warning => warning.includes('caps repayment')));
});

test('trace-reconciled debt rounding is exact and never replaced by the cash amount', async () => {
  const { input } = setup('repay', { mutate: (input, put) => {
    input.analysis.protocol.actualAmountRaw = '199626280';
    input.analysis.protocol.positionDeltaRaw = '-199626279';
    put(CALLER, USDC, -199626280n); put(HUSDC, USDC, 199626280n); put(CALLER, VUSDC, -199626279n);
  } });
  const result = await measureLendingBalances(input);
  assert.equal(result.status, 'measured');
  assert.equal(find(result, CALLER, VUSDC).deltaRaw, '-199626279');
  assert.equal(find(result, CALLER, USDC).deltaRaw, '-199626280');
  assert.ok(result.warnings.some(warning => warning.includes('scaled-token rounding')));
});

test('withdrawal recipient and position owner remain distinct', async () => {
  const { input } = setup('withdraw', { mutate: (input, put) => {
    input.request.data = `${input.request.data.slice(0, -64)}${addressWord(OTHER)}`;
    input.analysis.protocol.recipient = OTHER;
    put(CALLER, USDC, 0n); put(OTHER, USDC, 503900226n);
  } });
  const result = await measureLendingBalances(input);
  assert.equal(result.status, 'measured');
  assert.equal(result.assets.length, 9);
  assert.equal(find(result, OTHER, USDC).deltaRaw, '503900226');
  assert.equal(find(result, CALLER, USDC).deltaRaw, '0');
  assert.equal(find(result, CALLER, HUSDC).deltaRaw, '-503900226');
  assert.deepEqual(find(result, OTHER, HUSDC).accountRoles, ['recipient']);
});

test('delegated borrow and third-party repay measure debt owner separately from cash account', async () => {
  for (const operation of ['borrow', 'repay']) {
    const { input } = setup(operation, { mutate: (input, put) => {
      input.request.data = `${input.request.data.slice(0, -64)}${addressWord(OTHER)}`;
      input.analysis.protocol.onBehalfOf = OTHER;
      input.analysis.protocol.positionAccount = OTHER;
      put(CALLER, VUSDC, 0n); put(OTHER, VUSDC, operation === 'borrow' ? 835474410n : -2n);
    } });
    const result = await measureLendingBalances(input);
    assert.equal(result.status, 'measured');
    assert.equal(find(result, CALLER, VUSDC).deltaRaw, '0');
    assert.equal(find(result, OTHER, USDC).deltaRaw, '0');
    assert.deepEqual(find(result, OTHER, VUSDC).accountRoles, ['position_owner']);
    assert.equal(find(result, CALLER, USDC).deltaRaw, operation === 'borrow' ? '835474410' : '-2');
  }
});

test('max sentinel measures actual cash without numeric precision loss or max-sized payment', async () => {
  const { input } = setup('repay', { mutate: input => {
    input.request.data = input.request.data.slice(0, 74) + word(UINT256_MAX).slice(2) + input.request.data.slice(138);
    input.analysis.protocol.amountRaw = UINT256_MAX.toString();
    input.analysis.protocol.amountMode = 'all';
  } });
  const result = await measureLendingBalances(input);
  assert.equal(result.status, 'measured');
  assert.equal(find(result, CALLER, USDC).deltaRaw, '-2');
});

test('unreconciled, reverted, unsupported, or mismatched requests perform no state RPC', async () => {
  const mutations = [
    input => { input.analysis.protocol.reconciliation.status = 'unreconciled'; },
    input => { input.analysis.coverage.status = 'partial'; },
    input => { input.analysis.execution.status = 'reverted'; },
    input => { input.analysis.protocol.positionAccount = OTHER; },
    input => { input.analysis.protocol.account = OTHER; },
    input => { input.analysis.protocol.recipient = OTHER; },
    input => { input.analysis.protocol.amountRaw = '7'; },
    input => { input.analysis.protocol.actualAmountRaw = '199626281'; },
    input => { input.analysis.protocol.positionDeltaRaw = '2'; },
    input => { input.request.value = '1'; },
    input => { input.request.chainId = 1; },
    input => { input.request.data += '00'; },
  ];
  for (const mutate of mutations) {
    const { input, calls } = setup('repay', { mutate });
    const result = await measureLendingBalances(input);
    assert.equal(result.status, 'not_applicable');
    assert.deepEqual(result.assets, []);
    assert.equal(calls.length, 0);
  }
});

test('one-unit cash, custody, position or unrelated-position disagreements fail closed', async () => {
  for (const [account, token, value] of [[CALLER, USDC, -3n], [HUSDC, USDC, 3n], [CALLER, VUSDC, -1n], [CALLER, HUSDC, 1n], [HUSDC, VUSDC, 1n]]) {
    const { input } = setup('repay', { mutate: (_input, put) => put(account, token, value) });
    const result = await measureLendingBalances(input);
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(result.assets, []);
    assert.ok(result.evidence.request.length > 0);
  }
});

test('unrelated user cash is also required to remain unchanged', async () => {
  const { input } = setup('withdraw', { mutate: (input, put) => {
    input.request.data = `${input.request.data.slice(0, -64)}${addressWord(OTHER)}`;
    input.analysis.protocol.recipient = OTHER;
    put(CALLER, USDC, 1n); put(OTHER, USDC, 503900226n);
  } });
  const result = await measureLendingBalances(input);
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.assets, []);
});

test('incomplete metadata and mismatched shared state context fail before state queries', async () => {
  const first = setup('borrow');
  delete first.input.metadata[VUSDC];
  assert.equal((await measureLendingBalances(first.input)).status, 'unavailable');
  assert.equal(first.calls.length, 0);
  const second = setup('borrow');
  second.input.stateContext = createStateContext({ ...second.input, request: { ...second.input.request, from: OTHER } });
  const result = await measureLendingBalances(second.input);
  assert.equal(result.status, 'unavailable');
  assert.equal(second.calls.length, 0);
  assert.ok(result.warnings.some(warning => warning.includes('does not match')));
});

test('a matching shared state context reuses its one prepared diff', async () => {
  const { input, calls } = setup('borrow');
  input.stateContext = createStateContext(input);
  await input.stateContext.prepare();
  const result = await measureLendingBalances(input);
  assert.equal(result.status, 'measured');
  assert.equal(calls.filter(call => call.method === 'debug_traceCall').length, 1);
});

test('reorg or malformed token result suppresses all balance output', async () => {
  for (const overrideCall of [
    method => method === 'eth_getBlockByNumber' ? { ...observed.borrow.currentBlock, hash: word(9) } : undefined,
    method => method === 'eth_call' ? '0x' : undefined,
  ]) {
    const { input } = setup('borrow', { overrideCall });
    const result = await measureLendingBalances(input);
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(result.assets, []);
  }
});

test('arbitrary provider errors do not leak credentials in warnings or evidence', async () => {
  const secret = 'https://secret:credential@example.invalid/private-key';
  const { input } = setup('repay', { overrideCall: () => { throw Object.assign(new Error(secret), { code: secret, detail: { body: secret } }); } });
  const result = await measureLendingBalances(input);
  assert.equal(result.status, 'unavailable');
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(result.evidence.response[0].error.code, 'RPC_ERROR');
});

test('captured public RPC state diffs and balance queries replay all three observed lending operations', async () => {
  const measured = JSON.parse(await readFile(new URL('../reports/lending-discovery/measured-current-balances.json', import.meta.url)));
  for (const saved of measured.cases) {
    const trace = observed[saved.operation].captures.currentTrace.response.result;
    const analysis = analyzeTrace({ request: saved.request, block: saved.block, trace, metadata: METADATA });
    const evidence = saved.balanceChanges.evidence;
    let cursor = 0;
    const rpc = { async call(method, params) {
      const request = evidence.request[cursor];
      const response = evidence.response[cursor++];
      assert.equal(method, request.method);
      assert.deepEqual(params, request.params);
      assert.equal(response.id, request.id);
      assert.equal(response.error, undefined);
      return structuredClone(response.result);
    } };
    const result = await measureLendingBalances({ request: saved.request, block: saved.block, rpc, metadata: METADATA, analysis });
    assert.equal(result.status, 'measured');
    assert.equal(cursor, evidence.request.length);
    assert.deepEqual(result.assets, saved.balanceChanges.assets);
    assert.equal(find(result, CALLER, USDC).deltaRaw, { withdraw: '503900226', borrow: '835474410', repay: '-2' }[saved.operation]);
    assert.equal(find(result, CALLER, saved.operation === 'withdraw' ? HUSDC : VUSDC).deltaRaw, { withdraw: '-503900226', borrow: '835474410', repay: '-2' }[saved.operation]);
  }
});
