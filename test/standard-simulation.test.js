import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validateStandardSimulation, simulateStandard, projectStandardPreview, STANDARD_EXAMPLES, STANDARD_CAPABILITIES } from '../src/standard-simulation.js';
import { InputError } from '../src/validate.js';
import { RpcClient, RpcError } from '../src/rpc.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const bytes = await readFile(new URL('../reports/standard-evm-deposits-v2/capture.json', import.meta.url));
assert.equal(sha(bytes), '149d80c7e421805dbc403a66acb6fb3410ea1d092876c01cc2776b52c703d86e');
const capture = JSON.parse(bytes);
const input = () => structuredClone(STANDARD_EXAMPLES[0].input);
const engineFields = ({ id, createdAt, apiRequest, source, preview, timing, ...engine }) => engine;
const word = address => address.slice(2).padStart(64, '0');
const balanceQuery = (to, account) => ({ to, data: '0x70a08231' + word(account) });

// The production JSON-RPC parser consumes all original response text verbatim.
// These two main replay cases have no generated or replacement RPC response.
function recordedRpc(run) {
  let index = 0;
  const failures = [];
  const rpc = new RpcClient({ url: 'https://eth.drpc.org', fetchImpl: async (url, options) => {
    const record = run.rpcCalls[index++];
    try {
      assert.ok(record, 'No unrecorded RPC request is permitted.');
      assert.equal(String(url), 'https://eth.drpc.org/');
      assert.equal(options.method, record.request.method);
      assert.equal(options.body, record.request.bodyText);
      assert.deepEqual(JSON.parse(options.body), record.request.body);
      assert.equal(sha(Buffer.from(record.responseText)), record.transport.responseSha256);
      return new Response(record.responseText, { status: record.http.status, headers: record.http.headers });
    } catch (error) { failures.push(error); throw error; }
  } });
  // The capture assigned IDs across both cases; preserve each original ID.
  rpc.nextId = run.rpcCalls[0].request.body.id;
  return { rpc, finish() { assert.deepEqual(failures, []); assert.equal(index, run.rpcCalls.length); } };
}

for (const [i, run] of capture.cases.entries()) test(`full genuine standard adapter playback: ${run.id} (${run.rpcCalls.length} recorded RPCs)`, async () => {
  const example = STANDARD_EXAMPLES[i], transport = recordedRpc(run);
  const report = await simulateStandard(example.input, transport.rpc);
  transport.finish();
  assert.deepEqual(engineFields(report), run.result, 'Every engine field, raw trace, diff, measurement, claim and evidence row is preserved');
  assert.deepEqual(report.apiRequest, validateStandardSimulation(example.input));
  assert.equal(report.source.profile, 'unsigned_unpriced_block_end');
  assert.deepEqual(report.source.blockSelection, { requested: example.input.block, kind: 'pinned_hash', resolvedHash: example.input.block, resolvedNumber: null, evidence: null });
  assert.match(report.id, /^[0-9a-f-]{36}$/);
  assert.ok(Number.isFinite(Date.parse(report.createdAt)));
  assert.ok(report.timing.totalMs >= 0 && report.timing.rpcMs >= 0);
  assert.equal(report.preview.queries.length, example.input.queries.length);
  assert.ok(report.preview.queries.every(q => q.status === 'measured'));
  assert.ok(report.preview.queries.every(q => q.metadata?.verifiedForSimulation === false));
  assert.ok(report.preview.queries.every(q => q.metadata?.provenance.kind === 'historical_reference'));
  assert.equal(report.preview.scope, 'explicit_queried_accounts');
  assert.equal(report.inAssets, undefined);
  assert.equal(report.outAssets, undefined);
  if (i === 0) {
    assert.deepEqual(report.preview.queries.map(q => [q.beforeRaw, q.afterRaw, q.deltaRaw]), [
      ['3962903485', '0', '-3962903485'], ['0', '3962903484', '3962903484'],
      ['151987610826648', '151991573730133', '3962903485'], ['0', '0', '0'],
    ]);
    assert.equal(report.preview.queries[0].delta, '-3962.903485');
    assert.equal(report.preview.queries[1].delta, '3962.903484');
    assert.equal(report.preview.queries[3].owner, example.input.from);
    assert.equal(report.preview.queries[3].spender, example.input.to);
    assert.equal(report.preview.queries[3].delta, '0');
  } else {
    assert.deepEqual(report.preview.queries.map(q => q.deltaRaw), ['-350000000000', '330497511812', '305565121166487000888945', '0', '0', '350000000000', '-350000000000', '0']);
    assert.equal(report.preview.queries[0].delta, '-350000');
    assert.equal(report.preview.queries[1].delta, '330497.511812');
    assert.equal(report.preview.queries[1].metadata.decimals, 6);
    assert.equal(report.preview.queries[1].accountIsSender, true);
    assert.equal(report.preview.queries[2].delta, '305565.121166487000888945');
    assert.equal(report.preview.queries[2].metadata.decimals, 18);
    assert.equal(report.preview.queries[2].account, example.input.to);
    assert.equal(report.preview.queries[2].accountIsSender, false, 'Wrapper-owned vault shares are not attributed to the sender');
    assert.equal(report.preview.queries[5].accountIsSender, false);
    assert.equal(report.preview.queries[7].owner, example.input.to);
    assert.equal(report.preview.queries[7].accountIsSender, false);
  }
});

