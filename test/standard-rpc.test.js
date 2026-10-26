import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { StandardRpcClient, STANDARD_RPC_LIMITS, STANDARD_SEQUENCE_RPC_LIMITS } from '../src/standard-rpc.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const address = digit => '0x' + digit.repeat(40);
const frame = { type: 'CALL', from: address('1'), to: address('2'), input: '0x', output: '0x', gas: '0x100', gasUsed: '0x0' };
const success = (init, result = '0x1') => JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const readerResponse = reader => ({ ok: true, status: 200, body: { getReader: () => reader, cancel: (...args) => reader.cancel?.(...args) } });

test('sequence resource profile is explicit and bounded without widening single-call limits', async () => {
  assert.deepEqual(new StandardRpcClient().limits, STANDARD_RPC_LIMITS);
  assert.deepEqual(new StandardRpcClient({ profile: 'sequence' }).limits, STANDARD_SEQUENCE_RPC_LIMITS);
  assert.deepEqual(STANDARD_SEQUENCE_RPC_LIMITS, { calls: 258, responseBytes: 8388608, totalBytes: 134217728, wallMs: 265000, requestMs: 25000 });
  for (const profile of ['', 'unlimited', null, {}, 1]) assert.throws(() => new StandardRpcClient({ profile }), { code: 'INVALID_RPC_PROFILE' });
  for (const [key, value] of Object.entries(STANDARD_SEQUENCE_RPC_LIMITS)) assert.throws(() => new StandardRpcClient({ profile: 'sequence', limits: { [key]: value + 1 } }), { code: 'INVALID_RPC_LIMIT' });
  assert.throws(() => new StandardRpcClient({ limits: { calls: 258 } }), { code: 'INVALID_RPC_LIMIT' });
  const rpc = new StandardRpcClient({ profile: 'sequence', limits: { calls: 66 }, fetchImpl: async (_url, init) => new Response(success(init)) });
  for (let i = 0; i < 66; i++) assert.equal(await rpc.call('eth_chainId'), '0x1');
  await assert.rejects(rpc.call('eth_chainId'), { code: 'RPC_BUDGET' });
  assert.equal(rpc.evidence.length, 66);
});

test('Ethereum endpoint defaults and server-configured overrides never appear in saved request metadata', async () => {
  const previous = process.env.ETHEREUM_RPC_URL;
  try {
    delete process.env.ETHEREUM_RPC_URL;
    assert.equal(new StandardRpcClient().url.href, 'https://eth.drpc.org/');
    process.env.ETHEREUM_RPC_URL = 'https://provider.test/private-token?key=private-value';
    const rpc = new StandardRpcClient({ fetchImpl: async (url, init) => {
      assert.equal(url.href, process.env.ETHEREUM_RPC_URL);
      assert.equal(init.redirect, 'error');
      assert.equal(init.method, 'POST');
      assert.deepEqual(init.headers, { 'content-type': 'application/json' });
      assert.ok(init.signal instanceof AbortSignal);
      return new Response(success(init));
    } });
    assert.equal(await rpc.call('eth_chainId'), '0x1');
    assert.equal(rpc.provider, 'provider.test');
    assert.doesNotMatch(JSON.stringify(rpc.snapshotEvidence()), /private-token|private-value|https:/);
  } finally {
    if (previous === undefined) delete process.env.ETHEREUM_RPC_URL;
    else process.env.ETHEREUM_RPC_URL = previous;
  }
});

