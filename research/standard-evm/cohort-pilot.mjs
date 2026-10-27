import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, openSync, fsyncSync, closeSync, realpathSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual as equal } from 'node:util';
import { freezeCohortSources, verifyFrozenSources, verifyNodeRuntime } from './cohort-freeze.mjs';
import { createCohortTransport, createCohortWireBudget, COHORT_PROVIDERS, COHORT_WIRE_LIMITS } from './cohort-wire.mjs';
import { collectProspectiveCensus, COLLECTOR_LIMITS } from './cohort-collector.mjs';
import { classifyCohortIntents } from './cohort-classification.mjs';
import { executeCohortCases, invokeProductHandler } from './cohort-runner.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sha = value => createHash('sha256').update(value).digest('hex');
const need = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }); };
const EXTRA = ['research/standard-evm/cohort-deployments.json'];
const REQUIRED_COHORT = ['accounting', 'census', 'classification', 'collector', 'freeze', 'outcomes', 'pilot', 'runner', 'verify', 'wire'].map(name => `research/standard-evm/cohort-${name}.mjs`);
export const PILOT_POLICY = Object.freeze({
  chainId: 1, sampleSize: 16, targetOffsets: [1, 2], finalityWaitMs: 1200000, ancestryHeadersPerProvider: 256,
  totalCalls: 6144, totalResponseBytes: 512 * 1024 * 1024, responseBytes: 8 * 1024 * 1024,
  requestMs: 25000, collectionAndExecutionMs: 3600000, terminalDrainMs: 25000,
  localCalls: 256, productCalls: 65, slotCalls: 384, localResponseBytes: 32 * 1024 * 1024,
  productResponseBytes: 32 * 1024 * 1024, localWallMs: 145000, productWallMs: 145000,
  retries: 0, replacements: 0, providerFallback: false,
});
const SCOPE = Object.freeze({
  execution: 'unsigned_unpriced_parent_block_end', fees: 'excluded', originalTransactionPosition: false,
  productInvocation: 'actual_archived_request_handler_in_process_no_listening_socket',
  localExecution: 'fixed_node_child_with_verified_initial_proofs_and_code',
  classification: 'declared_intent_only_not_verified_effects',
  economicInventoryAccuracy: 'not_evaluated', securityAccuracy: 'not_evaluated',
  populationInference: 'two_correlated_future_blocks_descriptive_only',
  timing: '60min_collection_and_execution_window_plus_up_to25s_terminal_drain_offline_integrity_and_sealing_excluded',
});
function boundedJson(path, maxBytes = 256 * 1024 * 1024) {
  const s = lstatSync(path); need(s.isFile() && !s.isSymbolicLink() && s.size <= maxBytes, 'invalid_artifact');
  const bytes = readFileSync(path); return { bytes, value: JSON.parse(bytes) };
}
export function createArtifactWriter(directory) {
  const root = resolve(directory); let failed = false;
  function syncDirectory(path) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
  return Object.freeze({
    get failed() { return failed; },
    write(path, value) {
      let fd;
      try {
        need(typeof path === 'string' && /^[a-zA-Z0-9_./-]+$/.test(path) && !path.startsWith('/') && !path.split('/').some(p => !p || p === '.' || p === '..'), 'artifact_path_invalid');
        const target = join(root, path), parents = path.split('/').slice(0, -1); let current = root;
        need(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), 'artifact_root_invalid');
        for (const part of parents) { const parent = current; current = join(current, part); try { mkdirSync(current); syncDirectory(parent); } catch (error) { if (error.code !== 'EEXIST') throw error; } const s = lstatSync(current); need(s.isDirectory() && !s.isSymbolicLink(), 'artifact_parent_invalid'); }
        const serialized = JSON.stringify(value, null, 2); need(typeof serialized === 'string', 'artifact_json_invalid');
        const text = serialized + '\n'; need(Buffer.byteLength(text) <= 256 * 1024 * 1024, 'artifact_size_limit');
        fd = openSync(target, 'wx', 0o444); writeFileSync(fd, text); fsyncSync(fd); closeSync(fd); fd = undefined;
        syncDirectory(dirname(target));
      } catch { failed = true; throw Object.assign(new Error('artifact_save_failed'), { code: 'artifact_save_failed' }); }
      finally { if (fd !== undefined) closeSync(fd); }
    },
  });
}

