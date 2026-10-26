import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { measureAffectedBalances } from '../src/affected-balances.js';
import { failState } from '../src/state.js';
import { CHAIN_ID, USDC, HUSDC, VUSDC, METADATA } from '../src/config.js';

const address = n => '0x' + BigInt(n).toString(16).padStart(40, '0');
const word = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const aw = value => value.slice(2).padStart(64, '0');
const OWNER = address(1), RECIPIENT = address(2), ROUTER = address(3), SUBMITTER = address(4), ZERO = address(0);
const MAX = (1n << 256n) - 1n;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const IMPLEMENTATIONS = { [USDC]: '0x003f73f58ca78880da3642c5cb71d7459b3fe4f8', [HUSDC]: '0x410aa1ab680b886c875e99a7a4bfaf188508a7a3', [VUSDC]: '0x8158e5569475a443a5723ccac462930f590449ed' };
const event = ({ token = USDC, from = OWNER, to = RECIPIENT, amount = 100n, index = 0 } = {}) => ({ address: token, topics: [TRANSFER, '0x' + aw(from), '0x' + aw(to)], data: word(amount), ...(index === null ? {} : { index: '0x' + index.toString(16) }) });
function tokenCall({ token = USDC, owner = OWNER, recipient = RECIPIENT, amount = 100n, output = word(1n), events = true, index = 0, transferFrom = true } = {}) {
  const input = transferFrom ? `0x23b872dd${aw(owner)}${aw(recipient)}${word(amount).slice(2)}` : '0x12345678';
  return { type: 'CALL', from: ROUTER, to: token, input, output, value: '0x0', gasUsed: '0x1000', calls: [
    { type: 'DELEGATECALL', from: token, to: IMPLEMENTATIONS[token] ?? address(99), input, output, value: '0x0', gasUsed: '0xf00', logs: events ? [event({ token, from: owner, to: recipient, amount, index })] : [] },
  ] };
}
function setup(options = {}) {
  const request = { chainId: CHAIN_ID, from: SUBMITTER, to: ROUTER, data: '0x12345678', value: '0' };
  const block = { hash: word(42), number: '42', timestamp: '2000' };
  const trace = { type: 'CALL', from: SUBMITTER, to: ROUTER, input: request.data, output: '0x', value: '0x0', gasUsed: '0x2000', calls: [tokenCall(options)] };
  return { request, trace, block, metadata: structuredClone(METADATA), rpc: {} };
}
function contextFor(input, { historical = true, values = new Map(), mutate, error } = {}) {
  const queries = [], evidence = { request: [], response: [] };
  const identity = historical ? { stateBlockHash: input.block.hash, blockNumber: input.block.number, timestamp: input.block.timestamp, transactionHash: word(99), transactionIndex: '1', postTransactionIndex: '2', stateBinding: 'block_hash_and_transaction_index', headerContext: 'original_block', method: 'debug_traceCallMany' } : { stateBlockHash: input.block.hash, blockNumber: input.block.number, timestamp: input.block.timestamp, stateBinding: 'block_hash', headerContext: 'unchanged', method: 'debug_traceCall/prestateTracer + eth_call/stateDiff' };
  const stateContext = {
    ...(historical ? { measurementBasis: 'historical_transaction_position_balanceOf' } : {}),
    matches: ({ request, block, rpc }) => request === input.request && block === input.block && rpc === input.rpc,
    async prepare() {}, executionIdentity: identity, canonicalFailure: null,
    async readPair(query) {
      queries.push(query);
      if (error) throw error;
      const account = '0x' + query.data.slice(-40), key = `${query.to}:${account}`;
      const [before, after] = values.get(key) ?? [0n, 0n];
      evidence.request.push({ id: queries.length, query }); evidence.response.push({ id: queries.length, result: [before.toString(), after.toString()] });
      return { before, after, delta: after - before };
    },
    async verifyCanonical() {}, snapshotEvidence: () => structuredClone(evidence),
  };
  mutate?.(stateContext);
  return { stateContext, queries, identity };
}
async function run(input, options = {}) {
  const context = contextFor(input, options);
  return { result: await measureAffectedBalances({ ...input, ...context }), ...context };
}
const pairs = result => result.assets.map(asset => `${asset.asset.address}:${asset.account}`).sort();