test('examples retain the frozen selections, exact calldata, zero value and query roles without runtime report imports', () => {
  assert.equal(STANDARD_EXAMPLES.length, 2);
  for (const [i, example] of STANDARD_EXAMPLES.entries()) {
    const planned = capture.plan.cases[i];
    assert.deepEqual(example.input, { chainId: 1, from: planned.request.from, to: planned.request.to, data: planned.request.data, value: '0', block: planned.blockHash, queries: planned.queries.map(q => q.call) });
    assert.deepEqual(example.queryRoles, planned.queries.map((q, index) => ({ index, label: q.label, kind: q.kind, token: q.token, ...(q.kind === 'balanceOf' ? { account: q.account } : { owner: q.owner, spender: q.spender }) })));
    assert.equal(example.reference.profile, 'historical_parent_block_end');
    assert.equal(example.reference.originalTransactionHash, planned.originalTransactionHash);
  }
  assert.ok(Object.isFrozen(STANDARD_EXAMPLES[0].input.queries[0]));
  assert.equal(STANDARD_CAPABILITIES.limits.totalRpcCalls, 65);
  assert.equal(STANDARD_CAPABILITIES.status, 'experimental');
});

test('input normalizes address/query case, accepts canonical blocks and applies only declared defaults', () => {
  const candidate = input();
  candidate.chainId = '1'; candidate.from = candidate.from.toUpperCase().replace('0X', '0x');
  candidate.queries[0].to = candidate.queries[0].to.toUpperCase().replace('0X', '0x');
  delete candidate.block; delete candidate.value;
  const actual = validateStandardSimulation(candidate);
  assert.equal(actual.chainId, 1); assert.equal(actual.block, 'latest'); assert.equal(actual.value, '0');
  assert.equal(actual.from, STANDARD_EXAMPLES[0].input.from);
  for (const block of ['0x0', '0xabc', '0xABC', '0xffffffffffffffff', STANDARD_EXAMPLES[0].input.block]) assert.equal(validateStandardSimulation({ ...input(), block }).block, block.toLowerCase());
});

test('omitting queries explicitly selects automatic discovery, while null or an empty manual list remain invalid', () => {
  const automatic = input(); delete automatic.queries;
  assert.deepEqual(validateStandardSimulation(automatic), automatic);
  assert.equal(Object.hasOwn(validateStandardSimulation(automatic), 'queries'), false);
  for (const queries of [null, [], undefined]) assert.throws(() => validateStandardSimulation({ ...automatic, queries }), InputError);
  assert.deepEqual(validateStandardSimulation(input()).queries, input().queries);
});

test('an early automatic provider failure is explicit and cannot fabricate token observations', async () => {
  const automatic = input(); delete automatic.queries;
  const report = await simulateStandard(automatic, { async call() { return '0x2'; } });
  assert.equal(report.execution.status, 'unavailable'); assert.equal(report.discovery.status, 'unavailable');
  assert.equal(report.preview.scope, 'observed_queried_accounts'); assert.deepEqual(report.preview.queries, []);
  assert.match(report.preview.warnings[0], /may be omitted/); assert.equal(Object.hasOwn(report.apiRequest, 'queries'), false);
});