export async function freezePilot({ repoRoot = ROOT, outputDirectory }) {
  for (const path of REQUIRED_COHORT) need(lstatSync(join(repoRoot, path)).isFile(), 'required_cohort_source_missing');
  const frozen = await freezeCohortSources({ repoRoot, outputDirectory, extraFiles: EXTRA });
  const writer = createArtifactWriter(frozen.outputDirectory), seed = '0x' + randomBytes(32).toString('hex');
  const plan = { schemaVersion: '1.0', title: 'Ordinary Ethereum prospective 16-slot pilot', frozenAt: new Date().toISOString(), seed,
    policy: PILOT_POLICY, providers: COHORT_PROVIDERS, scope: SCOPE, collectorLimits: COLLECTOR_LIMITS,
    sourceManifestSha256: frozen.manifestSha256, productImplementation: frozen.manifest.productImplementation,
    localImplementation: frozen.manifest.localImplementation, runtime: frozen.manifest.runtime,
    protocol: [
      'Freeze all runtime source, deployment declarations, selection/comparison rules, seed and budgets before any public dispatch.',
      'Observe primary latest H, durably declare H+1/H+2, wait at least20minutes, then observe each fixed finalized tip exactly once.',
      'Retain the full two-provider agreed census and deterministic first min(16,N) hash-ranked sample; no failures are replaced.',
      'For every projectable selected call, independently execute and save local proof-based results before invoking the product handler.',
      'Store exact public RPC bytes including errors before admitting parsed results. Durability failure stops dispatch and withholds metrics.',
      'Use a fixed parent-state unsigned profile; actual signed/mined transaction fidelity, economic completeness and security are separate claims.',
      'All source and Node identities are checked before execution and at finalization. No source or endpoint fallback.',
      'STARTED.json is exclusive and precedes public RPC. Interrupted or completed runs cannot be restarted in the same directory.',
      'The60minute window includes prospective waiting and public collection/execution; cancellation/drain may add25seconds, while offline integrity/sealing are separately timed.',
    ] };
  writer.write('plan.json', plan); const planSha256 = sha(readFileSync(join(frozen.outputDirectory, 'plan.json')));
  writer.write('FROZEN.json', { schemaVersion: '1.0', frozenAt: plan.frozenAt, planSha256, sourceManifestSha256: frozen.manifestSha256, publicDispatches: 0 });
  await loadPilotPlan({ outputDirectory: frozen.outputDirectory, expectedPlanSha256: planSha256 });
  return { outputDirectory: frozen.outputDirectory, planSha256, sourceManifestSha256: frozen.manifestSha256, files: frozen.manifest.filesCount, publicDispatches: 0 };
}
export async function loadPilotPlan({ outputDirectory, expectedPlanSha256 }) {
  need(typeof expectedPlanSha256 === 'string' && /^[a-f0-9]{64}$/.test(expectedPlanSha256), 'explicit_plan_hash_required');
  const directory = realpathSync(resolve(outputDirectory)), { bytes, value: plan } = boundedJson(join(directory, 'plan.json'), 8 * 1024 * 1024);
  need(sha(bytes) === expectedPlanSha256 && plan.schemaVersion === '1.0' && /^0x[a-f0-9]{64}$/.test(plan.seed), 'plan_hash_or_shape_invalid');
  need(equal(plan.policy, PILOT_POLICY) && equal(plan.providers, COHORT_PROVIDERS) && equal(plan.scope, SCOPE) && equal(plan.collectorLimits, COLLECTOR_LIMITS), 'frozen_policy_differs');
  const source = await verifyFrozenSources({ outputDirectory: directory, expectedManifestSha256: plan.sourceManifestSha256 });
  need([...REQUIRED_COHORT, ...EXTRA].every(path => source.manifest.files.some(file => file.path === path && file.kind === 'file')), 'required_cohort_source_missing');
  need(equal(plan.productImplementation, source.manifest.productImplementation) && equal(plan.localImplementation, source.manifest.localImplementation) && equal(plan.runtime, source.manifest.runtime), 'implementation_identity_differs');
  const frozen = boundedJson(join(directory, 'FROZEN.json'), 8192).value;
  need(frozen.planSha256 === expectedPlanSha256 && frozen.sourceManifestSha256 === plan.sourceManifestSha256 && frozen.publicDispatches === 0 && frozen.frozenAt === plan.frozenAt, 'freeze_record_differs');
  return { directory, plan, source };
}
export function classificationInput(census) {
  return { chainId: 1, census: census.census, envelopes: census.envelopes.map(row => ({
    transactionHash: row.transactionHash, blockHash: row.blockHash, blockNumber: row.blockNumber, transactionIndex: row.transactionIndex,
    from: row.normalizedEnvelope.from, to: row.normalizedEnvelope.to, input: row.normalizedEnvelope.input, value: row.normalizedEnvelope.value,
  })) };
}
export function sealEvidence(directory, planSha256, sourceManifestSha256) {
  const files = []; let total = 0;
  function walk(path = '') {
    for (const name of readdirSync(join(directory, path)).sort()) {
      if (!path && ['runtime', 'evidence-manifest.json'].includes(name)) continue;
      const sub = path ? `${path}/${name}` : name, stat = lstatSync(join(directory, sub));
      need(!stat.isSymbolicLink(), 'evidence_symlink');
      if (stat.isDirectory()) walk(sub);
      else {
        need(stat.isFile() && stat.size <= 256 * 1024 * 1024 && files.length < 30000, 'evidence_inventory_limit');
        const bytes = readFileSync(join(directory, sub)); total += bytes.length; need(total <= 8 * 1024 * 1024 * 1024, 'evidence_total_limit');
        files.push({ path: sub, bytes: bytes.length, sha256: sha(bytes) });
      }
    }
  }
  walk(); files.sort((a, b) => a.path.localeCompare(b.path));
  const manifest = { schemaVersion: '1.0', planSha256, sourceManifestSha256, files };
  createArtifactWriter(directory).write('evidence-manifest.json', manifest);
  return { manifestSha256: sha(readFileSync(join(directory, 'evidence-manifest.json'))), files: files.length, bytes: total };
}