test('exact uint256 state is independent of event amounts and owner differs from submitter', async () => {
  const input = setup({ amount: MAX });
  const values = new Map([[`${USDC}:${OWNER}`, [MAX, MAX - 7n]], [`${USDC}:${RECIPIENT}`, [0n, 6n]]]);
  const { result, queries } = await run(input, { values });
  assert.equal(result.status, 'measured'); assert.equal(result.candidatePairCount, 2);
  assert.deepEqual(pairs(result), [`${USDC}:${OWNER}`, `${USDC}:${RECIPIENT}`]);
  assert.equal(queries.length, 2);
  assert.equal(result.assets[0].beforeRaw, MAX.toString()); assert.equal(result.assets[0].deltaRaw, '-7');
  assert.equal(result.assets[1].delta, '0.000006');
  assert.equal(result.assets[0].consistency.eventNetRaw, (-MAX).toString());
  assert.equal(result.assets[0].consistency.eventComparison, 'differs_from_event_net');
  assert.equal(result.assets[0].candidateEvidence.transferCalls[0].spender, ROUTER);
  assert.equal(result.assets[0].candidateEvidence.transferCalls[0].submitter, SUBMITTER);
  assert.equal(result.assets.some(entry => entry.account === ROUTER || entry.account === SUBMITTER), false);
});

test('false-returning transferFrom remains a candidate without inventing movement', async () => {
  const input = setup({ events: false, output: word(0n) });
  const { result } = await run(input);
  assert.equal(result.status, 'measured'); assert.equal(result.assets.length, 2);
  for (const entry of result.assets) {
    assert.equal(entry.deltaRaw, '0'); assert.equal(entry.consistency.eventComparison, 'no_event');
    assert.equal(entry.consistency.eventNetRaw, null);
    assert.equal(entry.candidateEvidence.transferCalls[0].returnStatus, 'returned_false');
  }
});

test('hUSDC and variable debt events preserve interest differences and liability metadata', async () => {
  for (const token of [HUSDC, VUSDC]) {
    const input = setup({ token, owner: ZERO, amount: 120n, transferFrom: false });
    const { result } = await run(input, { historical: true, values: new Map([[`${token}:${RECIPIENT}`, [1000n, 1100n]]]) });
    assert.equal(result.status, 'measured'); assert.equal(result.assets.length, 1);
    assert.equal(result.basis, 'historical_transaction_position_balanceOf');
    const asset = result.assets[0];
    assert.equal(asset.deltaRaw, '100'); assert.equal(asset.consistency.eventNetRaw, '120');
    assert.equal(asset.consistency.eventComparison, 'differs_from_event_net');
    assert.equal(asset.asset.role, token === VUSDC ? 'liability' : 'receipt_token');
    if (token === VUSDC) assert.equal(asset.asset.transferable, false);
  }
});

test('self transfers retain gross totals and zero net; zero-address mint/burn legs are excluded', async () => {
  const input = setup({ recipient: OWNER });
  const { result } = await run(input);
  assert.equal(result.assets.length, 1);
  assert.deepEqual(result.assets[0].consistency, {
    eventComparison: 'matches_event_net', eventIncomingRaw: '100', eventOutgoingRaw: '100', eventNetRaw: '0',
    explanation: result.assets[0].consistency.explanation,
  });
  assert.equal(result.assets[0].candidateEvidence.transferEvents.length, 1);
  for (const options of [{ owner: ZERO }, { recipient: ZERO }]) {
    const { result: measured } = await run(setup(options));
    assert.equal(measured.assets.length, 1); assert.notEqual(measured.assets[0].account, ZERO);
  }
});

test('successful siblings survive failed/static branches and removed logs', async () => {
  const input = setup();
  const reverted = tokenCall({ owner: address(10), recipient: address(11), index: 1 });
  reverted.error = 'execution reverted';
  const staticBranch = { type: 'STATICCALL', from: ROUTER, to: ROUTER, input: '0x', output: '0x', calls: [tokenCall({ owner: address(12), recipient: address(13), index: 2 })] };
  const removed = tokenCall({ owner: address(14), recipient: address(15), index: 3, transferFrom: false }); removed.calls[0].logs[0].removed = true;
  input.trace.calls.push(reverted, staticBranch, removed);
  const { result } = await run(input);
  assert.equal(result.status, 'measured'); assert.deepEqual(pairs(result), [`${USDC}:${OWNER}`, `${USDC}:${RECIPIENT}`]);
});