test('automatic preview binds selected query identities to measured values and preserves unknown raw units', () => {
  const automatic = input(); delete automatic.queries;
  const query = balanceQuery('0x2222222222222222222222222222222222222222', automatic.from);
  const report = { request: { queries: [query] }, measurements: [{ query, status: 'measured', beforeRaw: '77', afterRaw: '53', deltaRaw: '-24' }] };
  const view = projectStandardPreview(automatic, report);
  assert.equal(view.queries.length, 1); assert.equal(view.queries[0].accountIsSender, true);
  assert.equal(view.queries[0].deltaRaw, '-24'); assert.equal(view.queries[0].metadata, null);
  report.measurements[0].query = balanceQuery(query.to, '0x3333333333333333333333333333333333333333');
  const invalid = projectStandardPreview(automatic, report);
  assert.equal(invalid.queries[0].status, 'unavailable'); assert.equal(invalid.queries[0].deltaRaw, undefined);
});

test('unsupported chain, nonzero/hex/native values and noncanonical block selectors fail before RPC', async () => {
  const invalid = [
    { chainId: 999 }, { chainId: 8453 }, { chainId: '0x1' }, { chainId: true },
    ...['1', '0x0', 0, null, '-0', '00'].map(value => ({ value })),
    ...['pending', 'earliest', 'finalized', '0x00', '0x01', '0x', '123', '0x10000000000000000', [], null].map(block => ({ block })),
  ];
  let calls = 0;
  for (const change of invalid) await assert.rejects(simulateStandard({ ...input(), ...change }, { async call() { calls++; } }), InputError);
  assert.equal(calls, 0);
});

test('URLs, override/metadata/fee/signing fields and accessor/symbol/prototype records are rejected', () => {
  for (const key of ['rpcUrl', 'url', 'metadata', 'stateOverrides', 'gas', 'gasPrice', 'maxFeePerGas', 'nonce', 'accessList', 'authorizationList', 'signature']) assert.throws(() => validateStandardSimulation({ ...input(), [key]: 'ignored?' }), InputError);
  for (const value of [null, [], 'text', Object.create({ chainId: 1 })]) assert.throws(() => validateStandardSimulation(value), InputError);
  const symbol = input(); symbol[Symbol('hidden')] = 1;
  assert.throws(() => validateStandardSimulation(symbol), InputError);
  let getterCalls = 0; const accessor = input(); Object.defineProperty(accessor, 'from', { enumerable: true, get() { getterCalls++; return STANDARD_EXAMPLES[0].input.from; } });
  assert.throws(() => validateStandardSimulation(accessor), InputError); assert.equal(getterCalls, 0);
});

test('calldata bounds and strict query ABI/cap/duplicate controls', () => {
  for (const data of ['0x0', '0xz0', ['0x'], '0x' + '00'.repeat(32769)]) assert.throws(() => validateStandardSimulation({ ...input(), data }), InputError);
  assert.equal(validateStandardSimulation({ ...input(), data: '0x' + '00'.repeat(32768) }).data.length, 65538);
  const q = input().queries[0];
  const malformed = [[], Array(9).fill(q), [q, { ...q, to: q.to.toUpperCase().replace('0X', '0x') }], [null], [{ ...q, value: '0' }], [{ ...q, data: '0x095ea7b3' + q.data.slice(10) }], [{ ...q, data: q.data.slice(0, 10) + '1' + q.data.slice(11) }], [{ ...q, data: q.data + '00' }], [{ to: q.to, data: [] }], new Array(1)];
  for (const queries of malformed) assert.throws(() => validateStandardSimulation({ ...input(), queries }), InputError);
  const eight = Array.from({ length: 8 }, (_, i) => balanceQuery(q.to, '0x' + BigInt(i + 1).toString(16).padStart(40, '0')));
  assert.equal(validateStandardSimulation({ ...input(), queries: eight }).queries.length, 8);
});

test('numeric selector: composite genuine recorded selection header plus unchanged thirty engine requests', async () => {
  const metadataBytes = await readFile(new URL('../reports/standard-evm-discovery/raw/051.json', import.meta.url));
  const metadata = JSON.parse(metadataBytes);
  const body = await readFile(new URL('../reports/standard-evm-discovery/raw/051.body', import.meta.url));
  assert.equal(sha(body), '7b2ecc35f240b373de73839c23a3c07d899e1727856d7c1f4c21b404cfa4e463');
  assert.deepEqual(JSON.parse(body), metadata.response);
  const transport = recordedRpc(capture.cases[0]), selected = [];
  const rpc = { async call(method, params) {
    if (!selected.length) { selected.push({ method, params }); assert.equal(method, metadata.request.body.method); assert.deepEqual(params, metadata.request.body.params); return structuredClone(metadata.response.result); }
    return transport.rpc.call(method, params);
  } };
  const request = { ...input(), block: metadata.request.body.params[0] };
  const report = await simulateStandard(request, rpc); transport.finish();
  assert.deepEqual(engineFields(report), capture.cases[0].result);
  assert.deepEqual(report.source.blockSelection, { requested: request.block, kind: 'resolved_number', resolvedHash: STANDARD_EXAMPLES[0].input.block, resolvedNumber: '26270482', evidence: { method: metadata.request.body.method, params: metadata.request.body.params, result: metadata.response.result } });
});

