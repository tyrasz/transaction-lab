import { readFile, writeFile, mkdir, readdir, readlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual as equal } from 'node:util';
import { sha, captureHttp, proofTransport } from './wire.mjs';
import { deriveCases, walk } from './freeze.mjs';
import { compareReference } from './compare.mjs';

const DIR = dirname(fileURLToPath(import.meta.url)), ROOT = join(DIR, '../..');
const save = async (p, value) => writeFile(join(DIR, p), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
export async function checkFiles(plan, original = true) {
  const archiveFiles = (await walk(join(DIR, 'runtime'), 'engines/local-evm')).sort();
  if (!equal(archiveFiles, plan.sourceFiles.map(e => e.path).sort())) throw Error('Archive file inventory differs');
  for (const entry of plan.sourceFiles) {
    for (const base of original ? [ROOT, join(DIR, 'runtime')] : [join(DIR, 'runtime')]) {
      const p = join(base, entry.path);
      if (entry.kind === 'symlink') { if (await readlink(p) !== entry.target) throw Error('Dependency symlink changed'); }
      else { const b = await readFile(p); if (b.length !== entry.bytes || sha(b) !== entry.sha256) throw Error('Runtime source changed: ' + entry.path); }
    }
  }
  if (original) {
    const deps = (await walk(ROOT, 'engines/local-evm/node_modules')).sort();
    if (!equal(deps, plan.sourceFiles.filter(e => e.path.includes('/node_modules/')).map(e => e.path).sort())) throw Error('Installed dependency inventory differs');
  }
  for (const entry of [...plan.inputFiles, ...plan.scripts]) {
    const b = await readFile(join(DIR, entry.path));
    if (b.length !== entry.bytes || sha(b) !== entry.sha256) throw Error('Frozen packet source changed');
    if (original && entry.source) {
      const old = await readFile(join(ROOT, entry.source)); if (sha(old) !== entry.sha256) throw Error('Original selected input changed');
    }
  }
}
async function inventory(dir = DIR, prefix = '') {
  const out = [];
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(prefix, e.name); if (path === 'manifest.json') continue;
    if (e.isDirectory()) out.push(...await inventory(join(dir, e.name), path));
    else if (e.isSymbolicLink()) out.push({ path, kind: 'symlink', target: await readlink(join(dir, e.name)) });
    else { const b = await readFile(join(dir, e.name)); out.push({ path, bytes: b.length, sha256: sha(b) }); }
  }
  return out;
}
export async function load(expected) {
  const bytes = await readFile(join(DIR, 'plan.json')), plan = JSON.parse(bytes);
  if (sha(bytes) !== expected) throw Error('Plan SHA differs');
  if (process.version !== plan.runtime.node || !equal(process.versions, plan.runtime.versions)) throw Error('Node runtime differs');
  await checkFiles(plan);
  const selected = deriveCases(JSON.parse(await readFile(join(DIR, 'inputs/deposit-plan.json'))),
    await Promise.all(['aave', 'morpho'].map(async n => JSON.parse(await readFile(join(DIR, `inputs/${n}-parent.json`))))));
  const mod = p => import(pathToFileURL(join(DIR, 'runtime/engines/local-evm', p)));
  const [{ verifyEthereumHeader }, { createRpcStateInputs }, { createProofStateManager }, { executeEthereumCall }] =
    await Promise.all(['ethereum-header.js', 'rpc-state-inputs.js', 'proof-state.js', 'ethereum-call.js'].map(mod));
  for (const c of selected) c.headerVerification = verifyEthereumHeader({ header: c.header, expectedHash: c.apiInput.block });
  if (!equal(selected, plan.cases)) throw Error('Planned cases differ from frozen original inputs');
  return { plan, createRpcStateInputs, createProofStateManager, executeEthereumCall };
}
export async function run(expected) {
  const { plan, createRpcStateInputs, createProofStateManager, executeEthereumCall } = await load(expected);
  // Exclusive marker precedes every possible public/localhost dispatch.
  await save('STARTED.json', { planSha256: expected, startedAt: new Date().toISOString(), runtime: plan.runtime,
    cases: plan.cases.map(c => ({ id: c.id, request: c.request, headerVerification: c.headerVerification })) });
  await mkdir(join(DIR, 'raw'), { recursive: true });
  const began = performance.now(), overallDeadline = began + plan.limits.totalMs;
  const shared = { bytes: 0, maxBytes: plan.limits.sharedLocalResponseBytes }, attempts = [], products = [];
  let fatal = null, localPhaseSavedAt = null;
  try {
    for (const c of plan.cases) {
      const started = performance.now(), scope = { bytes: 0, maxBytes: plan.limits.localCaseResponseBytes };
      const rpc = proofTransport({ provider: plan.provider, header: c.header, shared, scope,
        maxCalls: plan.limits.proofCodeCallsPerAttempt, requestMs: plan.limits.requestMs, responseBytes: plan.limits.bodyBytes,
        deadline: Math.min(overallDeadline, started + plan.limits.attemptMs),
        save: async record => {
          const base = `raw/${c.id}-${String(record.id).padStart(3, '0')}`;
          await writeFile(join(DIR, base + '.body'), Buffer.from(record.rawBase64, 'base64'), { flag: 'wx' });
          delete record.rawBase64; record.bodyPath = base + '.body'; await save(base + '.json', record);
        } });
      let inputs, state, output = null, harnessError = null;
      try {
        inputs = createRpcStateInputs({ chainId: plan.chainId, blockHash: c.header.hash, header: c.header, rpc,
          limits: { calls: plan.limits.proofCodeCallsPerAttempt, wallMs: plan.limits.attemptMs,
            requestMs: plan.limits.requestMs, responseBytes: plan.limits.bodyBytes, totalBytes: plan.limits.localCaseResponseBytes } });
        state = createProofStateManager({ inputs });
        output = await executeEthereumCall({ request: c.request, header: c.header, stateManager: state, limits: { wallMs: plan.limits.attemptMs } });
      } catch { harnessError = { code: 'local_attempt_interrupted', message: 'The fixed local attempt could not produce a complete executor response.' }; }
      // A collector timeout can beat the transport save. Drain its existing
      // bounded request before all snapshots and before a subsequent phase.
      await rpc.drain();
      const row = { id: c.id, provider: plan.provider, startedAt: new Date(Date.now() - (performance.now() - started)).toISOString(),
        completedAt: new Date().toISOString(), durationMs: performance.now() - started, output, harnessError,
        inputs: inputs?.snapshotInputs() ?? null, inputEvidence: inputs?.snapshotEvidence() ?? [], inputUsage: inputs?.snapshotUsage() ?? null,
        stateReads: state?.snapshotReads() ?? null, changes: state?.snapshotChanges() ?? null,
        transport: rpc.records, transportDenied: rpc.denied, transportUsage: rpc.usage(), headerVerification: c.headerVerification };
      await save(c.id + '-local.json', row); attempts.push(row);
      console.log(JSON.stringify({ phase: 'local_saved', case: c.id, status: output?.execution?.status ?? 'unavailable',
        calls: rpc.records.length, bytes: scope.bytes, durationMs: row.durationMs }));
    }
    localPhaseSavedAt = new Date().toISOString();
    await save('LOCAL-PHASE-SAVED.json', { completedAt: localPhaseSavedAt, cases: attempts.map(a => a.id), productRequestsStarted: 0 });
    // First product access is after both independent local records are saved.
    for (const c of plan.cases) {
      const record = await captureHttp({ url: plan.api.url, body: c.apiInput,
        deadline: Math.min(overallDeadline, performance.now() + plan.limits.apiTimeoutMs), requestMs: plan.limits.apiTimeoutMs,
        responseBytes: plan.limits.apiBodyBytes, shared: { bytes: 0, maxBytes: plan.limits.apiBodyBytes } });
      await writeFile(join(DIR, c.id + '-product.body'), Buffer.from(record.rawBase64, 'base64'), { flag: 'wx' });
      delete record.rawBase64; record.bodyPath = c.id + '-product.body'; await save(c.id + '-product-http.json', record);
      if (record.parsed !== undefined) await save(c.id + '-product.json', record.parsed);
      products.push({ id: c.id, record });
      console.log(JSON.stringify({ phase: 'product_saved', case: c.id, httpStatus: record.httpStatus ?? null,
        captureStatus: record.status, rpcCalls: record.parsed?.transportEvidence?.length ?? null }));
    }
  } catch {
    fatal = { code: 'capture_interrupted', message: 'The fixed capture could not complete. All saved attempts and wire outcomes are retained; no retry or replacement occurs.' };
  }
  let sourceUnchanged = true; try { await checkFiles(plan); } catch { sourceUnchanged = false; }
  const cases = plan.cases.map(c => {
    const local = attempts.find(a => a.id === c.id), productRecord = products.find(p => p.id === c.id)?.record, product = productRecord?.parsed;
    const wire = Array.isArray(product?.transportEvidence) ? product.transportEvidence : null;
    let comparison = { status: 'incomplete', reason: 'Local or product response unavailable.' };
    if (local?.output && productRecord?.status === 'completed' && productRecord.httpStatus === 200 && product) {
      try { comparison = compareReference(local, product, c.request, c.header, plan.api.expectedImplementation); }
      catch { comparison = { status: 'incomplete', reason: 'Comparison could not validate the retained evidence.' }; }
    }
    return { id: c.id, local: { attempted: !!local, executionStatus: local?.output?.execution?.status ?? (local ? 'unavailable' : 'not_attempted'),
      calls: local?.transportUsage?.dispatches ?? 0, observedBytes: local?.transportUsage?.observedBytes ?? 0,
      durationMs: local?.durationMs ?? null, harnessError: local?.harnessError ?? null },
    product: { attempted: !!productRecord, httpStatus: productRecord?.httpStatus ?? null, captureStatus: productRecord?.status ?? 'not_attempted',
      implementation: product?.implementation ?? null, implementationMatched: equal(product?.implementation, plan.api.expectedImplementation),
      rpcCalls: wire?.length ?? null, observedRpcBytes: wire?.reduce((s, r) => s + (r?.transport?.observedBytes ?? 0), 0) ?? null,
      durationMs: productRecord?.transport?.durationMs ?? null }, comparison };
  });
  const results = { schemaVersion: '1.0', planSha256: expected, completedAt: new Date().toISOString(), durationMs: performance.now() - began,
    workloads: 2, plannedLocalAttempts: 2, completedLocalAttempts: attempts.length, plannedProductRequests: 2, attemptedProductRequests: products.length,
    localPhaseSavedAt, retries: 0, replacements: 0, sourceUnchanged, fatal,
    localCalls: cases.reduce((s, c) => s + c.local.calls, 0), localObservedBytes: shared.bytes,
    productRpcCalls: cases.every(c => c.product.rpcCalls !== null) ? cases.reduce((s, c) => s + c.product.rpcCalls, 0) : null,
    productObservedRpcBytes: cases.every(c => c.product.observedRpcBytes !== null) ? cases.reduce((s, c) => s + c.product.observedRpcBytes, 0) : null,
    cases, violations: [],
    limitations: ['Two selected development workloads, not a blind cohort or an accuracy/security score.',
      'Proofs authenticate demanded initial facts against selected header commitments; consensus, finality, block body and full poststate root remain unverified.',
      'Unsigned unpriced parent-block-end calls: no outer signature, fees, time advancement, original transaction position or complete economic-inventory claim.',
      'Per-case unavailable, unsupported, resource-limited, reverted and mismatched outcomes are retained without adaptive replacement.'] };
  for (const c of cases) {
    if (c.local.calls > plan.limits.proofCodeCallsPerAttempt) results.violations.push(c.id + ':local_call_budget');
    if (c.local.observedBytes > plan.limits.localCaseResponseBytes) results.violations.push(c.id + ':local_byte_budget');
    if (c.product.rpcCalls > plan.limits.apiInternalRpcCallsPerCase) results.violations.push(c.id + ':product_call_budget');
    if (c.product.observedRpcBytes > plan.limits.apiInternalResponseBytesPerCase) results.violations.push(c.id + ':product_byte_budget');
  }
  if (shared.bytes > shared.maxBytes) results.violations.push('shared_local_byte_budget');
  if (results.durationMs > plan.limits.totalMs) results.violations.push('overall_wall_budget');
  results.validity = !sourceUnchanged ? 'invalid_source_drift' : results.violations.length ? 'invalid_resource_budget' : fatal ? 'capture_incomplete' : 'capture_completed';
  await save('results.json', results);
  const files = await inventory(); await save('manifest.json', { schemaVersion: '1.0', sealedAt: new Date().toISOString(), planSha256: expected, files, filesCount: files.length });
  console.log(JSON.stringify({ manifestSha256: sha(await readFile(join(DIR, 'manifest.json'))), results }));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!/^[0-9a-f]{64}$/.test(process.argv[3] ?? '')) throw Error('Pass --check or --run and exact plan SHA');
  if (process.argv[2] === '--check') { const { plan } = await load(process.argv[3]); console.log(JSON.stringify({ status: 'ready', sources: plan.sourceFiles.length, cases: plan.cases.map(c => ({ id: c.id, headerVerification: c.headerVerification })) })); }
  else if (process.argv[2] === '--run') await run(process.argv[3]); else throw Error('Invalid command');
}