test('only the seven configured read methods reach transport; limits can only tighten', async () => {
  const methods = [];
  const rpc = new StandardRpcClient({ fetchImpl: async (_url, init) => {
    methods.push(JSON.parse(init.body).method); return new Response(success(init));
  } });
  for (const method of ['eth_chainId', 'eth_getBlockByHash', 'eth_getBlockByNumber', 'eth_getTransactionCount', 'eth_getBalance', 'eth_getCode', 'debug_traceCall']) await rpc.call(method, []);
  for (const method of ['eth_sendRawTransaction', 'eth_sendTransaction', 'personal_sign', 'eth_sign', 'debug_setHead', 'debug_traceCallMany', 'web3_clientVersion', 'eth_call']) await assert.rejects(rpc.call(method, []), { code: 'METHOD_NOT_ALLOWED' });
  assert.equal(methods.length, 7);
  assert.equal(rpc.evidence.length, 7);
  for (const [key, maximum] of Object.entries(STANDARD_RPC_LIMITS)) {
    assert.equal(new StandardRpcClient({ limits: { [key]: 1 } }).limits[key], 1);
    for (const value of [0, -1, 1.5, maximum + 1, NaN, '1']) assert.throws(() => new StandardRpcClient({ limits: { [key]: value } }), { code: 'INVALID_RPC_LIMIT' });
  }
  assert.throws(() => new StandardRpcClient({ limits: { retries: 1 } }), { code: 'INVALID_RPC_LIMIT' });
  for (const url of ['not-a-url-private-key', 'file:///private-key', 'javascript:private-key']) assert.throws(() => new StandardRpcClient({ url }), { code: 'INVALID_RPC_URL' });
});

test('successful multi-chunk UTF-8 is retained byte-for-byte with exact hashes and isolated snapshots', async () => {
  let raw, tick = 0;
  const rpc = new StandardRpcClient({ now: () => tick++, fetchImpl: async (_url, init) => {
    raw = '  ' + JSON.stringify({ result: { label: '€ / 日本語', amount: '9007199254740993' }, id: JSON.parse(init.body).id, jsonrpc: '2.0' }) + '\n';
    const bytes = Buffer.from(raw), split = bytes.indexOf(Buffer.from('€')) + 1;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0, split)); controller.enqueue(bytes.subarray(split)); controller.close(); } }));
  } });
  const result = await rpc.call('eth_getBalance', [address('1'), { blockHash: '0x' + 'a'.repeat(64), requireCanonical: true }]);
  result.label = 'mutated by caller';
  const evidence = rpc.snapshotEvidence();
  assert.equal(evidence[0].responseText, raw);
  assert.equal(evidence[0].transport.responseSha256, sha(raw));
  assert.equal(evidence[0].transport.observedPrefixSha256, sha(raw));
  assert.equal(evidence[0].transport.retainedPrefixSha256, sha(raw));
  assert.equal(evidence[0].transport.observedBytes, Buffer.byteLength(raw));
  assert.equal(evidence[0].transport.retainedPrefixBytes, Buffer.byteLength(raw));
  assert.equal(evidence[0].transport.bodyRetained, true);
  assert.equal(evidence[0].transport.complete, true);
  assert.equal(evidence[0].requestSha256, sha(evidence[0].requestText));
  assert.equal(evidence[0].requestBytes, Buffer.byteLength(evidence[0].requestText));
  assert.equal(rpc.rpcMs, evidence[0].transport.durationMs);
  assert.ok(rpc.rpcMs > 0);
  evidence[0].request.params[0] = 'changed snapshot';
  assert.equal(rpc.snapshotEvidence()[0].request.params[0], address('1'));
});

test('wrong JSON-RPC ids, absent result, result-plus-error and malformed JSON fail closed', async () => {
  for (const payload of [null, [], {}, { jsonrpc: '1.0', id: 1, result: null }, { jsonrpc: '2.0', id: '1', result: null }, { jsonrpc: '2.0', id: 2, result: null }, { jsonrpc: '2.0', id: 1 }, { jsonrpc: '2.0', id: 1, result: null, error: null }]) {
    const raw = JSON.stringify(payload), rpc = new StandardRpcClient({ fetchImpl: async () => new Response(raw) });
    await assert.rejects(rpc.call('eth_chainId'), { code: 'RPC_INVALID_RESPONSE' });
    const evidence = rpc.snapshotEvidence()[0];
    assert.equal(evidence.responseText, undefined);
    assert.equal(evidence.transport.responseSha256, sha(raw));
    assert.equal(evidence.transport.bodyRetained, false);
  }
  const rpc = new StandardRpcClient({ fetchImpl: async () => new Response('{not json') });
  await assert.rejects(rpc.call('eth_chainId'), { code: 'RPC_INVALID_RESPONSE' });
});

