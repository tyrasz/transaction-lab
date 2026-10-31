import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';

const sha = b => createHash('sha256').update(b).digest('hex');
const json = x => JSON.stringify(x, null, 2) + '\n';
const read = async p => JSON.parse(await fs.readFile(p, 'utf8'));
const write = async (p, value) => fs.writeFile(p, json(value), { flag: 'wx' });
const providers = [
  { id: 'drpc', url: 'https://hyperliquid.drpc.org' },
  { id: 'hyperlend-archive', url: 'https://rpc.hyperlend.finance/archive' },
];
const sender = '0x9a1dbc6a6e7e59f6beb23db0d00b603fc90e94d0';
const whype = '0x5555555555555555555555555555555555555555';
const native = (id, to, data, value) => ({ id, request: { chainId: 999, from: sender, to, data, value } });
const runtime = async () => ({ node: process.version, platform: process.platform, arch: process.arch,
  executableSha256: sha(await fs.readFile(process.execPath)) });
let manifestPin;
function summary(saved, bytes) {
  const { id, report, error, records } = saved;
  return { id, file: id + '.json', sha256: sha(bytes), error,
    execution: error ? null : report?.execution?.status ?? null, nativeStatus: error ? 'unavailable' : report?.nativeBalanceChanges?.status ?? null,
    nativeAmounts: error ? [] : report?.nativeBalanceChanges?.assets?.map(x => ({ account: x.account, beforeRaw: x.beforeRaw, afterRaw: x.afterRaw, deltaRaw: x.deltaRaw })) ?? [],
    tokenStatus: error ? 'unavailable' : report?.balanceChanges?.status ?? null, rpcCalls: records.length };
}
function comparisons(plan, outcomes) {
  return plan.cases.map((item, i) => {
    const a = outcomes[i * 2], b = outcomes[i * 2 + 1];
    return { case: item.id, status: !a || !b || a.error || b.error ? 'unavailable' : 'observed',
      nativeAmountsEqual: !a || !b || a.error || b.error || !['measured', 'partial'].includes(a.nativeStatus) || !['measured', 'partial'].includes(b.nativeStatus) ? null : isDeepStrictEqual(a.nativeAmounts, b.nativeAmounts),
      scope: 'Provider consistency for native amounts only; provider/client independence is not established.' };
  });
}

