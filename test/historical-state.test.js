import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHistoricalStateContext } from '../src/historical-state.js';
import { StateValidationError } from '../src/state.js';
import { USDC, HUSDC, VUSDC } from '../src/config.js';

const word = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const address = n => '0x' + BigInt(n).toString(16).padStart(40, '0');
const PROBE = '0x000000000000000000000000000000000000ba1a';
const captures = JSON.parse(await readFile(new URL('../reports/historical-state/position-validation.json', import.meta.url)));
const initialProbes = JSON.parse(await readFile(new URL('../reports/historical-state/capability-probes.json', import.meta.url)));
const originals = new Map();
for (const operation of ['withdraw', 'borrow', 'repay']) originals.set(operation, JSON.parse(await readFile(new URL(`../reports/lending-discovery/${operation}-evidence.json`, import.meta.url))));
const query = (token, account) => ({ to: token, data: '0x70a08231' + account.slice(2).padStart(64, '0') });

function setup(operation = 'withdraw', mutateResponse = undefined) {
  const original = structuredClone(originals.get(operation));
  const transaction = original.captures.transaction.response.result;
  const receipt = original.captures.receipt.response.result;
  const trace = original.captures.historicalTrace.response.result;
  const header = original.captures.block.response.result;
  const block = { hash: header.hash, number: BigInt(header.number).toString(), timestamp: BigInt(header.timestamp).toString() };
  const request = { chainId: 999, from: transaction.from, to: transaction.to, data: transaction.input, value: BigInt(transaction.value).toString() };
  const index = Number(BigInt(transaction.transactionIndex));
  const calls = [];
  const getCapture = label => captures.captures.find(item => item.endpoint.includes('drpc') && item.label === label).response.result;
  const rpc = { async call(method, params) {
    const call = { method, params: structuredClone(params) }; calls.push(call);
    let result;
    if (method === 'eth_getBlockByHash' || method === 'eth_getBlockByNumber') result = structuredClone(header);
    else if (method === 'debug_traceTransaction') result = operation === 'withdraw' ? structuredClone(initialProbes.providers[0].captures.find(c => c.label === 'historical-prestate-diff').response.result) : { pre: {}, post: {} };
    else if (method === 'debug_traceCallMany') {
      const input = params[0][0].transactions[0], position = params[1].transactionIndex;
      if (input.to === PROBE) {
        const output = '0x' + [header.number, header.timestamp, header.gasLimit, header.baseFeePerGas, header.mixHash, header.miner, '0x3e7', header.parentHash].map(value => word(value).slice(2)).join('');
        result = [[{ type: 'CALL', from: input.from, to: input.to, input: '0x', value: '0x0', output, gasUsed: '0x6000' }]];
      } else if (input.to === transaction.to) result = structuredClone(getCapture(`${operation}-original-position`));
      else if (params[2].tracer === 'prestateTracer') {
        // Synthetic read-only fee/nonce control; execution traces below are public observations.
        const recorded = getCapture(`${operation}-${position === index ? 'before' : 'after'}-position`)[0].find(t => t.to === input.to);
        const nonce = BigInt(transaction.nonce) + BigInt(position - index), funds = 10n ** 24n;
        const fee = BigInt(recorded.gasUsed) * BigInt(transaction.gasPrice), tip = BigInt(recorded.gasUsed) * (BigInt(transaction.gasPrice) - BigInt(header.baseFeePerGas));
        result = [[{ pre: { [request.from]: { nonce: Number(nonce), balance: word(funds) }, [header.miner]: { balance: word(funds) } }, post: { [request.from]: { nonce: Number(nonce + 1n), balance: word(funds - fee) }, [header.miner]: { balance: word(funds + tip) } } }]];
      } else {
        const traces = getCapture(`${operation}-${position === index ? 'before' : 'after'}-position`)[0];
        result = [[structuredClone(traces.find(t => t.to === input.to))]];
      }
    } else throw new Error('Unexpected test RPC method');
    return mutateResponse ? mutateResponse({ ...call, result, calls, index, header, request, transaction }) ?? result : result;
  } };
  const args = { request, block, rpc, transaction, receipt, trace };
  return { args, header, calls, rpc, context: createHistoricalStateContext(args) };
}