test('invalid UTF-8 and leading BOM are rejected without losing complete original byte hash', async () => {
  for (const raw of [Buffer.from([0x7b, 0xff, 0x7d]), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"jsonrpc":"2.0","id":1,"result":"0x1"}')])]) {
    const rpc = new StandardRpcClient({ fetchImpl: async () => new Response(raw) });
    await assert.rejects(rpc.call('eth_chainId'), { code: 'RPC_INVALID_RESPONSE' });
    const evidence = rpc.snapshotEvidence()[0];
    assert.equal(evidence.responseText, undefined);
    assert.equal(evidence.transport.responseSha256, sha(raw));
    assert.equal(evidence.transport.observedBytes, raw.length);
    assert.equal(evidence.transport.complete, true);
  }
});

test('HTTP, direct RPC, nested RPC and transport errors retain only safe diagnostics and body hashes', async () => {
  const secret = 'PRIVATE_PROVIDER_CREDENTIAL_123';
  const outputs = [
    { status: 503, raw: `Failed Authorization: Bearer ${secret}`, code: 'RPC_HTTP_ERROR' },
    { status: 200, raw: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: secret, data: { Authorization: secret } } }), code: 'RPC_EXECUTION_ERROR' },
    { status: 200, raw: JSON.stringify({ jsonrpc: '2.0', id: 1, error: null }), code: 'RPC_EXECUTION_ERROR' },
    { status: 200, raw: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ...frame, calls: [{ ...frame, error: { code: -32603, message: secret, data: { Authorization: secret } } }] } }), code: 'RPC_EXECUTION_ERROR' },
  ];
  for (const sample of outputs) {
    const rpc = new StandardRpcClient({ fetchImpl: async () => new Response(sample.raw, { status: sample.status }) });
    await assert.rejects(rpc.call('debug_traceCall', []), { code: sample.code });
    const evidence = rpc.snapshotEvidence()[0];
    assert.equal(evidence.responseText, undefined);
    assert.equal(evidence.transport.responseSha256, sha(sample.raw));
    assert.equal(evidence.transport.observedBytes, Buffer.byteLength(sample.raw));
    assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE_PROVIDER|Authorization/);
  }
  const rpc = new StandardRpcClient({ fetchImpl: async () => { throw new Error(secret); } });
  await assert.rejects(rpc.call('eth_chainId'), { code: 'RPC_CONNECTION_ERROR' });
  assert.doesNotMatch(JSON.stringify(rpc.snapshotEvidence()), /PRIVATE_PROVIDER/);
});

test('real EVM failure strings are preserved while provider-configuration echoes are withheld', async () => {
  const reverted = { ...frame, error: 'execution reverted', revertReason: 'Contract-defined public reason' };
  const good = new StandardRpcClient({ fetchImpl: async (_url, init) => new Response(success(init, reverted)) });
  assert.deepEqual(await good.call('debug_traceCall', []), reverted);
  for (const [url, secret] of [
    ['https://provider.test?key=secret-query-value', 'secret-query-value'],
    ['https://username:secret-password@provider.test', 'secret-password'],
    ['https://provider.test/v2/secret-path-token', 'secret-path-token'],
    ['https://username:secret%3Apassword@provider.test', 'secret:password'],
  ]) {
    const rpc = new StandardRpcClient({ url, fetchImpl: async (_url, init) => new Response(success(init, { ...reverted, revertReason: secret })) });
    await assert.rejects(rpc.call('debug_traceCall', []), { code: 'RPC_INVALID_RESPONSE' });
    assert.equal(rpc.snapshotEvidence()[0].responseText, undefined);
    assert.ok(!JSON.stringify(rpc.snapshotEvidence()).includes(secret));
  }
});