test('failed root and unsupported chain perform no state reads', async () => {
  for (const mutate of [input => { input.trace.error = 'execution reverted'; }, input => { input.request.chainId = 1; }, input => { input.request.value = '1'; }]) {
    const input = setup(); mutate(input);
    const { result, queries } = await run(input);
    assert.equal(result.status, 'not_applicable'); assert.equal(queries.length, 0);
  }
});

test('supplied forged analysis and permissions cannot add participants or suppress actual trace evidence', async () => {
  const input = setup();
  input.analysis = { execution: { status: 'reverted' }, movements: [{ from: address(91), to: address(92), address: USDC }] };
  input.permissions = { observations: [{ kind: 'transfer_from_call', tokenVerified: true, asset: { address: USDC }, owner: address(93), recipient: address(94) }] };
  const { result } = await run(input);
  assert.equal(result.status, 'measured'); assert.deepEqual(pairs(result), [`${USDC}:${OWNER}`, `${USDC}:${RECIPIENT}`]);
});

test('unknown token events do not block configured participants or become measurement targets', async () => {
  const input = setup(); input.trace.calls.push(tokenCall({ token: address(99), owner: address(5), recipient: address(6), index: 1 }));
  const { result } = await run(input);
  assert.equal(result.status, 'measured'); assert.equal(result.assets.length, 2);
  assert.match(result.warnings.join(' '), /unconfigured token/);
  const onlyUnknown = setup({ token: address(99) });
  const empty = await run(onlyUnknown); assert.equal(empty.result.status, 'not_applicable'); assert.equal(empty.queries.length, 0);
});

test('strict root identity and caller provenance reject stale or malformed traces before RPC', async () => {
  for (const mutate of [
    input => { input.trace.from = address(91); }, input => { input.trace.to = address(91); },
    input => { input.trace.input = '0x87654321'; }, input => { input.trace.value = '0x1'; },
    input => { input.trace.calls[0].from = address(91); }, input => { input.trace.calls[0].calls[0].from = address(91); },
    input => { input.trace.input = [input.trace.input]; }, input => { input.trace.gasUsed = {}; },
    input => { input.trace.calls = {}; }, input => { input.trace.calls[0].error = { message: 'poison' }; },
    input => { input.trace.calls[0].output = null; }, input => { input.trace.calls[0].value = null; },
    input => { input.trace.calls[0].input = null; },
  ]) {
    const input = setup(); mutate(input);
    const { result, queries } = await run(input);
    assert.equal(result.status, 'unavailable'); assert.deepEqual(result.assets, []); assert.equal(queries.length, 0);
  }
});

test('configured event provenance requires the exact known token delegate and canonical ABI', async () => {
  for (const mutate of [
    frame => { frame.calls[0].to = address(99); }, frame => { frame.calls[0].type = 'CALL'; },
    frame => { frame.calls[0].input = '0x'; }, frame => { frame.calls[0].output = '0x'; },
    frame => { frame.calls[0].value = '0x1'; }, frame => { frame.calls.push(structuredClone(frame.calls[0])); },
    frame => { frame.calls[0].logs[0].topics[1] = word(1n << 200n); },
    frame => { frame.calls[0].logs[0].topics[1] = [frame.calls[0].logs[0].topics[1]]; },
    frame => { frame.calls[0].logs[0].data = '0x01'; }, frame => { frame.calls[0].logs[0].topics.push(word(0)); },
    frame => { frame.calls[0].logs[0].logIndex = '0x2'; },
  ]) {
    const input = setup(); mutate(input.trace.calls[0]);
    const { result, queries } = await run(input);
    assert.equal(result.status, 'unavailable'); assert.equal(queries.length, 0);
  }
});

test('noncanonical transferFrom arguments without events cannot create candidates', async () => {
  const input = setup({ events: false });
  input.trace.calls[0].input += '00'; input.trace.calls[0].calls[0].input += '00';
  const { result, queries } = await run(input);
  assert.equal(result.status, 'not_applicable'); assert.equal(queries.length, 0);
});

test('same frame and indexed log duplicates do not overcount but conflicting indexes fail closed', async () => {
  const input = setup(); input.trace.calls.push(input.trace.calls[0], structuredClone(input.trace.calls[0]));
  const { result } = await run(input);
  assert.equal(result.status, 'measured'); assert.equal(result.assets[0].consistency.eventOutgoingRaw, '100');
  assert.equal(result.assets[0].candidateEvidence.transferCalls.length, 2, 'separately represented calls retain independent request evidence');
  input.trace.calls[2].calls[0].logs[0].data = word(101);
  assert.equal((await run(input)).result.status, 'unavailable');
});

