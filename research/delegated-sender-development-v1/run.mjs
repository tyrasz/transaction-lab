import { readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual as equal } from 'node:util';
import { freezeCohortSources, verifyFrozenSources, verifyNodeRuntime } from './freeze.mjs';
import { createArtifactWriter, sealEvidence } from './artifacts.mjs';
import { sha, need, regularBytes, copyOriginalInputs, verifyOriginalInputs, readRecordedOracle, ORIGINAL_MANIFEST_SHA } from './inputs.mjs';
import { adjudicateLocalOutcome } from './outcomes.mjs';
import { createCohortTransport, createCohortWireBudget, COHORT_PROVIDERS } from '../standard-evm/cohort-wire.mjs';

export const PREFIX = 'research/delegated-sender-development-v1';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const POLICY = Object.freeze({ cases: ['002', '015'], chainId: 1, totalCalls: 512, totalResponseBytes: 64 * 1024 * 1024,
  localCalls: 256, localResponseBytes: 32 * 1024 * 1024, localWallMs: 145000, executionWallMs: 120000,
  responseBytes: 8 * 1024 * 1024, requestMs: 25000, dispatchMs: 330000, terminalDrainMs: 25000, liveCeilingMs: 360000,
  retries: 0, replacements: 0, providerFallback: false, freshOracleCalls: 0 });
export const SCOPE = Object.freeze({ kind: 'known_case_development_recheck', evaluatedProduct: 'current_archived_isolated_local_engine',
  selection: 'two_previously_observed_runtime_code_sender_failures', localInputs: 'fresh_verified_proof_code_and_authenticated_ancestry_only',
  oracle: 'previously_recorded_drpc_four_wire_bracket_known_before_development', originalDenominatorModified: false,
  prospective: false, heldOut: false, populationRate: null, apiAvailabilityEvaluated: false, assetInventoryEvaluated: false,
  feesSettled: false, originalTransactionReplay: false, consensusVerified: false, freshCanonicalHeaderCheck: false,
  timing: '330s_absolute_and_monotonic_dispatch_plus_at_most25s_terminal_drain_offline_integrity_and_seal_excluded' });
const REQUIRED = ['run.mjs', 'freeze.mjs', 'verify.mjs', 'inputs.mjs', 'outcomes.mjs', 'artifacts.mjs', 'PLAN.md'].map(n => PREFIX + '/' + n);
const json = (root, path) => JSON.parse(regularBytes(root, path));