for (const [operation, token, delta] of [['withdraw', HUSDC, -503900226n], ['borrow', VUSDC, 835474410n], ['repay', VUSDC, -199626279n]]) test(`observed ${operation} returns exact historical-position balance change`, async () => {
  const { context, args, calls } = setup(operation);
  assert.equal(calls.length, 0);
  assert.equal(context.executionIdentity, null);
  assert.equal(context.measurementBasis, 'historical_transaction_position_balanceOf');
  const measured = await context.readPair(query(token, args.request.from));
  assert.equal(measured.delta, delta);
  await context.verifyCanonical();
  assert.equal(context.executionIdentity.transactionHash, args.transaction.hash);
  assert.equal(context.executionIdentity.transactionIndex, BigInt(args.transaction.transactionIndex).toString());
  assert.equal(context.executionIdentity.postTransactionIndex, (BigInt(args.transaction.transactionIndex) + 1n).toString());
  for (const call of calls.filter(c => c.method === 'debug_traceCallMany')) {
    assert.equal(call.params[0].length, 1);
    assert.equal(call.params[0][0].transactions.length, 1, 'query calls are never inserted into an original execution sequence');
    assert.equal(call.params[0][0].transactions[0].gasPrice, args.transaction.gasPrice);
    assert.deepEqual(call.params[1].blockNumber, { blockHash: args.block.hash, requireCanonical: true });
  }
});

test('historical context snapshots inputs, caches repeated pairs and shares lazy preparation', async () => {
  const { context, args, calls } = setup();
  assert.equal(context.matches(args), true);
  args.request.value = '1';
  assert.equal(context.matches(args), false);
  await Promise.all([context.prepare(), context.prepare()]);
  assert.equal(calls.filter(c => c.method === 'debug_traceTransaction').length, 1);
  const q = query(USDC, args.transaction.from);
  const [a, b] = await Promise.all([context.readPair(q), context.readPair(q)]);
  assert.equal(a.delta, 503900226n); assert.deepEqual(a, b);
  const count = calls.length; await context.readPair(q); assert.equal(calls.length, count);
  const snapshot = context.snapshotEvidence(); snapshot.request[0].method = 'modified';
  assert.notEqual(context.snapshotEvidence().request[0].method, 'modified');
  assert.throws(() => { context.measurementBasis = 'wrong'; }, TypeError);
});

test('original transaction, receipt, block and array position must agree before execution', async () => {
  const changes = [
    args => { args.transaction.hash = word(1n); },
    args => { args.transaction.from = address(1n); },
    args => { args.transaction.input += '00'; },
    args => { args.transaction.gasPrice = '0x0'; },
    args => { args.transaction.transactionIndex = '0x100000'; },
    args => { args.receipt.status = '0x0'; },
    args => { args.receipt.transactionIndex = '0x3'; },
    args => { args.trace.gasUsed = '0x1'; },
    args => { args.receipt.logs[0].data = '0x'; },
  ];
  for (const change of changes) {
    const { args } = setup(); change(args);
    await assert.rejects(createHistoricalStateContext(args).prepare(), StateValidationError);
  }
  for (const mutation of ['hash', 'index', 'object-array', 'duplicate-array', 'timestamp']) {
    const { context } = setup('withdraw', ({ method, result }) => {
      if (method !== 'eth_getBlockByHash') return;
      if (mutation === 'hash') result.hash = word(1n);
      if (mutation === 'index') [result.transactions[0], result.transactions[4]] = [result.transactions[4], result.transactions[0]];
      if (mutation === 'object-array') result.transactions[0] = { hash: result.transactions[0] };
      if (mutation === 'duplicate-array') result.transactions[0] = result.transactions[1];
      if (mutation === 'timestamp') result.timestamp = '0x1';
      return result;
    });
    await assert.rejects(context.prepare(), StateValidationError);
  }
});

test('ignored indexes and altered original execution fail semantic replay validation', async () => {
  const blockEndTrace = initialProbes.providers[0].captures.find(c => c.label === 'original-at-index').response.result;
  for (const mutate of [
    () => structuredClone(blockEndTrace),
    t => ({ ...t, gasUsed: '0x1' }),
    t => ({ ...t, from: address(1n) }),
    t => ({ ...t, output: word(0n) }),
    t => ({ ...t, error: 'execution reverted' }),
    t => ({ ...t, calls: {} }),
    t => ({ ...t, calls: t.calls.slice(1) }),
  ]) {
    const { context } = setup('withdraw', ({ method, params, result }) => {
      if (method === 'debug_traceCallMany' && params[0][0].transactions[0].to === originals.get('withdraw').captures.transaction.response.result.to) return [[mutate(result[0][0])]];
    });
    await assert.rejects(context.prepare(), StateValidationError);
  }
});