test('unindexed separate identical events remain separate observations', async () => {
  const input = setup({ index: null, transferFrom: false });
  input.trace.calls.push(structuredClone(input.trace.calls[0]));
  const { result } = await run(input);
  assert.equal(result.status, 'measured'); assert.equal(result.assets[0].consistency.eventOutgoingRaw, '200');
});

test('temporary lifecycle frames are rejected even under reverted/static ancestors before any RPC', async () => {
  for (const type of ['CREATE', 'CREATE2', 'SELFDESTRUCT']) for (const kind of ['success', 'reverted', 'static']) {
    const input = setup();
    const branch = { type: kind === 'static' ? 'STATICCALL' : 'CALL', from: ROUTER, to: ROUTER, input: '0x', output: '0x', ...(kind === 'reverted' ? { error: 'execution reverted' } : {}), calls: [{ type }] };
    input.trace.calls.push(branch);
    const context = contextFor(input); let prepared = false; context.stateContext.prepare = async () => { prepared = true; };
    const result = await measureAffectedBalances({ ...input, ...context });
    assert.equal(result.status, 'unavailable'); assert.match(result.warnings.at(-1), /creation or destruction/); assert.equal(prepared, false);
  }
});

test('eight-pair candidate limit includes reused pairs, and a ninth never truncates', async () => {
  const input = setup(); input.trace.calls = [];
  for (let i = 0; i < 4; i++) input.trace.calls.push(tokenCall({ owner: address(10 + i * 2), recipient: address(11 + i * 2), index: i }));
  const first = await run(input); assert.equal(first.result.status, 'measured'); assert.equal(first.result.assets.length, 8);
  input.existingBalanceChanges = first.result;
  input.trace.calls.push(tokenCall({ owner: address(10), recipient: address(30), index: 4 }));
  const exceeded = await run(input);
  assert.equal(exceeded.result.status, 'unavailable'); assert.deepEqual(exceeded.result.assets, []); assert.deepEqual(exceeded.result.reusedPairs, []); assert.equal(exceeded.queries.length, 0);
  assert.match(exceeded.result.warnings.at(-1), /including already measured/);
});

test('frame, depth, event and cyclic resource limits fail before measurement', async () => {
  for (const kind of ['frames', 'depth', 'events', 'logs', 'permissions', 'cycle']) {
    const input = setup();
    if (kind === 'frames') input.trace.calls.push(...Array.from({ length: 1000 }, () => ({ type: 'CALL', from: ROUTER, to: ROUTER, input: '0x' })));
    if (kind === 'depth') { let frame = input.trace; for (let i = 0; i < 34; i++) { const child = { type: 'CALL', from: ROUTER, to: ROUTER, input: '0x', calls: [] }; frame.calls.push(child); frame = child; } }
    if (kind === 'events') input.trace.calls[0].calls[0].logs = Array.from({ length: 257 }, (_, index) => event({ index }));
    if (kind === 'logs') input.trace.calls[0].calls[0].logs = Array.from({ length: 2001 }, () => ({ address: address(99), topics: [], data: '0x' }));
    if (kind === 'permissions') input.trace.calls[0].calls[0].logs.push(...Array.from({ length: 257 }, (_, index) => ({ address: USDC, topics: ['0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925', '0x' + aw(OWNER), '0x' + aw(ROUTER)], data: word(1), index: index + 1 })));
    if (kind === 'cycle') input.trace.calls.push(input.trace);
    const { result, queries } = await run(input); assert.equal(result.status, 'unavailable'); assert.equal(queries.length, 0);
  }
});

test('reuse requires exact identity/basis, unique valid pairs, and independent same-context value proof', async () => {
  {
    const historical = true;
    const input = setup(), original = await run(input, { historical });
    input.existingBalanceChanges = original.result;
    const reused = await run(input, { historical });
    assert.equal(reused.result.status, 'measured'); assert.deepEqual(reused.result.assets, []); assert.equal(reused.result.reusedPairs.length, 2);
    assert.equal(reused.queries.length, 2, 'module always asks context for proof; the context may reuse its own cached query');
    assert.deepEqual(reused.result.reusedPairs.map(pair => pair.balanceChangeIndex), [0, 1]);
    for (const mutate of [
      result => { result.executionIdentity.stateBlockHash = word(43); },
      result => { result.executionIdentity.transactionIndex = '2'; }, result => { result.basis = 'event_net'; },
      result => { result.assets.push(structuredClone(result.assets[0])); },
      result => { result.assets[0].afterRaw = '1'; },
      result => { result.assets[0].afterRaw = '1'; result.assets[0].deltaRaw = '1'; },
    ]) {
      input.existingBalanceChanges = structuredClone(original.result); mutate(input.existingBalanceChanges);
      const denied = await run(input, { historical });
      assert.equal(denied.result.status, 'unavailable'); assert.deepEqual(denied.result.reusedPairs, []); assert.deepEqual(denied.result.assets, []);
    }
  }
});