export async function runFrozenPilot({ outputDirectory, expectedPlanSha256 }) {
  const { directory, plan } = await loadPilotPlan({ outputDirectory, expectedPlanSha256 });
  need(resolve(fileURLToPath(import.meta.url)) === join(directory, 'runtime/research/standard-evm/cohort-pilot.mjs'), 'run_requires_archived_entrypoint');
  await verifyNodeRuntime(plan.runtime);
  const [{ executeIsolatedEthereumCall }, { createAppServer }, { StandardRpcClient }, { loadStandardApi }] = await Promise.all([
    import('../../engines/local-evm/isolated-call.js'), import('../../src/server.js'), import('../../src/standard-rpc.js'), import('../../src/standard-loader.js'),
  ]);
  const standardApi = await loadStandardApi(); need(equal(standardApi?.implementation, plan.productImplementation), 'archived_product_identity_differs');
  const writer = createArtifactWriter(directory), startedAt = new Date().toISOString();
  writer.write('STARTED.json', { schemaVersion: '1.0', planSha256: expectedPlanSha256, sourceManifestSha256: plan.sourceManifestSha256, startedAt, pid: process.pid, runtime: plan.runtime });
  const began = performance.now(), budget = createCohortWireBudget({ limits: COHORT_WIRE_LIMITS }), controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), plan.policy.collectionAndExecutionMs);
  let eventId = 0, selection = null, classifications = null, caseRun = null, sourceUnchanged = false, runtimeUnchanged = false;
  const failures = [], transports = new Set(), integrity = { failed: false, phaseFailure: null };
  const remaining = () => Math.max(0, Math.floor(plan.policy.collectionAndExecutionMs - (performance.now() - began)));
  const save = (path, value) => writer.write(path, value);
  const note = (phase, fields = {}) => process.stdout.write(JSON.stringify({ phase, at: new Date().toISOString(), ...fields }) + '\n');
  function assertHealthy() {
    need(!writer.failed && !budget.snapshot().saveFailure, 'wire_save_failed');
    need(!integrity.failed, 'source_drift');
    need(!integrity.phaseFailure, integrity.phaseFailure);
  }
  function canAttempt() { assertHealthy(); const b = budget.snapshot(); return !controller.signal.aborted && remaining() > 1000 && b.calls < b.limits.calls && b.observedBytes < b.limits.totalBytes; }
  function transport(profile, provider, blockHash) {
    const instance = createCohortTransport({ budget, profile, provider, ...(blockHash ? { blockHash } : {}),
      save: wire => save(`wire/${String(wire.globalId).padStart(6, '0')}.json`, wire) });
    transports.add(instance); return instance;
  }
  async function sourcesStillMatch() {
    try { await verifyFrozenSources({ outputDirectory: directory, expectedManifestSha256: plan.sourceManifestSha256 }); }
    catch { integrity.failed = true; need(false, 'source_drift'); }
  }
  try {
    note('collecting_prospective_sample', { seed: plan.seed, sampleSlots: 16 });
    const censusTransports = { drpc: transport('census', 'drpc'), publicnode: transport('census', 'publicnode') };
    selection = await collectProspectiveCensus({ transports: censusTransports, seed: plan.seed, sampleSize: 16, signal: controller.signal,
      save: event => { save(`events/${String(++eventId).padStart(5, '0')}.json`, event);
        if (['anchor_declared', 'wait_completed', 'finalized_observed', 'selection_failed', 'complete'].includes(event.kind)) note(event.kind, event.kind === 'anchor_declared' ? { anchor: event.details.anchor, targets: event.details.targetBlockNumbers, waitDeadline: event.details.waitDeadline } : {});
      } });
    await Promise.all(Object.values(censusTransports).map(t => t.drain())); assertHealthy();
    for (const rpc of Object.values(censusTransports)) transports.delete(rpc);
    save('selection.json', selection);
    if (selection.status === 'complete') {
      classifications = classifyCohortIntents(classificationInput(selection.census)); save('classification.json', classifications);
      caseRun = await executeCohortCases({ census: selection.census, expectedProductImplementation: plan.productImplementation, expectedLocalImplementation: plan.localImplementation,
        save, canAttempt, assertHealthy,
        executeLocal: async ({ id, row, request, header }) => {
          await sourcesStillMatch(); assertHealthy();
          const rpc = transport('local', 'drpc', row.parentBlockHash), phaseStarted = performance.now();
          const wallMs = Math.max(1, Math.min(plan.policy.localWallMs, remaining()));
          const attempt = await executeIsolatedEthereumCall({ request, header, rpc, signal: controller.signal, limits: { wallMs, drainMs: plan.policy.terminalDrainMs } });
          await rpc.drain(); assertHealthy();
          if (!(attempt.broker?.pendingAtReturn === 0 && (!attempt.isolation?.childPid || attempt.isolation.processClosed))) { integrity.phaseFailure = 'local_drain_incomplete'; assertHealthy(); }
          const result = { dispatch: attempt.status === 'completed' ? 'completed' : 'unavailable', implementation: plan.localImplementation, attempt,
            transportWireIds: rpc.records().map(r => r.globalId), transportUsage: rpc.usage(), transportDenied: rpc.denied(), durationMs: performance.now() - phaseStarted };
          note('local_attempt_finished', { caseId: id, execution: attempt.output?.execution?.status ?? 'unavailable', calls: rpc.usage().dispatches });
          transports.delete(rpc);
          return result;
        },
        executeProduct: async ({ id, row, apiRequest }) => {
          await sourcesStillMatch(); assertHealthy();
          const wire = transport('product', 'drpc', row.parentBlockHash), phaseController = new AbortController();
          const signal = AbortSignal.any([controller.signal, phaseController.signal]);
          const rpc = new StandardRpcClient({ url: wire.url, fetchImpl: (url, options) => wire.fetch(url, { ...options, signal: AbortSignal.any([signal, options.signal]) }) });
          const result = await invokeProductHandler({ createAppServer, standardApi, rpc, apiRequest, signal: controller.signal,
            abortPending: () => phaseController.abort(), wallMs: Math.max(1, Math.min(plan.policy.productWallMs, remaining())), drainMs: plan.policy.terminalDrainMs });
          await wire.drain(); assertHealthy();
          if (result.drain?.complete !== true) { integrity.phaseFailure = 'product_drain_incomplete'; assertHealthy(); }
          note('product_attempt_finished', { caseId: id, execution: result.report?.execution?.status ?? 'unavailable', calls: wire.usage().dispatches });
          const output = { ...result, transportWireIds: wire.records().map(r => r.globalId), transportUsage: wire.usage(), transportDenied: wire.denied() };
          transports.delete(wire); return output;
        },
      });
    }
  } catch (error) { failures.push({ code: ['wire_save_failed', 'artifact_save_failed', 'source_drift', 'local_drain_incomplete', 'product_drain_incomplete'].includes(error.code) ? error.code : 'capture_interrupted' }); }
  finally {
    clearTimeout(timer); controller.abort();
    for (const rpc of transports) { try { await rpc.drain(); } catch { failures.push({ code: 'wire_save_failed' }); } }
  }
  const executionWindowMs = performance.now() - began, sealingStart = performance.now();
  try { await sourcesStillMatch(); sourceUnchanged = true; } catch { failures.push({ code: 'source_drift' }); }
  try { await verifyNodeRuntime(plan.runtime); runtimeUnchanged = true; } catch { failures.push({ code: 'runtime_drift' }); }
  if (writer.failed || budget.snapshot().saveFailure) failures.push({ code: 'artifact_save_failed' });
  const status = failures.length || caseRun?.status === 'interrupted' ? 'interrupted' : selection?.status === 'complete' ? 'complete' : 'selection_failed';
  if (status === 'interrupted' && caseRun) caseRun = { ...caseRun, accounting: null };
  const result = { schemaVersion: '1.0', status, planSha256: expectedPlanSha256, sourceManifestSha256: plan.sourceManifestSha256,
    sourceUnchanged, runtimeUnchanged, selectionStatus: selection?.status ?? null, caseRun, budget: budget.snapshot(),
    startedAt, finishedAt: new Date().toISOString(), durationMs: performance.now() - began, executionWindowMs, failures, scope: plan.scope };
  save('results.json', result);
  const sealed = sealEvidence(directory, expectedPlanSha256, plan.sourceManifestSha256);
  note('sealed', { status, ...sealed, offlineIntegrityAndSealMs: performance.now() - sealingStart, counts: caseRun?.accounting?.counts ?? null });
  return { ...result, evidence: sealed };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, outputDirectory, expected] = process.argv.slice(2);
  if (command === 'freeze' && outputDirectory && !expected) console.log(JSON.stringify(await freezePilot({ outputDirectory }), null, 2));
  else if (command === 'run' && outputDirectory && expected) {
    const { directory } = await loadPilotPlan({ outputDirectory, expectedPlanSha256: expected });
    const archived = await import(pathToFileURL(join(directory, 'runtime/research/standard-evm/cohort-pilot.mjs')));
    await archived.runFrozenPilot({ outputDirectory: directory, expectedPlanSha256: expected });
  } else if (command === 'verify' && outputDirectory && expected) {
    const bytes = boundedJson(join(resolve(outputDirectory), 'evidence-manifest.json'), 16 * 1024 * 1024);
    need(sha(bytes.bytes) === expected, 'evidence_manifest_hash_differs');
    await verifyFrozenSources({ outputDirectory, expectedManifestSha256: bytes.value.sourceManifestSha256 });
    const archived = await import(pathToFileURL(join(resolve(outputDirectory), 'runtime/research/standard-evm/cohort-verify.mjs')));
    console.log(JSON.stringify(await archived.verifyCohortEvidence({ outputDirectory, expectedManifestSha256: expected }), null, 2));
  } else throw new Error('Usage: node cohort-pilot.mjs freeze DIRECTORY | run DIRECTORY PLAN_SHA256 | verify DIRECTORY EVIDENCE_MANIFEST_SHA256');
}