test('input gas annotations alone may differ but nested gas used and event position may not', async () => {
  const { context } = setup('withdraw', ({ method, params, result }) => {
    if (method === 'debug_traceCallMany' && params[0][0].transactions[0].to !== PROBE && !params[0][0].transactions[0].data.startsWith('0x70a08231')) {
      result[0][0].gas = '0x1'; result[0][0].calls[0].gas = '0x2'; return result;
    }
  });
  await context.prepare();
  const bad = setup('withdraw', ({ method, params, result }) => {
    if (method === 'debug_traceCallMany' && params[0][0].transactions[0].to !== PROBE && !params[0][0].transactions[0].data.startsWith('0x70a08231')) { result[0][0].calls[0].gasUsed = '0x1'; return result; }
  });
  await assert.rejects(bad.context.prepare(), StateValidationError);
});

test('original code/account changes and query execution header changes fail closed', async () => {
  for (const mode of ['code', 'created', 'basefee', 'timestamp', 'post-header']) {
    const { context } = setup('withdraw', ({ method, params, result, index }) => {
      if (method === 'debug_traceTransaction' && ['code', 'created'].includes(mode)) return mode === 'code' ? { pre: { [USDC]: { code: '0x00' } }, post: { [USDC]: { code: '0x01' } } } : { pre: {}, post: { [USDC]: {} } };
      if (method === 'debug_traceCallMany' && params[0][0].transactions[0].to === PROBE && (!['code', 'created'].includes(mode))) {
        if (mode === 'post-header' && params[1].transactionIndex === index) return;
        const offset = mode === 'basefee' ? 3 : 1;
        const data = result[0][0].output;
        result[0][0].output = data.slice(0, 2 + offset * 64) + word(0n).slice(2) + data.slice(2 + (offset + 1) * 64);
        return result;
      }
    });
    await assert.rejects(context.prepare(), StateValidationError);
  }
});

test('only known balanceOf queries are allowed and malformed query traces are rejected', async () => {
  const { context, calls, args } = setup();
  for (const q of [{ to: address(1n), data: query(USDC, args.request.from).data }, { to: USDC, data: '0xdd62ed3e' }, { to: USDC, data: query(USDC, args.request.from).data + '00' }]) await assert.rejects(context.readPair(q), StateValidationError);
  assert.equal(calls.length, 0);
  for (const mode of ['unknown-implementation', 'extra-call', 'reverted', 'short-output', 'mismatched-output', 'malformed-bundle', 'pool-implementation', 'event']) {
    const testCase = setup('withdraw', ({ method, params, result }) => {
      if (method !== 'debug_traceCallMany' || params[0][0].transactions[0].to !== HUSDC || params[2].tracer !== 'callTracer') return;
      const t = result[0][0];
      if (mode === 'unknown-implementation') t.calls[0].to = address(2n);
      if (mode === 'extra-call') t.calls.push(structuredClone(t.calls[0]));
      if (mode === 'reverted') t.calls[0].error = 'execution reverted';
      if (mode === 'short-output') t.output = '0x01';
      if (mode === 'mismatched-output') t.calls[0].output = word(0n);
      if (mode === 'malformed-bundle') return [result[0], result[0]];
      if (mode === 'pool-implementation') t.calls[0].calls[0].calls[0].to = address(3n);
      if (mode === 'event') t.logs = [{ address: HUSDC, topics: [], data: '0x' }];
      return result;
    });
    await assert.rejects(testCase.context.readPair(query(HUSDC, testCase.args.request.from)), StateValidationError);
  }
});

test('balance queries may incur fee/nonce effects but may not alter token storage or other accounts', async () => {
  for (const mode of ['storage', 'other-account', 'code', 'nonce', 'created']) {
    const { context, args } = setup('withdraw', ({ method, params, result, request }) => {
      if (method !== 'debug_traceCallMany' || params[2].tracer !== 'prestateTracer') return;
      const diff = result[0][0];
      if (mode === 'storage') { diff.pre[request.from].storage = { [word(1n)]: word(1n) }; diff.post[request.from].storage = { [word(1n)]: word(2n) }; }
      if (mode === 'other-account') { diff.pre[USDC] = { balance: '0x1' }; diff.post[USDC] = { balance: '0x0' }; }
      if (mode === 'code') { diff.pre[request.from].code = '0x00'; diff.post[request.from].code = '0x01'; }
      if (mode === 'nonce') diff.post[request.from].nonce = 20;
      if (mode === 'created') diff.post[USDC] = {};
      return result;
    });
    await assert.rejects(context.readPair(query(USDC, args.request.from)), StateValidationError);
  }
});