test('latest selector fault control adds one selection, then keeps the returned hash pinned', async () => {
  // Synthetic selection control: this archived header is supplied as latest.
  // It makes no claim about the live latest block; engine calls remain genuine.
  const header = capture.cases[0].rpcCalls[1].response.result;
  const transport = recordedRpc(capture.cases[0]); let selectorCalls = 0;
  const rpc = { async call(method, params) {
    if (!selectorCalls) { selectorCalls++; assert.deepEqual({ method, params }, { method: 'eth_getBlockByNumber', params: ['latest', false] }); return structuredClone(header); }
    return transport.rpc.call(method, params);
  } };
  const report = await simulateStandard({ ...input(), block: 'latest' }, rpc); transport.finish();
  assert.equal(selectorCalls, 1);
  assert.equal(report.source.blockSelection.kind, 'resolved_latest');
  assert.equal(report.request.block.blockHash, header.hash);
  assert.equal(report.request.block.requireCanonical, true);
});

test('malformed, mismatching, oversized and poisoned selector results do not reach the engine', async () => {
  const header = capture.cases[0].rpcCalls[1].response.result;
  for (const response of [null, [], { ...header, hash: ['0x' + '1'.repeat(64)] }, { ...header, number: '0x01' }, { ...header, number: '0x190db13' }, { ...header, extra: 'x'.repeat(8 * 1024 * 1024) }, { error: { message: 'PRIVATE_PROVIDER_CREDENTIAL', code: -32603 } }]) {
    let calls = 0;
    await assert.rejects(simulateStandard({ ...input(), block: '0x190db12' }, { async call() { calls++; return response; } }), error => error instanceof RpcError && !JSON.stringify(error).includes('PRIVATE_PROVIDER_CREDENTIAL'));
    assert.equal(calls, 1);
  }
  await assert.rejects(simulateStandard({ ...input(), block: 'latest' }, { async call() { throw new Error('PRIVATE_PROVIDER_CREDENTIAL'); } }), error => error.code === 'STANDARD_BLOCK_UNAVAILABLE' && !error.message.includes('PRIVATE_PROVIDER_CREDENTIAL'));
});

test('selection binding fault control rejects a conflicting number under a repeated block hash', async () => {
  const header = structuredClone(capture.cases[0].rpcCalls[1].response.result);
  header.number = '0x190db13'; // Synthetic inconsistent latest-selection header.
  const transport = recordedRpc(capture.cases[0]); let selected = false;
  const rpc = { async call(method, params) {
    if (!selected) { selected = true; assert.deepEqual([method, params], ['eth_getBlockByNumber', ['latest', false]]); return header; }
    return transport.rpc.call(method, params);
  } };
  await assert.rejects(simulateStandard({ ...input(), block: 'latest' }, rpc), error => error instanceof RpcError && error.code === 'STANDARD_BLOCK_MISMATCH');
  transport.finish();
});

test('complete selection binding rejects same-hash timestamp, state-root and transaction-list conflicts', async () => {
  for (const mutate of [
    header => { header.timestamp = '0x' + (BigInt(header.timestamp) + 1n).toString(16); },
    header => { header.stateRoot = '0x' + 'ab'.repeat(32); },
    header => { header.transactions = [...header.transactions].reverse(); },
  ]) {
    const header = structuredClone(capture.cases[0].rpcCalls[1].response.result);
    mutate(header);
    const transport = recordedRpc(capture.cases[0]); let selected = false;
    const rpc = { async call(method, params) {
      if (!selected) { selected = true; assert.deepEqual([method, params], ['eth_getBlockByNumber', ['latest', false]]); return header; }
      return transport.rpc.call(method, params);
    } };
    await assert.rejects(simulateStandard({ ...input(), block: 'latest' }, rpc), error => error instanceof RpcError && error.code === 'STANDARD_BLOCK_MISMATCH');
    transport.finish();
  }
});