export async function freezeRun({ repoRoot = ROOT, outputDirectory, originalDirectory = join(repoRoot, 'reports/ordinary-local-coverage-v1') }) {
  const frozen = await freezeCohortSources({ repoRoot, outputDirectory }), writer = createArtifactWriter(frozen.outputDirectory);
  const inputs = copyOriginalInputs({ originalDirectory, outputDirectory: frozen.outputDirectory });
  writer.write('inputs.json', inputs);
  const plan = { schemaVersion: '1.0', title: 'Two known existing-delegated-sender development rechecks', frozenAt: new Date().toISOString(),
    policy: POLICY, scope: SCOPE, provider: { name: 'drpc', url: COHORT_PROVIDERS.drpc }, sourceManifestSha256: frozen.manifestSha256,
    localImplementation: frozen.manifest.localImplementation, runtime: frozen.manifest.runtime,
    inputsSha256: sha(readFileSync(join(frozen.outputDirectory, 'inputs.json'))), originalManifestSha256: ORIGINAL_MANIFEST_SHA, cases: inputs.cases };
  writer.write('plan.json', plan); const planSha256 = sha(readFileSync(join(frozen.outputDirectory, 'plan.json')));
  writer.write('FROZEN.json', { schemaVersion: '1.0', frozenAt: plan.frozenAt, planSha256, sourceManifestSha256: plan.sourceManifestSha256, publicDispatches: 0 });
  await loadPlan({ outputDirectory: frozen.outputDirectory, expectedPlanSha256: planSha256 });
  return { outputDirectory: frozen.outputDirectory, planSha256, sourceManifestSha256: plan.sourceManifestSha256, publicDispatches: 0 };
}
export async function loadPlan({ outputDirectory, expectedPlanSha256 }) {
  need(typeof expectedPlanSha256 === 'string' && /^[0-9a-f]{64}$/.test(expectedPlanSha256), 'explicit_plan_hash_required');
  const directory = realpathSync(resolve(outputDirectory)), bytes = regularBytes(directory, 'plan.json'), plan = JSON.parse(bytes);
  need(sha(bytes) === expectedPlanSha256 && plan.schemaVersion === '1.0' && equal(plan.policy, POLICY) && equal(plan.scope, SCOPE) && equal(plan.provider, { name: 'drpc', url: COHORT_PROVIDERS.drpc }) && plan.originalManifestSha256 === ORIGINAL_MANIFEST_SHA, 'plan_differs');
  const source = await verifyFrozenSources({ outputDirectory: directory, expectedManifestSha256: plan.sourceManifestSha256 });
  need(REQUIRED.every(path => source.manifest.files.some(f => f.path === path && f.kind === 'file')), 'required_source_missing');
  need(equal(plan.localImplementation, source.manifest.localImplementation) && equal(plan.runtime, source.manifest.runtime), 'implementation_differs');
  const rawInputs = regularBytes(directory, 'inputs.json'); need(sha(rawInputs) === plan.inputsSha256, 'inputs_identity_differs');
  const inputs = verifyOriginalInputs({ outputDirectory: directory, expected: JSON.parse(rawInputs) });
  need(equal(plan.cases, inputs.cases), 'fixed_cases_differ');
  need(equal(json(directory, 'FROZEN.json'), { schemaVersion: '1.0', frozenAt: plan.frozenAt, planSha256: expectedPlanSha256, sourceManifestSha256: plan.sourceManifestSha256, publicDispatches: 0 }), 'frozen_differs');
  return { directory, plan, source, inputs };
}
export function createTimingGate({ now = Date.now, monotonic = () => performance.now() } = {}) {
  const wallStartedAtMs = now(), monotonicStartedAtMs = monotonic();
  let priorWall = wallStartedAtMs, priorMono = monotonicStartedAtMs;
  let invalid = !Number.isSafeInteger(priorWall) || priorWall < 0 || !Number.isFinite(priorMono) || priorMono < 0;
  function sample() {
    const wall = now(), mono = monotonic();
    invalid ||= !Number.isSafeInteger(wall) || wall < priorWall || !Number.isFinite(mono) || mono < priorMono;
    priorWall = wall; priorMono = mono;
    return { wall, wallElapsedMs: wall - wallStartedAtMs, monotonicElapsedMs: mono - monotonicStartedAtMs };
  }
  return Object.freeze({ wallStartedAtMs, monotonicStartedAtMs,
    remaining() {
      const value = sample();
      return invalid ? 0 : Math.max(0, Math.floor(Math.min(POLICY.dispatchMs - value.wallElapsedMs, POLICY.dispatchMs - value.monotonicElapsedMs)));
    },
    terminal() {
      const value = sample(), limitMs = POLICY.dispatchMs + POLICY.terminalDrainMs;
      const status = invalid ? 'clock_invalid' : Math.max(value.wallElapsedMs, value.monotonicElapsedMs) > limitMs ? 'overrun' : 'within_budget';
      // Invalid readings remain explicit JSON nulls, never a zero-duration success.
      const numeric = value => Number.isFinite(value) ? value : null;
      return { status, clockValid: !invalid, limitMs, wallStartedAtMs: numeric(wallStartedAtMs), wallFinishedAtMs: numeric(value.wall),
        wallElapsedMs: numeric(value.wallElapsedMs), monotonicElapsedMs: numeric(value.monotonicElapsedMs) };
    },
  });
}
export async function executeFixedCases({ cases, implementation, executeLocal, readOracle, save, hashArtifact, canAttempt, assertHealthy }) {
  const rows = cases.map(item => ({ id: item.id, transactionHash: item.transactionHash, status: 'not_attempted', localArtifact: null, outcomeArtifact: null }));
  let fatal = null;
  for (const [index, item] of cases.entries()) {
    if (fatal) break;
    try {
      assertHealthy(); save(`cases/${item.id}/request.json`, item);
      rows[index].status = 'attempting';
      const local = canAttempt() ? await executeLocal(item) : { dispatch: 'budget_unattempted', implementation, attempt: null, transportWireIds: [], reason: 'Frozen absolute budget prevented this fixed case; no replacement' };
      const path = `cases/${item.id}/local.json`; save(path, local); rows[index].localArtifact = path;
      save(`cases/${item.id}/LOCAL_SEALED.json`, { schemaVersion: '1.0', ...hashArtifact(path), wireIds: local.transportWireIds, lastWireId: local.transportWireIds.at(-1) ?? null, at: new Date().toISOString() });
      assertHealthy();
      // This is deliberately the first parsed oracle read in a running case.
      const oracle = await readOracle(item);
      save(`cases/${item.id}/RECORDED_ORACLE_USED.json`, { schemaVersion: '1.0', originalManifestSha256: ORIGINAL_MANIFEST_SHA, originalArtifact: `cases/${item.id}/oracle.json`, wireIds: oracle.transportWireIds, at: new Date().toISOString(), previouslyKnown: true, freshCalls: 0 });
      const outcome = await adjudicateLocalOutcome({ transactionHash: item.transactionHash, request: item.request, header: item.header, expectedLocalImplementation: implementation, local, oracle });
      const outcomePath = `cases/${item.id}/outcome.json`; save(outcomePath, outcome);
      Object.assign(rows[index], { status: 'retained', outcomeArtifact: outcomePath, outcome: outcome.outcome, allChannelsComplete: outcome.allChannelsComplete });
    } catch (error) { fatal = { id: item.id, code: error?.code === 'artifact_save_failed' ? error.code : 'case_integrity_or_execution_failure' }; rows[index].status = 'interrupted'; }
  }
  return { status: fatal ? 'interrupted' : 'complete', fatal, rows };
}
export async function finiteDrain(transports, ms) {
  let timer; try { return await Promise.race([Promise.allSettled([...transports].map(t => t.drain())).then(r => r.every(x => x.status === 'fulfilled')), new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
  finally { clearTimeout(timer); }
}
export async function runFrozen({ outputDirectory, expectedPlanSha256 }) {
  const { directory, plan } = await loadPlan({ outputDirectory, expectedPlanSha256 });
  need(resolve(fileURLToPath(import.meta.url)) === join(directory, 'runtime', PREFIX, 'run.mjs'), 'archived_entrypoint_required');
  await verifyNodeRuntime(plan.runtime);
  const { executeIsolatedEthereumCall } = await import('../../engines/local-evm/isolated-call.js');
  const writer = createArtifactWriter(directory), gate = createTimingGate(), budget = createCohortWireBudget({ limits: { calls: POLICY.totalCalls, totalBytes: POLICY.totalResponseBytes, wallMs: POLICY.dispatchMs } });
  const began = gate.monotonicStartedAtMs, startedAt = new Date(gate.wallStartedAtMs).toISOString(), controller = new AbortController(), transports = new Set(), failures = [];
  let closed = false, caseRun = null, sourceUnchanged = false, runtimeUnchanged = false;
  const save = (path, value) => { need(!closed, 'capture_closed'); writer.write(path, value); };
  save('STARTED.json', { schemaVersion: '1.0', planSha256: expectedPlanSha256, sourceManifestSha256: plan.sourceManifestSha256, startedAt, pid: process.pid, runtime: plan.runtime });
  const timer = setTimeout(() => controller.abort(), POLICY.dispatchMs);
  const health = () => need(!writer.failed && !budget.snapshot().saveFailure, 'artifact_save_failed');
  const canAttempt = () => { health(); const b = budget.snapshot(); return !controller.signal.aborted && gate.remaining() > 1000 && b.calls < POLICY.totalCalls && b.observedBytes < POLICY.totalResponseBytes; };
  const check = () => loadPlan({ outputDirectory: directory, expectedPlanSha256 });
  const drainMs = () => Math.max(1, Math.min(POLICY.terminalDrainMs, POLICY.dispatchMs + POLICY.terminalDrainMs - (performance.now() - began)));
  try {
    caseRun = await executeFixedCases({ cases: plan.cases, implementation: plan.localImplementation, save, canAttempt, assertHealthy: health,
      hashArtifact: path => { const b = regularBytes(directory, path); return { path, bytes: b.length, sha256: sha(b) }; },
      executeLocal: async item => {
        await check(); health(); need(canAttempt(), 'absolute_deadline');
        const wire = createCohortTransport({ budget, provider: 'drpc', profile: 'local', blockHash: item.header.hash, header: item.header, save: r => save(`wire/${String(r.globalId).padStart(6, '0')}.json`, r) }); transports.add(wire);
        const phase = new AbortController(), signal = AbortSignal.any([controller.signal, phase.signal]); let attempt;
        try {
          attempt = await executeIsolatedEthereumCall({ request: item.request, header: item.header, signal, limits: { wallMs: Math.max(1, Math.min(POLICY.localWallMs, gate.remaining())), drainMs: POLICY.terminalDrainMs },
            rpc: { call: async (method, params, options) => { need(canAttempt(), 'absolute_deadline'); const result = await wire.call(method, params, { signal: AbortSignal.any([signal, ...(options?.signal ? [options.signal] : [])]) }); need(gate.remaining() > 0, 'absolute_deadline'); return result; } } });
        } finally { phase.abort(); need(await finiteDrain([wire], drainMs()), 'transport_drain_incomplete'); health(); transports.delete(wire); }
        need(attempt && attempt.broker?.pendingAtReturn === 0 && (!attempt.isolation?.childPid || attempt.isolation.processClosed), 'local_drain_incomplete');
        await check(); return { dispatch: attempt.status === 'completed' ? 'completed' : 'unavailable', implementation: plan.localImplementation, attempt, transportWireIds: wire.records().map(r => r.globalId), transportUsage: wire.usage(), transportDenied: wire.denied() };
      }, readOracle: async item => { await check(); return readRecordedOracle({ outputDirectory: directory, item }); } });
  } catch (error) { failures.push({ code: ['artifact_save_failed', 'transport_drain_incomplete', 'local_drain_incomplete'].includes(error?.code) ? error.code : 'capture_interrupted' }); }
  finally { clearTimeout(timer); controller.abort(); if (!await finiteDrain(transports, drainMs())) failures.push({ code: 'transport_drain_incomplete' }); }
  const terminalTiming = gate.terminal(), executionWindowMs = terminalTiming.monotonicElapsedMs; closed = true;
  if (terminalTiming.status !== 'within_budget') failures.push({ code: terminalTiming.status === 'clock_invalid' ? 'terminal_clock_invalid' : 'terminal_deadline_exceeded' });
  try { await check(); sourceUnchanged = true; } catch { failures.push({ code: 'source_or_input_drift' }); }
  try { await verifyNodeRuntime(plan.runtime); runtimeUnchanged = true; } catch { failures.push({ code: 'runtime_drift' }); }
  if (writer.failed || budget.snapshot().saveFailure) failures.push({ code: 'artifact_save_failed' });
  const results = { schemaVersion: '1.0', status: failures.length || caseRun?.status !== 'complete' ? 'interrupted' : 'complete', statusMeaning: 'Capture completion only; each execution and comparison outcome remains explicit',
    planSha256: expectedPlanSha256, sourceManifestSha256: plan.sourceManifestSha256, sourceUnchanged, runtimeUnchanged, caseRun, comparisonsUsable: failures.length === 0 && caseRun?.status === 'complete',
    budget: budget.snapshot(), startedAt, finishedAt: new Date().toISOString(), durationMs: performance.now() - began, executionWindowMs, terminalTiming, failures, scope: plan.scope };
  writer.write('results.json', results); const evidence = sealEvidence(directory, expectedPlanSha256, plan.sourceManifestSha256);
  return { ...results, evidence };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, directory, expected] = process.argv.slice(2);
  if (command === 'freeze' && directory && !expected) console.log(JSON.stringify(await freezeRun({ outputDirectory: directory }), null, 2));
  else if (command === 'check' && directory && expected) { await loadPlan({ outputDirectory: directory, expectedPlanSha256: expected }); console.log(JSON.stringify({ status: 'verified', planSha256: expected })); }
  else if (command === 'run' && directory && expected) { const p = await loadPlan({ outputDirectory: directory, expectedPlanSha256: expected }); const archived = await import(pathToFileURL(join(p.directory, 'runtime', PREFIX, 'run.mjs'))); console.log(JSON.stringify(await archived.runFrozen({ outputDirectory: p.directory, expectedPlanSha256: expected }), null, 2)); }
  else throw Error('Use freeze DIR, check DIR PLAN_SHA, or run DIR PLAN_SHA. Dispatch requires separate authorization.');
}