test('canonical recheck catches a reorg and public errors never contain provider exception text', async () => {
  const { context, args } = setup('withdraw', ({ method, result, calls }) => {
    if (method === 'eth_getBlockByNumber' && calls.filter(c => c.method === method).length > 1) { result.hash = word(1n); return result; }
  });
  await context.readPair(query(USDC, args.request.from));
  await assert.rejects(context.verifyCanonical(), StateValidationError);
  const poisoned = setup();
  poisoned.rpc.call = async () => { const error = new Error('SECRET https://private.example?api_key=SECRET'); error.code = 'RPC_EXECUTION_ERROR'; error.detail = { rpcCode: -1, url: 'SECRET' }; throw error; };
  await assert.rejects(poisoned.context.prepare(), error => error instanceof StateValidationError && !error.message.includes('SECRET'));
  assert.ok(!JSON.stringify(poisoned.context.snapshotEvidence()).includes('SECRET'));
});

test('successful RPC error envelopes are sanitized before historical evidence retention', async () => {
  const marker = 'REVIEW_ONLY_PROVIDER_CREDENTIAL';
  const error = { code: -32603, message: `Upstream https://rpc.invalid/${marker} rejected request`, data: { requestUrl: marker } };
  for (const boundary of ['result', 'bundle-entry', 'bundle']) {
    const { context } = setup('withdraw', ({ method }) => {
      if (boundary === 'result' && method === 'eth_getBlockByHash') return { error };
      if (method === 'debug_traceCallMany') return boundary === 'bundle-entry' ? [[{ error }]] : boundary === 'bundle' ? [{ error }] : undefined;
    });
    await assert.rejects(context.prepare(), failure => failure instanceof StateValidationError && !failure.message.includes(marker));
    const evidence = context.snapshotEvidence();
    assert.ok(!JSON.stringify(evidence).includes(marker));
    assert.ok(['RPC_INVALID_RESPONSE', 'RPC_EXECUTION_ERROR'].includes(evidence.response.at(-1).error.code));
    assert.equal(evidence.response.at(-1).error.message, 'The historical state provider failed a read-only RPC request.');
    assert.equal(evidence.response.at(-1).error.rpcCode, -32603);
    assert.equal(Object.hasOwn(evidence.response.at(-1), 'result'), false);
  }
  for (const code of [2 ** 54, -Infinity, marker]) {
    const { context } = setup('withdraw', ({ method }) => method === 'eth_getBlockByHash' ? { error: { ...error, code } } : undefined);
    await assert.rejects(context.prepare(), StateValidationError);
    assert.equal(Object.hasOwn(context.snapshotEvidence().response.at(-1).error, 'rpcCode'), false);
  }
  const malformed = setup('withdraw', ({ method }) => method === 'debug_traceCallMany' ? [[{ error: `Upstream ${marker}`, output: '0x' }]] : undefined);
  await assert.rejects(malformed.context.prepare(), StateValidationError);
  assert.ok(!JSON.stringify(malformed.context.snapshotEvidence()).includes(marker));
});

test('blob, authorization and inconsistent fee envelopes are rejected', async () => {
  for (const change of [
    tx => { tx.type = '0x3'; }, tx => { tx.type = '0x4'; },
    tx => { tx.authorizationList = []; }, tx => { tx.blobVersionedHashes = []; },
    tx => { tx.maxFeePerBlobGas = '0x1'; },
    tx => { tx.maxFeePerGas = '0x1'; }, tx => { tx.maxPriorityFeePerGas = '0x0'; },
    tx => { tx.accessList = [{ address: USDC, storageKeys: ['bad'] }]; },
  ]) {
    const { args } = setup(); change(args.transaction);
    await assert.rejects(createHistoricalStateContext(args).prepare(), StateValidationError);
  }
  const { args, calls } = setup();
  args.transaction.accessList = [{ address: USDC, storageKeys: [word(1n)] }];
  await createHistoricalStateContext(args).prepare();
  const original = calls.find(c => c.method === 'debug_traceCallMany' && c.params[0][0].transactions[0].to === args.transaction.to);
  assert.deepEqual(original.params[0][0].transactions[0].accessList, args.transaction.accessList);
});

test('independent sender nonce evidence detects ignored or clamped positions even if replay matches', async () => {
  for (const shift of [-1, 1, 50]) {
    const { context, args } = setup('withdraw', ({ method, params, result, request }) => {
      if (method === 'debug_traceCallMany' && params[2].tracer === 'prestateTracer') {
        result[0][0].pre[request.from].nonce += shift;
        result[0][0].post[request.from].nonce += shift;
        return result;
      }
    });
    await assert.rejects(context.readPair(query(USDC, args.request.from)), /original transaction position/);
  }
});