test('JSON Unicode escaping cannot hide a private provider value from the response filter', async () => {
  const secret = 'special-private-value';
  const rpc = new StandardRpcClient({ url: 'https://provider.test?key=' + secret, fetchImpl: async (_url, init) => {
    const raw = success(init, { ...frame, revertReason: secret }).replace(secret, '\\u0073' + secret.slice(1));
    return new Response(raw);
  } });
  await assert.rejects(rpc.call('debug_traceCall', []), { code: 'RPC_INVALID_RESPONSE' });
  assert.equal(rpc.snapshotEvidence()[0].responseText, undefined);
  assert.ok(!JSON.stringify(rpc.snapshotEvidence()).includes(secret));
});

test('per-response oversize retains bounded prefix hash but never labels it a complete body', async () => {
  let canceled = 0, reads = 0;
  const raw = Buffer.from('0123456789abcdef');
  const rpc = new StandardRpcClient({ limits: { responseBytes: 7 }, fetchImpl: async () => readerResponse({ async read() { reads++; return { done: false, value: raw }; }, async cancel() { canceled++; } }) });
  await assert.rejects(rpc.call('eth_chainId'), { code: 'RPC_RESPONSE_TOO_LARGE' });
  const evidence = rpc.snapshotEvidence()[0];
  assert.equal(reads, 1); assert.equal(canceled, 1);
  assert.equal(evidence.transport.complete, false);
  assert.equal(evidence.transport.observedBytes, 16);
  assert.equal(evidence.transport.retainedPrefixBytes, 7);
  assert.equal(evidence.transport.observedPrefixSha256, sha(raw));
  assert.equal(evidence.transport.retainedPrefixSha256, sha(raw.subarray(0, 7)));
  assert.equal(evidence.transport.responseSha256, undefined);
  assert.equal(evidence.responseText, undefined);
});

test('shared byte and call budgets stop subsequent requests before fetch', async () => {
  let fetched = 0;
  const rpc = new StandardRpcClient({ limits: { totalBytes: 5 }, fetchImpl: async () => { fetched++; return new Response('0123456789'); } });
  await assert.rejects(rpc.call('eth_chainId'), { code: 'RPC_RESPONSE_TOO_LARGE' });
  await assert.rejects(rpc.call('eth_chainId'), { code: 'RPC_BUDGET' });
  assert.equal(fetched, 1);
  assert.equal(rpc.observedBytes, 10); assert.equal(rpc.retainedBytes, 5);
  const one = new StandardRpcClient({ limits: { calls: 1 }, fetchImpl: async (_url, init) => { fetched++; return new Response(success(init)); } });
  await one.call('eth_chainId');
  await assert.rejects(one.call('eth_chainId'), { code: 'RPC_BUDGET' });
  assert.equal(fetched, 2);
});