async function freeze(directory) {
  const root = process.cwd(), files = new Set(['package.json']);
  // All fingerprinted src files plus the actual server static import closure.
  for (const entry of await fs.readdir(path.join(root, 'src'), { withFileTypes: true }))
    if (entry.isFile() && entry.name.endsWith('.js')) files.add('src/' + entry.name);
  const visited = new Set();
  async function visit(name) {
    if (visited.has(name)) return; visited.add(name); files.add(name);
    const source = await fs.readFile(path.join(root, name), 'utf8');
    for (const match of source.matchAll(/^\s*(?:import|export)\s+(?:[^;]*?\s+from\s+)?['"]([^'"]+)['"]/gm)) {
      if (match[1].startsWith('node:')) continue;
      assert(match[1].startsWith('.'), 'Unexpected external static import');
      const child = path.posix.normalize(path.posix.join(path.posix.dirname(name), match[1]));
      assert(!child.startsWith('../') && !path.isAbsolute(child)); await visit(child);
    }
  }
  await visit('src/server.js');
  await fs.mkdir(directory); const entries = [];
  for (const name of [...files].sort()) {
    const bytes = await fs.readFile(path.join(root, name)), dest = path.join(directory, 'runtime', name);
    await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.writeFile(dest, bytes, { flag: 'wx' });
    entries.push({ path: 'runtime/' + name, bytes: bytes.length, sha256: sha(bytes) });
  }
  const harness = await fs.readFile(fileURLToPath(import.meta.url));
  await fs.writeFile(path.join(directory, 'driver.mjs'), harness, { flag: 'wx' });
  entries.push({ path: 'driver.mjs', bytes: harness.length, sha256: sha(harness) });
  const explanation = await fs.readFile(new URL('./PLAN.md', import.meta.url));
  await fs.writeFile(path.join(directory, 'PLAN.md'), explanation, { flag: 'wx' });
  entries.push({ path: 'PLAN.md', bytes: explanation.length, sha256: sha(explanation) });
  const { EXAMPLES } = await import(pathToFileURL(path.join(directory, 'runtime/src/config.js')));
  const cases = [native('001-wallet-transfer', '0x000000000000000000000000000000000000dead', '0x', '1000000000000'),
    native('002-self-transfer', sender, '0x', '1000000000000'), native('003-whype-deposit', whype, '0xd0e30db0', '1000000000000'),
    native('004-whype-withdraw', whype, '0x2e1a7d4d' + '1'.padStart(64, '0'), '0'),
    { id: '005-hyperlend-supply', request: structuredClone(EXAMPLES.find(x => x.id === 'hyperlend-usdc-supply').request) }];
  const plan = { schema: 1, createdAt: new Date().toISOString(), providers, cases, attempts: 10,
    selection: 'first-provider latest minus two blocks; no fallback', runtime: await runtime(),
    scope: { readOnly: true, signed: false, broadcast: false, fees: 'excluded', independentClientClaim: false, installedAppChanged: false } };
  await write(path.join(directory, 'plan.json'), plan);
  const bytes = await fs.readFile(path.join(directory, 'plan.json')); entries.push({ path: 'plan.json', bytes: bytes.length, sha256: sha(bytes) });
  await write(path.join(directory, 'manifest.json'), { files: entries, staticClosure: [...visited].sort(), optionalEngines: 'absent and unused' });
  manifestPin = sha(await fs.readFile(path.join(directory, 'manifest.json')));
  await verify(directory);
  // Prove the archived static closure imports without optional dependencies.
  const { simulate } = await import(pathToFileURL(path.join(directory, 'runtime/src/server.js'))); assert.equal(typeof simulate, 'function');
  console.log(json({ frozen: directory, files: entries.length, attempts: plan.attempts, planSha256: sha(bytes), manifestSha256: manifestPin }));
}
async function verify(directory) {
  const manifestBytes = await fs.readFile(path.join(directory, 'manifest.json')); assert.equal(sha(manifestBytes), manifestPin, 'Frozen manifest changed');
  const manifest = JSON.parse(manifestBytes);
  for (const entry of manifest.files) {
    const bytes = await fs.readFile(path.join(directory, entry.path)); assert.equal(bytes.length, entry.bytes); assert.equal(sha(bytes), entry.sha256, entry.path);
  }
  const actual = [];
  async function walk(dir) { for (const e of await fs.readdir(path.join(directory, dir), { withFileTypes: true })) {
    assert(!e.isSymbolicLink(), 'Unexpected archived symlink');
    const name = dir + '/' + e.name; if (e.isDirectory()) await walk(name); else { assert(e.isFile()); actual.push(name); }
  } }
  await walk('runtime'); assert.deepEqual(actual.sort(), manifest.files.filter(x => x.path.startsWith('runtime/')).map(x => x.path).sort());
}
function semantic(report) {
  const r = structuredClone(report); delete r.id; delete r.createdAt; delete r.timing; return r;
}
async function modules(directory) {
  const server = await import(pathToFileURL(path.join(directory, 'runtime/src/server.js')));
  const rpc = await import(pathToFileURL(path.join(directory, 'runtime/src/rpc.js')));
  return { ...server, ...rpc };
}
async function run(directory) {
  await verify(directory); const plan = await read(path.join(directory, 'plan.json'));
  assert.deepEqual(await runtime(), plan.runtime);
  await write(path.join(directory, 'STARTED.json'), { startedAt: new Date().toISOString(), runtime: plan.runtime, manifestSha256: manifestPin });
  const { simulate, RpcClient, RpcError } = await modules(directory);
  const matrixMono = performance.now(), matrixWall = Date.now();
  class Recorded extends RpcClient {
    constructor(provider) { super({ url: provider.url }); this.records = []; this.completions = 0; this.started = performance.now(); this.wallStarted = Date.now(); }
    expired() { return performance.now() - this.started > 225000 || Date.now() - this.wallStarted > 225000 ||
      performance.now() - matrixMono > 900000 || Date.now() - matrixWall > 900000; }
    async call(method, params = []) {
      if (this.records.length >= 70 || this.expired()) throw new RpcError('Capture request budget exhausted.', 'CAPTURE_BUDGET');
      const row = { id: this.records.length + 1, method, params: structuredClone(params) }; this.records.push(row);
      try { const result = await super.call(method, params); row.result = structuredClone(result);
        if (this.expired()) throw new RpcError('Capture request budget exhausted.', 'CAPTURE_BUDGET'); return result; }
      catch (error) { row.error = { code: error.code ?? 'CAPTURE_ERROR', message: error instanceof RpcError ? error.message : 'Unexpected capture failure.',
        ...(Number.isSafeInteger(error?.detail?.rpcCode) ? { detail: { rpcCode: error.detail.rpcCode } } : {}) }; throw error; }
      finally { row.completionSequence = ++this.completions; }
    }
  }
  const select = new Recorded(plan.providers[0]); let selected, selectionError;
  try {
    await select.verifyChain(); const head = await select.call('eth_getBlockByNumber', ['latest', false]);
    const number = '0x' + (BigInt(head.number) - 2n).toString(16);
    selected = await select.call('eth_getBlockByNumber', [number, false]); assert.equal(selected.number, number);
  } catch (error) { selectionError = { code: error.code ?? 'SELECTION_FAILURE', message: error instanceof RpcError ? error.message : 'Block selection could not be validated.' }; }
  await write(path.join(directory, 'selection.json'), { selected: selected ?? null, error: selectionError ?? null, records: select.records });
  const outcomes = [];
  if (selected && !selectionError) {
    for (const item of plan.cases) for (const provider of plan.providers) {
      await verify(directory); const rpc = new Recorded(provider), input = { ...item.request, block: selected.number };
      let report, error; const started = performance.now();
      try { report = await simulate(input, rpc); assert.equal(report.source.blockHash, selected.hash);
        if (rpc.expired()) throw new RpcError('Capture request budget exhausted.', 'CAPTURE_BUDGET'); }
      catch (e) { error = { code: e.code ?? 'CAPTURE_FAILURE', message: e instanceof RpcError ? e.message : 'Simulation or pinned-block validation failed.' }; }
      const id = item.id + '-' + provider.id, result = { id, provider, input, report: report ?? null, error: error ?? null,
        records: rpc.records, elapsedMs: performance.now() - started, reportVerification: error ? 'unverified' : 'validated_by_api' };
      const filename = id + '.json'; await write(path.join(directory, filename), result);
      outcomes.push(summary(result, await fs.readFile(path.join(directory, filename))));
      console.log(json(outcomes.at(-1)));
    }
  }
  await verify(directory);
  const terminal = { status: selectionError ? 'selection_unavailable' : 'completed', completedAt: new Date().toISOString(),
    plannedAttempts: plan.attempts, outcomes, selectionError: selectionError ?? null, manifestSha256: manifestPin,
    selectionSha256: sha(await fs.readFile(path.join(directory, 'selection.json'))),
    comparisons: comparisons(plan, outcomes) };
  await write(path.join(directory, 'terminal.json'), terminal); console.log(json({ status: terminal.status, attempts: outcomes.length }));
}
async function replay(directory) {
  await verify(directory); const { simulate, RpcError } = await modules(directory), terminal = await read(path.join(directory, 'terminal.json'));
  assert.equal(sha(await fs.readFile(path.join(directory, 'manifest.json'))), terminal.manifestSha256);
  const plan = await read(path.join(directory, 'plan.json')); assert.deepEqual(await runtime(), plan.runtime);
  assert.equal(sha(await fs.readFile(path.join(directory, 'selection.json'))), terminal.selectionSha256);
  const results = [], selection = await read(path.join(directory, 'selection.json'));
  const slots = plan.cases.flatMap(item => plan.providers.map(provider => ({ item, provider })));
  assert.equal(terminal.plannedAttempts, slots.length);
  assert.equal(terminal.outcomes.length, selection.error ? 0 : slots.length, 'Fixed attempt denominator changed');
  assert.deepEqual(terminal.comparisons, comparisons(plan, terminal.outcomes), 'Comparison summary changed');
  for (const [slotIndex, outcome] of terminal.outcomes.entries()) {
    const bytes = await fs.readFile(path.join(directory, outcome.file)); assert.equal(sha(bytes), outcome.sha256);
    const saved = JSON.parse(bytes), records = saved.records; let index = 0;
    assert.deepEqual(outcome, summary(saved, bytes), 'Attempt summary differs from the retained response');
    const { item, provider } = slots[slotIndex]; assert.equal(saved.id, item.id + '-' + provider.id); assert.equal(outcome.id, saved.id);
    assert.equal(outcome.file, saved.id + '.json'); assert.deepEqual(saved.provider, provider);
    assert.deepEqual(saved.input, { ...item.request, block: selection.selected.number });
    assert(!saved.error || saved.error.code !== 'CAPTURE_BUDGET', 'Time/budget-dependent failure remains retained but is not deterministically replayable');
    const completion = [...records].sort((a, b) => a.completionSequence - b.completionSequence).map(x => x.id - 1);
    assert.deepEqual(records.map(x => x.id), records.map((_, i) => i + 1));
    assert.deepEqual(records.map(x => x.completionSequence).sort((a, b) => a - b), records.map((_, i) => i + 1));
    let nextCompletion = 0, scheduled = false;
    const pending = new Map(), assertions = [];
    function pump() {
      if (scheduled) return; scheduled = true;
      setImmediate(() => {
        scheduled = false; const rowIndex = completion[nextCompletion], waiter = pending.get(rowIndex);
        if (!waiter) return; pending.delete(rowIndex); nextCompletion++;
        const row = records[rowIndex];
        if (row.error) waiter.reject(new RpcError(row.error.message, row.error.code, row.error.detail ?? null));
        else waiter.resolve(structuredClone(row.result));
        pump();
      });
    }
    const timer = setTimeout(() => { for (const waiter of pending.values()) waiter.reject(new Error('Recorded completion order could not be replayed.')); }, 10000);
    const rpc = { provider: new URL(saved.provider.url).hostname, rpcMs: 0,
      async verifyChain() { assert.equal(BigInt(await this.call('eth_chainId', [])), 999n); },
      async call(method, params = []) {
        const rowIndex = index++, row = records[rowIndex];
        try { assert(row, 'Unrecorded RPC'); assert.equal(row.method, method); assert.deepEqual(row.params, params); }
        catch (error) { assertions.push(error); throw error; }
        return new Promise((resolve, reject) => { pending.set(rowIndex, { resolve, reject }); pump(); });
      } };
    let report, error;
    try { report = await simulate(saved.input, rpc); assert.equal(report.source.blockHash, selection.selected.hash); }
    catch (e) { error = { code: e.code ?? 'CAPTURE_FAILURE', message: e instanceof RpcError ? e.message : 'Simulation or pinned-block validation failed.' }; }
    finally { clearTimeout(timer); }
    assert.deepEqual(assertions, []); assert.equal(nextCompletion, records.length); assert.equal(pending.size, 0);
    assert.equal(index, records.length, 'Unused retained RPC records');
    assert.deepEqual(error ?? null, saved.error, 'Saved failure outcome changed');
    if (saved.report) { assert(report, 'Saved report was not reproduced'); assert.deepEqual(semantic(report), semantic(saved.report)); }
    else assert.equal(report, undefined, 'An unavailable original became a report');
    results.push({ id: saved.id, recordsConsumed: index, reproduced: true });
  }
  console.log(json({ status: 'reproduced', attempts: results.length, results, networkRequests: 0 }));
}
const [mode, target, suppliedPin] = process.argv.slice(2); assert(['freeze', 'run', 'replay'].includes(mode) && target, 'Usage: capture.mjs freeze|run|replay DIRECTORY [MANIFEST_SHA256]');
const directory = path.resolve(target);
if (mode !== 'freeze') {
  assert(/^[0-9a-f]{64}$/.test(suppliedPin ?? ''), 'An external frozen manifest pin is required'); manifestPin = suppliedPin;
  assert.equal(await fs.realpath(fileURLToPath(import.meta.url)), await fs.realpath(path.join(directory, 'driver.mjs')), 'Run the archived driver');
}
if (mode === 'freeze') await freeze(directory); else if (mode === 'run') await run(directory); else await replay(directory);