test('native changes must equal the query gas charge and beneficiary tip exactly', async () => {
  for (const account of ['sender', 'miner']) {
    const { context, args } = setup('withdraw', ({ method, params, result, request, header }) => {
      if (method === 'debug_traceCallMany' && params[2].tracer === 'prestateTracer') {
        const record = result[0][0].post[account === 'sender' ? request.from : header.miner];
        record.balance = word(BigInt(record.balance) + 1n); return result;
      }
    });
    await assert.rejects(context.readPair(query(USDC, args.request.from)), /fee effects/);
  }
});

test('historical query resources are capped and duplicate pairs consume no extra calls', async () => {
  const { context, calls } = setup('withdraw', ({ method, params, result }) => {
    const input = params[0]?.[0]?.transactions?.[0];
    if (method === 'debug_traceCallMany' && input?.to === USDC && params[2].tracer === 'callTracer') {
      result[0][0].input = input.data; result[0][0].calls[0].input = input.data; return result;
    }
  });
  for (let i = 1; i <= 12; i++) await context.readPair(query(USDC, address(i)));
  assert.equal(calls.length, 54);
  const count = calls.length;
  await context.readPair(query(USDC, address(1n)));
  assert.equal(calls.length, count);
  await assert.rejects(context.readPair(query(USDC, address(13n))), /12 token\/account pair limit/);
  await context.verifyCanonical();
  assert.equal(calls.length, 55);
});

test('address and event topic arrays are rejected without coercing them into strings', async () => {
  for (const change of [
    args => { args.trace.from = [args.trace.from]; },
    args => { args.receipt.logs[0].address = [args.receipt.logs[0].address]; },
    args => { args.receipt.logs[0].topics[0] = [args.receipt.logs[0].topics[0]]; },
    args => {
      const find = frame => frame.logs?.[0] ?? (frame.calls ?? []).map(find).find(Boolean);
      const log = find(args.trace); log.topics[0] = [log.topics[0]];
    },
  ]) {
    const { args } = setup(); change(args);
    await assert.rejects(createHistoricalStateContext(args).prepare(), StateValidationError);
  }
});

test('receipt comparison excludes reverted child logs while full replay still matches them', async () => {
  const environment = setup('withdraw', ({ method, params }) => {
    if (method === 'debug_traceCallMany' && params[0][0].transactions[0].to === environment.args.request.to) return [[structuredClone(environment.args.trace)]];
  });
  const { args } = environment;
  args.trace.calls.push({ type: 'CALL', from: args.request.to, to: USDC, input: '0x', output: '0x', value: '0x0', gasUsed: '0x1', error: 'execution reverted', revertReason: 'Expected synthetic revert', logs: [{ address: USDC, topics: [word(99n)], data: word(1n) }] });
  const context = createHistoricalStateContext(args);
  await context.prepare();
  const replay = context.snapshotEvidence().response.find(response => response.method === 'debug_traceCallMany').result[0][0];
  assert.equal(replay.calls.at(-1).error, 'execution reverted');
  assert.equal(replay.calls.at(-1).revertReason, 'Expected synthetic revert');
  assert.equal(replay.calls.at(-1).output, '0x', 'valid EVM failure evidence remains intact');
});

const measuredRuns = JSON.parse(await readFile(new URL('../reports/historical-state/module-validation.json', import.meta.url))).runs;
for (const run of measuredRuns) test(`saved live module evidence: ${run.operation} on ${new URL(run.endpoint).hostname}`, async () => {
  assert.equal(run.status, 'measured');
  const { args } = setup(run.operation);
  let next = 0;
  args.rpc = { async call(method, params) {
    const recorded = run.evidence.request[next++];
    assert.ok(recorded, 'no unrecorded RPC');
    assert.equal(method, recorded.method);
    assert.deepEqual(params, recorded.params);
    return structuredClone(run.evidence.response.find(item => item.id === recorded.id).result);
  } };
  const context = createHistoricalStateContext(args);
  for (const expected of run.balances) {
    const observed = await context.readPair(query(expected.token, args.request.from));
    for (const field of ['before', 'after', 'delta']) assert.equal(observed[field].toString(), expected[field]);
  }
  await context.verifyCanonical();
  assert.equal(next, run.evidence.request.length);
  assert.deepEqual(context.snapshotEvidence().response, run.evidence.response, 'normal successful raw evidence is preserved');
});