test('concurrent calls share the total retained-byte cap and cannot fetch again after exhaustion', async () => {
  let fetched = 0;
  const rpc = new StandardRpcClient({ limits: { totalBytes: 60 }, fetchImpl: async (_url, init) => {
    fetched++; return new Response(success(init));
  } });
  const results = await Promise.allSettled([rpc.call('eth_chainId'), rpc.call('eth_chainId')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'RPC_RESPONSE_TOO_LARGE');
  assert.equal(rpc.retainedBytes, 60);
  assert.equal(rpc.observedBytes, 78);
  await assert.rejects(rpc.call('eth_chainId'), { code: 'RPC_BUDGET' });
  assert.equal(fetched, 2);
});

test('wall deadline is checked at EOF and prevents later requests', async () => {
  let time = 0, fetches = 0, reads = 0;
  const rpc = new StandardRpcClient({ now: () => time, limits: { wallMs: 20 }, fetchImpl: async (_url, init) => {
    fetches++;
    return readerResponse({ async read() { if (reads++ === 0) return { done: false, value: Buffer.from(success(init)) }; time = 21; return { done: true }; }, async cancel() {} });
  } });
  await assert.rejects(rpc.call('eth_chainId'), { code: 'RPC_TIMEOUT' });
  await assert.rejects(rpc.call('eth_chainId'), { code: 'RPC_BUDGET' });
  assert.equal(fetches, 1);
  assert.equal(rpc.snapshotEvidence()[0].responseText, undefined);
});

test('the request deadline is checked at EOF even before its timer callback runs', async () => {
  let time = 0, reads = 0;
  const rpc = new StandardRpcClient({ now: () => time, limits: { requestMs: 5 }, fetchImpl: async (_url, init) => readerResponse({
    async read() { if (reads++ === 0) return { done: false, value: Buffer.from(success(init)) }; time = 6; return { done: true }; }, async cancel() {},
  }) });
  await assert.rejects(rpc.call('eth_chainId'), { code: 'RPC_TIMEOUT' });
  assert.equal(rpc.snapshotEvidence()[0].responseText, undefined);
});

test('request timeout includes body reading, even when reader ignores AbortSignal', async () => {
  const pending = deferred(); let canceled = 0, settled = false;
  const rpc = new StandardRpcClient({ limits: { requestMs: 5 }, fetchImpl: async () => readerResponse({ read: () => pending.promise, async cancel() { canceled++; } }) });
  const outcome = rpc.call('eth_chainId').then(() => ({ success: true }), error => ({ code: error.code })).finally(() => { settled = true; });
  let early, sealed;
  try { await delay(30); early = settled; sealed = early ? rpc.snapshotEvidence() : null; }
  finally { pending.resolve({ done: false, value: Buffer.from('late secret body') }); await outcome; await delay(5); }
  assert.equal(early, true, 'A body reader ignoring abort must not outlive the deadline.');
  assert.deepEqual(await outcome, { code: 'RPC_TIMEOUT' });
  assert.ok(canceled >= 1);
  assert.deepEqual(rpc.snapshotEvidence(), sealed);
  assert.equal(rpc.observedBytes, 0);
});

test('late fetch completion cannot mutate sealed timeout evidence or retain response bytes', async () => {
  const pending = deferred(); let canceled = 0, settled = false;
  const rpc = new StandardRpcClient({ limits: { requestMs: 5 }, fetchImpl: () => pending.promise });
  const outcome = rpc.call('eth_chainId').then(() => ({ success: true }), error => ({ code: error.code })).finally(() => { settled = true; });
  await delay(30);
  const early = settled, sealed = early ? rpc.snapshotEvidence() : null;
  pending.resolve(readerResponse({ async read() { return { done: false, value: Buffer.from('late secret body') }; }, async cancel() { canceled++; } }));
  await outcome; await delay(5);
  assert.equal(early, true, 'Fetch ignoring abort must not outlive the deadline.');
  assert.deepEqual(await outcome, { code: 'RPC_TIMEOUT' });
  assert.deepEqual(rpc.snapshotEvidence(), sealed);
  assert.equal(rpc.observedBytes, 0);
  assert.ok(canceled >= 1);
});

test('a never-settling cancellation cannot block an already detected byte-limit failure', async () => {
  const cancel = deferred(); let settled = false;
  const rpc = new StandardRpcClient({ limits: { responseBytes: 1, requestMs: 5 }, fetchImpl: async () => readerResponse({ async read() { return { done: false, value: Buffer.from('too large') }; }, cancel: () => cancel.promise }) });
  const outcome = rpc.call('eth_chainId').then(() => ({ success: true }), error => ({ code: error.code })).finally(() => { settled = true; });
  let early;
  try { await delay(30); early = settled; }
  finally { cancel.resolve(); await outcome; }
  assert.equal(early, true, 'Reader cancellation must not defeat the request bound.');
  assert.deepEqual(await outcome, { code: 'RPC_RESPONSE_TOO_LARGE' });
});
