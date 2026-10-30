import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { executeCohortCases, invokeProductHandler } from './cohort-runner.mjs';
import { createCohortSelection } from './cohort-accounting.mjs';
import { createCohortTransport, createCohortWireBudget } from './cohort-wire.mjs';
import { createAppServer } from '../../src/server.js';
import { loadStandardApi } from '../../src/standard-loader.js';
import { StandardRpcClient } from '../../src/standard-rpc.js';
import { VERSION } from '../../src/config.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const dir = new URL('../../reports/ethereum-lending-local-reference/', import.meta.url);
const manifestBytes = readFileSync(new URL('manifest.json', dir));
assert.equal(sha(manifestBytes), '34b1e325ea08604705e50f06da81e442bb48cea017faf3058671e1e1a4e8f8c5');
const manifest = JSON.parse(manifestBytes);
function read(path) {
  const bytes = readFileSync(new URL(path, dir)), entry = manifest.files.find(x => x.path === path);
  assert.equal(sha(bytes), entry.sha256); assert.equal(bytes.length, entry.bytes); return JSON.parse(bytes);
}
const plan = read('plan.json');
const identity = { name: 'Sealed reference fixture with test-only identity wrapper', version: '1',
  sourceSha256: sha(JSON.stringify({ runtime: plan.runtime, sourceFiles: plan.sourceFiles })), sourceFiles: plan.sourceFiles.map(x => x.path) };
function fixture() {
  const selection = createCohortSelection({ chainId: 1, seed: '0x' + '7'.repeat(64), sampleSize: 16, census: plan.cases.map((c, i) => ({
    transactionHash: c.originalTransactionHash, blockHash: c.header.hash, blockNumber: BigInt(c.header.number).toString(), transactionIndex: String(i),
  })) });
  const selected = selection.rows.map((row, i) => ({ ...row, parentHeader: structuredClone(plan.cases[i].header), parentBlockHash: plan.cases[i].header.hash,
    projection: { status: 'projectable', reasons: [], request: structuredClone(plan.cases[i].apiInput) } }));
  const events = [], saved = [];
  return { events, saved, options: { census: { selection, selected }, expectedProductImplementation: plan.api.expectedImplementation, expectedLocalImplementation: identity,
    executeLocal: async ({ id }) => { events.push('local:' + id); const c = plan.cases[Number(id) - 1]; return { dispatch: 'completed', implementation: identity, attempt: read(c.id + '-local.json') }; },
    executeProduct: async ({ id }) => { events.push('product:' + id); const c = plan.cases[Number(id) - 1]; return { dispatch: 'completed', httpStatus: 200, report: read(c.id + '-product.json') }; },
    save(path, value) { events.push('save:' + path); saved.push({ path, value }); },
  } };
}

test('real sealed comparisons are orchestrated once, local saved before product, and every selected row counted', async () => {
  const f = fixture(), result = await executeCohortCases(f.options);
  assert.equal(result.status, 'complete'); assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows.map(r => r.adjudication.outcome.comparison), ['match', 'match']);
  assert.equal(result.accounting.counts.execution.success, 2); assert.equal(result.accounting.counts.comparison.match, 2);
  for (const id of ['001', '002']) {
    assert(f.events.indexOf('local:' + id) < f.events.indexOf(`save:cases/${id}/local.json`));
    assert(f.events.indexOf(`save:cases/${id}/local.json`) < f.events.indexOf('product:' + id));
    assert.equal(f.events.filter(e => e === 'product:' + id).length, 1);
  }
});

test('unsupported selected input remains in denominator with no local/product replacement', async () => {
  const f = fixture(); f.options.census.selected[0].projection = { status: 'unsupported', reasons: ['contract_creation'] };
  const result = await executeCohortCases(f.options);
  assert.equal(result.accounting.counts.selected, 2); assert.equal(result.accounting.counts.execution.unsupported, 1);
  assert.equal(result.accounting.counts.execution.success, 1); assert(!f.events.includes('local:001')); assert(!f.events.includes('product:001'));
});