test('selection binding permits an entire matching header independent of object field insertion order', async () => {
  const original = capture.cases[0].rpcCalls[1].response.result;
  const header = Object.fromEntries(Object.entries(original).reverse());
  const transport = recordedRpc(capture.cases[0]); let selected = false;
  const rpc = { async call(method, params) {
    if (!selected) { selected = true; assert.deepEqual([method, params], ['eth_getBlockByNumber', ['latest', false]]); return header; }
    return transport.rpc.call(method, params);
  } };
  const report = await simulateStandard({ ...input(), block: 'latest' }, rpc);
  transport.finish();
  assert.equal(report.canonicalStatus, 'verified');
  assert.deepEqual(report.source.blockSelection.evidence.result, original);
});

test('an unavailable engine before a valid fetched header remains an ordinary unavailable result', async () => {
  const header = structuredClone(capture.cases[0].rpcCalls[1].response.result);
  let calls = 0;
  const rpc = { async call(method) {
    calls++;
    if (calls === 1) { assert.equal(method, 'eth_getBlockByNumber'); return header; }
    if (calls === 2) { assert.equal(method, 'eth_chainId'); return '0x1'; }
    assert.equal(method, 'eth_getBlockByHash'); return null;
  } };
  const report = await simulateStandard({ ...input(), block: 'latest' }, rpc);
  assert.equal(calls, 3);
  assert.equal(report.execution.status, 'unavailable');
  assert.equal(report.canonicalStatus, 'unverified');
  assert.equal(report.block, undefined);
});

test('engine wrong-chain and poisoned provider failure remain explicit unavailable results, never success assets', async () => {
  for (const rpc of [{ async call() { return '0x3e7'; } }, { async call() { throw new Error('PRIVATE_PROVIDER_CREDENTIAL'); } }]) {
    const report = await simulateStandard(input(), rpc);
    assert.equal(report.execution.status, 'unavailable');
    assert.equal(report.canonicalStatus, 'unverified');
    assert.ok(report.preview.queries.every(q => q.status === 'unavailable' && q.beforeRaw === undefined));
    assert.equal(JSON.stringify(report).includes('PRIVATE_PROVIDER_CREDENTIAL'), false);
  }
});

test('pure display control: unknown tokens remain raw and account ownership is decoded rather than assumed', () => {
  const sender = input().from, stranger = '0x1111111111111111111111111111111111111111', token = '0x2222222222222222222222222222222222222222';
  const query = balanceQuery(token, stranger), request = validateStandardSimulation({ ...input(), queries: [query] });
  const view = projectStandardPreview(request, { measurements: [{ query, status: 'measured', beforeRaw: '9007199254740993', afterRaw: '9007199254740994', deltaRaw: '1' }] });
  assert.equal(view.queries[0].metadata, null); assert.equal(view.queries[0].beforeRaw, '9007199254740993');
  assert.equal(view.queries[0].before, undefined); assert.equal(view.queries[0].delta, undefined);
  assert.equal(view.queries[0].account, stranger); assert.equal(view.queries[0].accountIsSender, false);
  const allowance = { to: token, data: '0xdd62ed3e' + word(stranger) + word(sender) };
  const allowanceView = projectStandardPreview(validateStandardSimulation({ ...input(), queries: [allowance] }), { measurements: [{ query: allowance, status: 'not_applicable', reason: 'Synthetic failed execution control.' }] });
  assert.equal(allowanceView.queries[0].owner, stranger); assert.equal(allowanceView.queries[0].spender, sender); assert.equal(allowanceView.queries[0].accountIsSender, false);
});

test('pure display control: max uint256 uses exact decimal formatting and stale query bindings withhold display values', () => {
  const request = input(), query = request.queries[0], max = ((1n << 256n) - 1n).toString();
  request.queries = [query];
  const view = projectStandardPreview(request, { measurements: [{ query, status: 'measured', beforeRaw: max, afterRaw: '0', deltaRaw: '-' + max }] });
  assert.equal(view.queries[0].before, '115792089237316195423570985008687907853269984665640564039457584007913129.639935');
  assert.equal(view.queries[0].delta, '-115792089237316195423570985008687907853269984665640564039457584007913129.639935');
  const mismatched = projectStandardPreview(request, { measurements: [{ query: { ...query, to: input().to }, status: 'measured', beforeRaw: '1', afterRaw: '2', deltaRaw: '1' }] });
  assert.equal(mismatched.queries[0].status, 'unavailable'); assert.equal(mismatched.queries[0].deltaRaw, undefined);
});