test('partial reuse retains only additional independently measured assets', async () => {
  const input = setup();
  input.existingBalanceChanges = (await run(input)).result;
  input.existingBalanceChanges.assets.pop();
  const { result } = await run(input);
  assert.equal(result.status, 'measured'); assert.equal(result.assets.length, 1); assert.equal(result.reusedPairs.length, 1);
  assert.equal(result.assets[0].account, RECIPIENT); assert.equal(result.reusedPairs[0].account, OWNER);
});

test('metadata, mismatching context, malformed amounts and poisoned exceptions fail closed', async () => {
  for (const options of [
    { mutate: context => { context.matches = () => false; } },
    { mutate: context => { context.executionIdentity.blockNumber = '43'; } },
    { mutate: context => { context.readPair = async () => ({ before: 0n, after: MAX + 1n, delta: MAX + 1n }); } },
    { mutate: context => { context.readPair = async () => ({ before: '0', after: '0', delta: '0' }); } },
    { error: new Error('PRIVATE_PROVIDER_TOKEN') },
  ]) {
    const { result } = await run(setup(), options);
    assert.equal(result.status, 'unavailable'); assert.deepEqual(result.assets, []); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROVIDER_TOKEN/);
  }
  for (const mutate of [metadata => { metadata[USDC].decimals = 18; }, metadata => { metadata[USDC].address = HUSDC; }]) {
    const input = setup(); mutate(input.metadata); const { result, queries } = await run(input);
    assert.equal(result.status, 'unavailable'); assert.equal(queries.length, 0);
  }
});

test('canonical failure, including a previous shared failure, withholds all new and reused results', async () => {
  for (const mutation of [
    context => { context.canonicalFailure = 'Previously noncanonical'; },
    context => { context.verifyCanonical = async () => { context.canonicalFailure = 'Changed block'; failState('Changed block'); }; },
    context => { context.verifyCanonical = async () => { context.canonicalFailure = 'Concurrent failure'; }; },
  ]) {
    const { result } = await run(setup(), { mutate: mutation });
    assert.equal(result.status, 'unavailable'); assert.deepEqual(result.assets, []); assert.deepEqual(result.reusedPairs, []); assert.equal(result.executionIdentity, undefined);
  }
});

test('current affected queries remain unavailable until both implementation paths are validated, without RPC or context preparation', async () => {
  for (const withContext of [false, true]) {
    const input = setup(); let calls = 0, prepared = false;
    input.rpc = { async call() { calls++; throw new Error('No current RPC should run'); } };
    if (withContext) {
      input.stateContext = contextFor(input, { historical: false }).stateContext;
      input.stateContext.prepare = async () => { prepared = true; };
    }
    const result = await measureAffectedBalances(input);
    assert.equal(result.status, 'unavailable'); assert.equal(result.candidatePairCount, 2);
    assert.equal(result.basis, 'prestate_diff_balanceOf'); assert.deepEqual(result.assets, []); assert.deepEqual(result.reusedPairs, []);
    assert.equal(calls, 0); assert.equal(prepared, false); assert.deepEqual(result.evidence, { request: [], response: [] });
    assert.match(result.warnings.at(-1), /implementation provenance is not validated/);
  }
});

test('observed supply trace identifies USDC sender/custody and hUSDC beneficiary; synthetic query values are separate', async () => {
  const fixture = JSON.parse(await readFile(new URL('../fixtures/hyperlend-observed-supply.json', import.meta.url)));
  const input = { ...fixture.input, block: { number: '42', hash: word(42), timestamp: '2000' }, rpc: {}, metadata: METADATA };
  const { result } = await run(input);
  assert.equal(result.status, 'measured'); assert.equal(result.candidatePairCount, 3);
  assert.deepEqual(pairs(result), [`${USDC}:${input.request.from}`, `${USDC}:${HUSDC}`, `${HUSDC}:${input.request.from}`].sort());
  const receiptToken = result.assets.find(entry => entry.asset.address === HUSDC);
  assert.equal(receiptToken.consistency.eventNetRaw, '15066912');
  assert.equal(receiptToken.deltaRaw, '0', 'only the synthetic independent context returned zero; no live balance claim');
});