test('budget loss retains selected unattempted slots and never dispatches them', async () => {
  const f = fixture(); f.options.canAttempt = ({ row }) => row.transactionHash === f.options.census.selected[0].transactionHash;
  const result = await executeCohortCases(f.options);
  assert.equal(result.accounting.counts.execution.budget_unattempted, 1); assert.equal(result.accounting.counts.selected, 2);
  assert.equal(result.rows[1].local.dispatch, 'budget_unattempted'); assert.equal(result.rows[1].product.dispatch, 'budget_unattempted');
  assert(!f.events.includes('local:002')); assert(!f.events.includes('product:002'));
});

test('unavailable local inputs do not prevent independently supported product execution', async () => {
  const f = fixture(); f.options.executeLocal = async () => { throw new Error('private provider error'); };
  const result = await executeCohortCases(f.options);
  assert.equal(result.accounting.counts.execution.success, 2); assert.equal(result.accounting.counts.comparison.oracle_unavailable, 2);
  assert(!JSON.stringify(result).includes('private provider error'));
});

test('save failure stops further dispatch, retains remaining rows, and withholds aggregate metrics', async () => {
  const f = fixture(); f.options.save = path => { if (path === 'cases/001/local.json') throw new Error('disk full'); };
  const result = await executeCohortCases(f.options);
  assert.equal(result.status, 'interrupted'); assert.equal(result.fatal.code, 'artifact_save_failed'); assert.equal(result.accounting, null);
  assert.equal(result.interruptedLedger.length, 2); assert.deepEqual(f.events, ['local:001']);
});

test('wire persistence failure inside either executor is fatal and never a comparable unavailable attempt', async () => {
  for (const phase of ['executeLocal', 'executeProduct']) {
    const f = fixture(); f.options[phase] = async () => { throw Object.assign(new Error('disk'), { code: 'wire_save_failed' }); };
    const result = await executeCohortCases(f.options);
    assert.equal(result.status, 'interrupted'); assert.equal(result.accounting, null); assert.equal(result.fatal.code, 'wire_save_failed');
    assert(!f.events.includes('local:002')); assert(!f.events.includes('product:001'));
  }
});

test('externally latched save failure caught by an engine still invalidates accounting and stops dispatch', async () => {
  const f = fixture(); let failed = false;
  f.options.executeLocal = async () => { failed = true; return { dispatch: 'unavailable' }; };
  f.options.assertHealthy = () => { if (failed) throw Object.assign(new Error('wire'), { code: 'wire_save_failed' }); };
  const result = await executeCohortCases(f.options);
  assert.equal(result.status, 'interrupted'); assert.equal(result.accounting, null); assert(!f.events.includes('product:001'));
});

test('altered selection or omitted selected rows are rejected before execution', async () => {
  for (const change of [f => f.options.census.selected.pop(), f => { f.options.census.selection = structuredClone(f.options.census.selection); f.options.census.selection.selectionId = 'wrong'; }]) {
    const f = fixture(); change(f); await assert.rejects(executeCohortCases(f.options)); assert.deepEqual(f.events, []);
  }
});

test('actual current product handler preserves all recorded Aave request/response bytes through cohort transport', async () => {
  const exchangeBytes = readFileSync(new URL('../../reports/standard-evm-positions-v3/http/001.json', import.meta.url));
  const sealedManifest = JSON.parse(readFileSync(new URL('../../reports/standard-evm-positions-v3/manifest.json', import.meta.url)));
  const entry = sealedManifest.files.find(x => x.path === 'http/001.json'); assert.equal(sha(exchangeBytes), entry.sha256);
  const exchange = JSON.parse(exchangeBytes), saved = JSON.parse(exchange.response.bodyText), records = saved.transportEvidence;
  const apiRequest = JSON.parse(exchange.request.bodyText); let at = 0, mismatch = false;
  const transport = createCohortTransport({ budget: createCohortWireBudget(), provider: 'drpc', profile: 'product', blockHash: apiRequest.block,
    fetchImpl: async (_url, options) => { const r = records[at++]; try { assert.equal(options.body, r.requestText); } catch { mismatch = true; throw new Error('Recorded request differs'); } return new Response(r.responseText, { status: r.httpStatus }); },
  });
  const rpc = new StandardRpcClient({ url: transport.url, fetchImpl: transport.fetch });
  const output = await invokeProductHandler({ createAppServer, standardApi: await loadStandardApi(), rpc, apiRequest });
  assert.equal(mismatch, false); assert.equal(at, records.length); assert.equal(output.dispatch, 'completed'); assert.equal(output.httpStatus, 200);
  assert.equal(output.invocation, 'in_process_archived_http_handler'); assert.equal(output.report.execution.status, 'success');
  assert.equal(sha(output.response.bodyText), output.response.sha256);
  assert.deepEqual(output.report.preview, saved.preview);
  // Preserve the original capture identity. Independently bind current source
  // additions instead of relabeling the recorded observation as a new capture.
  const currentFiles = [...saved.implementation.sourceFiles, 'src/local-loader.js', 'src/local-simulation.js', 'src/proof-rpc.js', 'engines/evm-context.js', 'src/arbitrum-loader.js', 'engines/local-evm/delegation-runtime-patch.js'].sort();
  const currentHash = createHash('sha256');
  for (const path of currentFiles) currentHash.update(path + '\0').update(readFileSync(new URL('../../' + path, import.meta.url))).update('\0');
  assert.deepEqual(output.report.implementation, { name: saved.implementation.name, version: VERSION, sourceSha256: currentHash.digest('hex'), sourceFiles: currentFiles });
  assert.deepEqual(transport.records().map(r => r.responseText), records.map(r => r.responseText));
});

test('pre-cancelled product does not construct a server; late handler responses cannot restore success', async () => {
  const pre = new AbortController(); pre.abort(); let constructed = 0, response;
  const create = () => { constructed++; return { listeners: () => [async (_req, res) => { response = res; await new Promise(() => {}); }], close() {} }; };
  const options = { createAppServer: create, standardApi: { implementation: {} }, rpc: { call() {} }, apiRequest: {} };
  const before = await invokeProductHandler({ ...options, signal: pre.signal }); assert.equal(before.dispatch, 'budget_unattempted'); assert.equal(constructed, 0);
  const after = await invokeProductHandler({ ...options, wallMs: 10, drainMs: 10 }); assert.equal(after.dispatch, 'unavailable');
  const snapshot = JSON.stringify(after); response.end('{}'); assert.equal(JSON.stringify(after), snapshot);
});

test('timed-out handler cannot issue a later RPC and cooperative pending transport drains before return', async () => {
  let calls = 0, saved = false; const controller = new AbortController();
  const rpc = { call() { calls++; return new Promise((resolve, reject) => controller.signal.addEventListener('abort', () => setTimeout(() => { saved = true; reject(new Error('aborted')); }, 5), { once: true })); } };
  const create = options => ({ listeners: () => [async (_req, res) => {
    const client = options.standardRpcFactory({ profile: 'single' });
    try { await client.call('eth_chainId', []); } catch {}
    try { await client.call('eth_chainId', []); } catch {}
    res.end('{}');
  }], close() {} });
  const output = await invokeProductHandler({ createAppServer: create, standardApi: { implementation: {} }, rpc, apiRequest: {}, wallMs: 5, abortPending: () => controller.abort() });
  assert.equal(output.dispatch, 'unavailable'); assert.equal(output.drain.complete, true); assert.equal(saved, true); assert.equal(calls, 1);
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(calls, 1);
});