test('observed router trace selects exactly five USDC participants with independent net-event arithmetic', async () => {
  const saved = JSON.parse(await readFile(new URL('../reports/permission-discovery/router-permit-candidate-verified.json', import.meta.url)));
  const tx = saved.captures.transaction.response.result, trace = saved.captures.callTrace.response.result;
  const input = { request: { chainId: CHAIN_ID, from: tx.from, to: tx.to, data: tx.input, value: tx.value }, trace, block: { hash: tx.blockHash, number: BigInt(tx.blockNumber).toString(), timestamp: '1' }, metadata: METADATA, rpc: {} };
  const { result, queries } = await run(input, { historical: true });
  assert.equal(result.status, 'measured'); assert.equal(result.assets.length, 5); assert.equal(queries.length, 5);
  assert.equal(result.assets.every(entry => entry.asset.address === USDC), true);
  const nets = result.assets.map(entry => entry.consistency.eventNetRaw).sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
  assert.deepEqual(nets, ['-25000000', '0', '196', '187500', '24812304']);
  const router = result.assets.find(entry => entry.account === tx.to);
  assert.equal(router.consistency.eventIncomingRaw, '25000000'); assert.equal(router.consistency.eventOutgoingRaw, '25000000');
  assert.equal(router.candidateEvidence.transferCalls.length, 2);
  assert.equal(result.warnings.some(warning => warning.includes('unconfigured token')), true);
});

test('all six observed lending traces select known cash and position participants with preserved debt roles', async () => {
  for (const operation of ['withdraw', 'borrow', 'repay']) {
    const saved = JSON.parse(await readFile(new URL(`../reports/lending-discovery/${operation}-evidence.json`, import.meta.url)));
    const tx = saved.captures.transaction.response.result;
    for (const kind of ['historical', 'current']) {
      const header = kind === 'historical' ? saved.captures.block.response.result : saved.currentBlock;
      const input = { request: { chainId: CHAIN_ID, from: tx.from, to: tx.to, data: tx.input, value: tx.value }, trace: saved.captures[kind === 'historical' ? 'historicalTrace' : 'currentTrace'].response.result, block: { hash: header.hash, number: BigInt(header.number).toString(), timestamp: BigInt(header.timestamp).toString() }, metadata: METADATA, rpc: {} };
      // Both recorded traces exercise candidate interpretation here; only the
      // historical context stub supplies synthetic state, never a live claim.
      const { result } = await run(input, { historical: true });
      assert.equal(result.status, 'measured', `${operation}/${kind}: ${result.warnings.at(-1)}`);
      const positionToken = operation === 'withdraw' ? HUSDC : VUSDC;
      assert.deepEqual(pairs(result), [`${USDC}:${tx.from}`, `${USDC}:${HUSDC}`, `${positionToken}:${tx.from}`].sort());
      assert.equal(result.assets.find(entry => entry.asset.address === positionToken).asset.role, operation === 'withdraw' ? 'receipt_token' : 'liability');
    }
  }
});

test('observed direct transferFrom selects the original owner and recipient independently of request.from', async () => {
  const saved = JSON.parse(await readFile(new URL('../reports/affected-account-discovery/direct-transferfrom-a-evidence.json', import.meta.url)));
  const tx = saved.captures.transaction.response.result, header = saved.captures.block.response.result;
  const input = { request: { chainId: CHAIN_ID, from: tx.from, to: tx.to, data: tx.input, value: tx.value }, trace: saved.captures.callTrace.response.result, block: { hash: header.hash, number: BigInt(header.number).toString(), timestamp: BigInt(header.timestamp).toString() }, metadata: METADATA, rpc: {} };
  const { result } = await run(input, { historical: true });
  assert.equal(result.status, 'measured'); assert.equal(result.assets.length, 2);
  const owner = '0xfc1bdd1ff58200761d56ccbce73f6f42ebe56379';
  assert.notEqual(owner, tx.from);
  assert.deepEqual(pairs(result), [`${USDC}:${owner}`, `${USDC}:${tx.from}`].sort());
  assert.equal(result.assets.find(entry => entry.account === owner).consistency.eventNetRaw, '-1277067');
  assert.equal(result.assets.find(entry => entry.account === tx.from).consistency.eventNetRaw, '1277067');
});
