// Fixed development regression of four previously unresolved cases. This is
// neither a new prospective sample nor a replacement for the sealed v2 ledger.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, lstatSync, realpathSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual as equal } from 'node:util';
import { freezeCohortSources, verifyFrozenSources, verifyNodeRuntime } from './cohort-freeze.mjs';
import { createArtifactWriter, sealEvidence } from './cohort-pilot.mjs';
import { createCohortTransport, createCohortWireBudget, COHORT_PROVIDERS } from './cohort-wire.mjs';
import { invokeProductHandler, compactAdjudication } from './cohort-runner.mjs';
import { adjudicateCohortOutcome } from './cohort-outcomes.mjs';
import { normalizeEvmContext } from '../../engines/evm-context.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SELF = 'research/standard-evm/recheck-unresolved.mjs';
const V2 = 'reports/ordinary-ethereum-cohort-v2';
const V2_MANIFEST_SHA = '583dfee6412385547791da6069ed6e33322928e0b0231e645c4e956711d1bc2a';
const V2_PLAN_SHA = 'f50095fc407c4966251413f765b9998818e928bc900f6be30c8b881ec0b622e6';
const CASES = [
  ['002', '0x2e3906379c97fc20f4453813a9ed0b602ed5c126286bff0bd371adfecc5a6912'],
  ['005', '0xbfae47d1b359a1e9e080779d9fdf4dfbf30653acbdaa1cf7000b0fc8d8db4d06'],
  ['007', '0x76cda4947526f97179b0bb325183c5e70c8ae7ec066c61294623e521722d2f04'],
  ['016', '0x5401a3f3aa071b77a3e4cee72712c5e616ff42b1ef1eafdb4cf243fcc1df8368'],
];
export const RECHECK_POLICY = Object.freeze({ chainId: 1, provider: 'drpc', calls: 1284, totalBytes: 256 * 1024 * 1024,
  wallMs: 20 * 60 * 1000, requestMs: 25000, responseBytes: 8 * 1024 * 1024, phaseBytes: 32 * 1024 * 1024,
  localCalls: 256, productCalls: 65, phaseWallMs: 145000, drainMs: 25000, gas: '5000000',
  savedInputSupplements: ['005', '016'], retries: 0, replacements: 0, providerFallback: false, stateSubstitution: false });
const SCOPE = Object.freeze({ purpose: 'development_regression_of_four_known_unresolved_v2_cases', prospectiveHoldout: false,
  originalCohortResultsUnchanged: true, originalTransactionPosition: false, outerTransactionValidation: false,
  execution: 'unsigned_unpriced_at_the_exact_original_parent_block', feesSettled: false,
  blobFeeCap: 'explicit_synthetic_zero_for_blob_context', localBeforeProduct: true,
  supplement: 'separate_predeclared_offline_proof_code_reexecution_never_replaces_live_local_attempt',
  productInvocation: 'actual_archived_handler_in_process_no_listening_socket',
  timing: '20min_total_execution_plus_up_to25s_terminal_drain_offline_integrity_and_sealing_excluded',
  populationAccuracy: 'not_evaluated', economicInventoryAccuracy: 'not_evaluated', securityAccuracy: 'not_evaluated' });
const sha = x => createHash('sha256').update(x).digest('hex');
const need = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }); };
const unavailable = reason => ({ dispatch: 'unavailable', reason });
const unattempted = reason => ({ dispatch: 'budget_unattempted', reason });
function read(path, maximum = 128 * 1024 * 1024) {
  const s = lstatSync(path); need(s.isFile() && !s.isSymbolicLink() && s.size <= maximum, 'invalid_artifact');
  const bytes = readFileSync(path); return { bytes, value: JSON.parse(bytes) };
}
function metadata(path, bytes) { return { path, bytes: bytes.length, sha256: sha(bytes) }; }
function originalReader(repoRoot) {
  const base = join(repoRoot, V2), manifest = read(join(base, 'evidence-manifest.json'));
  need(sha(manifest.bytes) === V2_MANIFEST_SHA, 'original_manifest_differs');
  return path => {
    const item = read(join(base, path)), expected = manifest.value.files.find(f => f.path === path);
    need(expected && expected.bytes === item.bytes.length && expected.sha256 === sha(item.bytes), 'original_artifact_differs'); return item;
  };
}
function deriveCases(selection, requests) {
  return CASES.map(([id, hash]) => {
    const saved = requests[id], envelope = selection.census.envelopes.find(e => e.transactionHash === hash)?.normalizedEnvelope;
    need(saved?.transactionHash === hash && envelope?.hash === hash && envelope.chainId === '1' && envelope.to &&
      ['2', '3'].includes(envelope.type) && Object.keys(envelope.extensions).length === 0, 'fixed_case_envelope_differs');
    const header = saved.parentHeader;
    need(BigInt(header.number) + 1n === BigInt(envelope.blockNumber), 'fixed_parent_number_differs');
    const selected = selection.census.selected.find(r => r.transactionHash === hash);
    need(selected?.parentBlockHash === header.hash && equal(selected.parentHeader, header), 'fixed_parent_identity_differs');
    const context = normalizeEvmContext({ ...(envelope.accessList?.length ? { accessList: envelope.accessList } : {}),
      ...(envelope.type === '3' ? { blobVersionedHashes: envelope.blobVersionedHashes } : {}) });
    const apiRequest = { chainId: 1, from: envelope.from, to: envelope.to, data: envelope.input, value: envelope.value, block: header.hash, ...context };
    return { id, transactionHash: hash, header, apiRequest,
      localRequest: { from: apiRequest.from, to: apiRequest.to, data: apiRequest.data, value: apiRequest.value, gas: RECHECK_POLICY.gas, ...context },
      original: { blockHash: envelope.blockHash, blockNumber: envelope.blockNumber, transactionIndex: envelope.transactionIndex, gas: envelope.gas,
        transactionType: envelope.type, nonce: envelope.nonce, ...(envelope.maxFeePerBlobGas ? { maxFeePerBlobGas: envelope.maxFeePerBlobGas } : {}) },
      savedInputSupplement: RECHECK_POLICY.savedInputSupplements.includes(id) ? `inputs/${id}-proof-code.json` : null };
  });
}
export function inspectFixedCases({ repoRoot = ROOT } = {}) {
  const old = originalReader(repoRoot), selection = old('selection.json'), oldPlan = old('plan.json');
  need(sha(oldPlan.bytes) === V2_PLAN_SHA, 'original_plan_differs');
  const requests = Object.fromEntries(CASES.map(([id]) => [id, old(`cases/${id}/request.json`)]));
  return deriveCases(selection.value, Object.fromEntries(Object.entries(requests).map(([k, v]) => [k, v.value])));
}
export async function freezeRecheck({ repoRoot = ROOT, outputDirectory, expectedProductSha256 }) {
  need(/^[a-f0-9]{64}$/.test(expectedProductSha256), 'explicit_stable_product_hash_required');
  const old = originalReader(repoRoot), selection = old('selection.json'), oldPlan = old('plan.json');
  need(sha(oldPlan.bytes) === V2_PLAN_SHA, 'original_plan_differs');
  const requests = Object.fromEntries(CASES.map(([id]) => [id, old(`cases/${id}/request.json`)]));
  const cases = deriveCases(selection.value, Object.fromEntries(Object.entries(requests).map(([k, v]) => [k, v.value])));
  const frozen = await freezeCohortSources({ repoRoot, outputDirectory, extraFiles: ['research/standard-evm/cohort-deployments.json', SELF] });
  need(frozen.manifest.productImplementation.version === '0.15.0' && frozen.manifest.productImplementation.sourceSha256 === expectedProductSha256, 'stable_product_identity_differs');
  const writer = createArtifactWriter(frozen.outputDirectory), inputs = [];
  function copy(path, bytes) {
    const target = join(frozen.outputDirectory, path), fd = openSync(target, 'wx', 0o444);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    const dir = openSync(dirname(target), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
    need(sha(readFileSync(target)) === sha(bytes), 'input_copy_differs'); inputs.push(metadata(path, bytes));
  }
  // The writer creates/fsyncs the inputs directory before exact byte copies.
  writer.write('inputs/provenance.json', { originalDirectory: V2, manifestSha256: V2_MANIFEST_SHA, planSha256: V2_PLAN_SHA });
  inputs.push(metadata('inputs/provenance.json', readFileSync(join(frozen.outputDirectory, 'inputs/provenance.json'))));
  copy('inputs/selection.json', selection.bytes);
  for (const [id] of CASES) {
    copy(`inputs/${id}-request.json`, requests[id].bytes);
    if (RECHECK_POLICY.savedInputSupplements.includes(id)) {
      const saved = old(`cases/${id}/local.json`), attempt = saved.value.attempt;
      need(attempt?.status === 'completed' && attempt.inputs?.status === 'available' && Array.isArray(attempt.inputEvidence), 'saved_input_supplement_unavailable');
      const records = attempt.inputEvidence.map(e => {
        need(e.status === 'received' && e.verification === 'verified' && ['eth_getProof', 'eth_getCode'].includes(e.request?.method) && Object.hasOwn(e, 'result') &&
          e.requestSha256 === sha(JSON.stringify(e.request)) && e.resultSha256 === sha(JSON.stringify(e.result)), 'saved_input_record_invalid');
        return { sourceEvidenceId: e.id, request: e.request, result: e.result, resultSha256: e.resultSha256 };
      });
      const supplement = { source: { path: `${V2}/cases/${id}/local.json`, sha256: sha(saved.bytes), manifestSha256: V2_MANIFEST_SHA },
        expectedOutputsIncluded: false, requestOrder: 'exact_sequential_original_proof_code_reads', records };
      writer.write(`inputs/${id}-proof-code.json`, supplement);
      inputs.push(metadata(`inputs/${id}-proof-code.json`, readFileSync(join(frozen.outputDirectory, `inputs/${id}-proof-code.json`))));
    }
  }
  const plan = { schemaVersion: '1.0', title: 'Four unresolved Ethereum cases: separate development recheck', frozenAt: new Date().toISOString(),
    policy: RECHECK_POLICY, scope: SCOPE, provider: COHORT_PROVIDERS.drpc, originalManifestSha256: V2_MANIFEST_SHA, originalPlanSha256: V2_PLAN_SHA,
    sourceManifestSha256: frozen.manifestSha256, productImplementation: frozen.manifest.productImplementation, localImplementation: frozen.manifest.localImplementation,
    runtime: frozen.manifest.runtime, inputs, cases };
  writer.write('plan.json', plan); const planSha256 = sha(readFileSync(join(frozen.outputDirectory, 'plan.json')));
  writer.write('FROZEN.json', { planSha256, sourceManifestSha256: frozen.manifestSha256, publicDispatches: 0, frozenAt: plan.frozenAt });
  await checkRecheck({ outputDirectory: frozen.outputDirectory, expectedPlanSha256: planSha256 });
  return { outputDirectory: frozen.outputDirectory, planSha256, sourceManifestSha256: frozen.manifestSha256, sourceFiles: frozen.manifest.filesCount, cases: cases.map(c => c.id), publicDispatches: 0 };
}
export async function checkRecheck({ outputDirectory, expectedPlanSha256 }) {
  need(/^[a-f0-9]{64}$/.test(expectedPlanSha256), 'explicit_plan_hash_required');
  const directory = realpathSync(resolve(outputDirectory)), saved = read(join(directory, 'plan.json')), plan = saved.value;
  need(sha(saved.bytes) === expectedPlanSha256 && plan.schemaVersion === '1.0' && equal(plan.policy, RECHECK_POLICY) && equal(plan.scope, SCOPE) &&
    plan.provider === COHORT_PROVIDERS.drpc && plan.originalManifestSha256 === V2_MANIFEST_SHA && plan.originalPlanSha256 === V2_PLAN_SHA, 'frozen_plan_differs');
  const source = await verifyFrozenSources({ outputDirectory: directory, expectedManifestSha256: plan.sourceManifestSha256 });
  need(source.manifest.files.some(f => f.path === SELF) && equal(plan.productImplementation, source.manifest.productImplementation) &&
    equal(plan.localImplementation, source.manifest.localImplementation) && equal(plan.runtime, source.manifest.runtime) && plan.productImplementation.version === '0.15.0', 'source_identity_differs');
  const requiredInputs = ['inputs/provenance.json', 'inputs/selection.json', ...CASES.map(([id]) => `inputs/${id}-request.json`), ...RECHECK_POLICY.savedInputSupplements.map(id => `inputs/${id}-proof-code.json`)].sort();
  need(Array.isArray(plan.inputs) && equal(plan.inputs.map(i => i.path).sort(), requiredInputs), 'input_inventory_differs');
  for (const input of plan.inputs) { need(/^inputs\/[a-zA-Z0-9-]+\.json$/.test(input.path), 'input_path_invalid'); const bytes = read(join(directory, input.path)).bytes; need(equal(metadata(input.path, bytes), input), 'frozen_input_differs'); }
  const cases = deriveCases(read(join(directory, 'inputs/selection.json')).value, Object.fromEntries(CASES.map(([id]) => [id, read(join(directory, `inputs/${id}-request.json`)).value])));
  need(equal(plan.cases, cases), 'fixed_cases_differ');
  const frozen = read(join(directory, 'FROZEN.json')).value;
  need(equal(frozen, { planSha256: expectedPlanSha256, sourceManifestSha256: plan.sourceManifestSha256, publicDispatches: 0, frozenAt: plan.frozenAt }), 'freeze_record_differs');
  return { directory, plan, source };
}
export async function runRecheck({ outputDirectory, expectedPlanSha256 }) {
  const { directory, plan } = await checkRecheck({ outputDirectory, expectedPlanSha256 });
  need(realpathSync(fileURLToPath(import.meta.url)) === join(directory, 'runtime', SELF), 'run_requires_archived_entrypoint');
  await verifyNodeRuntime(plan.runtime);
  const [{ executeIsolatedEthereumCall }, { createAppServer }, { StandardRpcClient }, { loadStandardApi }] = await Promise.all([
    import('../../engines/local-evm/isolated-call.js'), import('../../src/server.js'), import('../../src/standard-rpc.js'), import('../../src/standard-loader.js'),
  ]);
  const api = await loadStandardApi(); need(equal(api?.implementation, plan.productImplementation), 'archived_api_identity_differs');
  for (const c of plan.cases) api.validateStandardSimulation(c.apiRequest);
  const writer = createArtifactWriter(directory), startedAt = new Date().toISOString(), started = performance.now();
  writer.write('STARTED.json', { planSha256: expectedPlanSha256, sourceManifestSha256: plan.sourceManifestSha256, startedAt, runtime: plan.runtime, cases: CASES.map(([id]) => id), pid: process.pid });
  const budget = createCohortWireBudget({ limits: { calls: plan.policy.calls, totalBytes: plan.policy.totalBytes, wallMs: plan.policy.wallMs } });
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), plan.policy.wallMs), active = new Set(), failures = [], rows = [];
  let fatal = null, sourceUnchanged = false, runtimeUnchanged = false;
  const remaining = () => Math.max(0, Math.floor(plan.policy.wallMs - (performance.now() - started)));
  const note = (phase, fields) => process.stdout.write(JSON.stringify({ phase, at: new Date().toISOString(), ...fields }) + '\n');
  const healthy = () => { need(!writer.failed && !budget.snapshot().saveFailure, 'wire_save_failed'); need(!fatal, fatal); };
  const canAttempt = () => { healthy(); const u = budget.snapshot(); return !controller.signal.aborted && remaining() > 1000 && u.calls < u.limits.calls && u.observedBytes < u.limits.totalBytes; };
  // Saved inputs are loaded in a later phase, so bind their bytes again before
  // every phase and at sealing, alongside the complete archived runtime.
  const sourceCheck = async () => { try { await checkRecheck({ outputDirectory: directory, expectedPlanSha256 }); } catch { fatal = 'source_or_input_drift'; throw Object.assign(new Error(fatal), { code: fatal }); } };
  function transport(c, profile) {
    const rpc = createCohortTransport({ budget, provider: 'drpc', profile, blockHash: c.header.hash,
      limits: { wallMs: Math.max(1, Math.min(plan.policy.phaseWallMs, remaining())) },
      save: wire => writer.write(`wire/${String(wire.globalId).padStart(6, '0')}.json`, { ...wire, caseId: c.id }) });
    active.add(rpc); return rpc;
  }
  async function local(c, saved = null) {
    await sourceCheck(); healthy(); let cursor = 0, unexpected = false;
    const rpc = saved ? { async call(method, params) { const row = saved.records[cursor++]; if (!row || !equal(row.request, { method, params })) { unexpected = true; throw new Error('saved_input_request_mismatch'); } return structuredClone(row.result); } } : transport(c, 'local');
    const attempt = await executeIsolatedEthereumCall({ request: c.localRequest, header: c.header, rpc, signal: controller.signal,
      limits: { wallMs: Math.max(1, Math.min(plan.policy.phaseWallMs, remaining())), drainMs: plan.policy.drainMs } });
    if (!saved) await rpc.drain(); healthy();
    need(attempt.broker?.pendingAtReturn === 0 && (!attempt.isolation?.childPid || attempt.isolation.processClosed), 'local_drain_incomplete');
    const playback = saved ? { source: saved.source, recordsAvailable: saved.records.length, recordsConsumed: cursor, unexpectedRequest: unexpected,
      exactSequence: !unexpected && cursor === saved.records.length, networkCalls: 0, expectedOutputsUsed: false } : null;
    const output = { dispatch: attempt.status === 'completed' && (!playback || playback.exactSequence) ? 'completed' : 'unavailable',
      implementation: plan.localImplementation, attempt, ...(saved ? { inputSource: 'saved_v2_proof_code_only_supplement', playback } :
        { inputSource: 'live_pinned_proof_code', transportWireIds: rpc.records().map(r => r.globalId), transportUsage: rpc.usage(), transportDenied: rpc.denied() }) };
    if (!saved) active.delete(rpc); note(saved ? 'saved_input_local_finished' : 'live_local_finished', { caseId: c.id, dispatch: output.dispatch, execution: attempt.output?.execution?.status ?? null }); return output;
  }
  async function product(c) {
    await sourceCheck(); healthy(); const wire = transport(c, 'product'), phase = new AbortController(), signal = AbortSignal.any([controller.signal, phase.signal]);
    const rpc = new StandardRpcClient({ url: wire.url, limits: { wallMs: Math.max(1, Math.min(plan.policy.phaseWallMs, remaining())) },
      fetchImpl: (url, options) => wire.fetch(url, { ...options, signal: AbortSignal.any([signal, options.signal]) }) });
    const output = await invokeProductHandler({ createAppServer, standardApi: api, rpc, apiRequest: c.apiRequest, signal: controller.signal,
      abortPending: () => phase.abort(), wallMs: Math.max(1, Math.min(plan.policy.phaseWallMs, remaining())), drainMs: plan.policy.drainMs });
    await wire.drain(); healthy(); need(output.drain?.complete === true, 'product_drain_incomplete');
    const result = { ...output, transportWireIds: wire.records().map(r => r.globalId), transportUsage: wire.usage(), transportDenied: wire.denied() };
    active.delete(wire); note('product_finished', { caseId: c.id, dispatch: result.dispatch, httpStatus: result.httpStatus, execution: result.report?.execution?.status ?? null }); return result;
  }
  const adjudicate = (c, local, product) => adjudicateCohortOutcome({ transactionHash: c.transactionHash, request: c.localRequest, header: c.header,
    expectedProductImplementation: plan.productImplementation, expectedLocalImplementation: plan.localImplementation, local, product });
  try {
    for (const c of plan.cases) {
      const row = { id: c.id, transactionHash: c.transactionHash, liveLocal: null, savedInputSupplement: null, product: null, outcome: null, supplementOutcome: null }; rows.push(row);
      let l = unattempted('Run budget or prior integrity failure prevented this phase'), s = null, p = unattempted('Run budget or prior integrity failure prevented this phase');
      if (!fatal) try {
        writer.write(`cases/${c.id}/request.json`, c);
        if (canAttempt()) { l = unavailable('Live local phase began but did not produce a retained terminal result'); l = await local(c); }
        writer.write(`cases/${c.id}/local.json`, l);
        if (c.savedInputSupplement) {
          s = unattempted('Run budget prevented the separately declared saved-input supplement');
          if (canAttempt()) { s = unavailable('Saved-input local phase began but did not produce a retained terminal result'); s = await local(c, read(join(directory, c.savedInputSupplement)).value); }
          writer.write(`cases/${c.id}/local-saved-inputs.json`, s);
        }
        if (canAttempt()) { p = unavailable('Product phase began but did not produce a retained terminal result'); p = await product(c); }
        writer.write(`cases/${c.id}/product.json`, p);
        const outcome = adjudicate(c, l, p); writer.write(`cases/${c.id}/outcome.json`, outcome); row.outcome = compactAdjudication(outcome);
        if (s) { const supplement = adjudicate(c, s, p); writer.write(`cases/${c.id}/supplement-outcome.json`, supplement); row.supplementOutcome = compactAdjudication(supplement); }
      } catch (error) { fatal = ['wire_save_failed', 'artifact_save_failed', 'source_or_input_drift', 'local_drain_incomplete', 'product_drain_incomplete'].includes(error.code) ? error.code : 'capture_interrupted'; failures.push({ caseId: c.id, code: fatal }); controller.abort(); }
      row.liveLocal = { dispatch: l.dispatch, execution: l.attempt?.output?.execution?.status ?? null };
      row.savedInputSupplement = s ? { dispatch: s.dispatch, execution: s.attempt?.output?.execution?.status ?? null } : null;
      row.product = { dispatch: p.dispatch, httpStatus: p.httpStatus ?? null, execution: p.report?.execution?.status ?? null };
      if (!row.outcome) row.outcome = { outcome: { transactionHash: c.transactionHash,
        execution: p.dispatch === 'budget_unattempted' ? 'budget_unattempted' : 'provider_unavailable',
        comparison: p.dispatch === 'budget_unattempted' ? 'budget_unattempted' : 'not_comparable' }, reason: 'Run integrity/budget prevented a safely completed case; no replacement' };
    }
  } finally {
    clearTimeout(timer); controller.abort(); for (const rpc of active) try { await rpc.drain(); } catch { failures.push({ code: 'wire_save_failed' }); }
  }
  const executionWindowMs = performance.now() - started;
  try { await sourceCheck(); sourceUnchanged = true; } catch { failures.push({ code: 'source_or_input_drift' }); }
  try { await verifyNodeRuntime(plan.runtime); runtimeUnchanged = true; } catch { failures.push({ code: 'runtime_drift' }); }
  if (writer.failed || budget.snapshot().saveFailure) failures.push({ code: 'artifact_save_failed' });
  const result = { schemaVersion: '1.0', status: failures.length ? 'interrupted' : 'complete', comparisonStatus: failures.length ? 'withheld_due_capture_integrity_failure_raw_case_adjudications_are_audit_only' : 'available', planSha256: expectedPlanSha256, sourceManifestSha256: plan.sourceManifestSha256,
    sourceUnchanged, frozenPlanAndInputsUnchanged: sourceUnchanged, runtimeUnchanged, rows, budget: budget.snapshot(), failures, startedAt, finishedAt: new Date().toISOString(), executionWindowMs, scope: plan.scope };
  writer.write('results.json', result); const sealed = sealEvidence(directory, expectedPlanSha256, plan.sourceManifestSha256);
  note('sealed', { status: result.status, ...sealed, calls: result.budget.calls, cases: rows.map(r => ({ id: r.id, live: r.outcome.outcome, savedInputSupplement: r.supplementOutcome?.outcome ?? null })) });
  return { ...result, evidence: sealed };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, outputDirectory, expected] = process.argv.slice(2);
  if (command === 'inspect') console.log(JSON.stringify(inspectFixedCases().map(c => ({ id: c.id, transactionHash: c.transactionHash, parentHash: c.header.hash, parentNumber: c.header.number,
    calldataBytes: (c.localRequest.data.length - 2) / 2, accessListEntries: c.localRequest.accessList?.length ?? 0, accessListStorageKeys: c.localRequest.accessList?.reduce((n, r) => n + r.storageKeys.length, 0) ?? 0,
    blobHashes: c.localRequest.blobVersionedHashes?.length ?? 0, savedInputSupplement: c.savedInputSupplement })), null, 2));
  else if (command === 'freeze') console.log(JSON.stringify(await freezeRecheck({ outputDirectory, expectedProductSha256: expected }), null, 2));
  else if (command === 'check') { const { plan, source } = await checkRecheck({ outputDirectory, expectedPlanSha256: expected }); console.log(JSON.stringify({ status: 'verified', cases: plan.cases.map(c => c.id), sourceFiles: source.manifest.filesCount, planSha256: expected }, null, 2)); }
  else if (command === 'run') { const { directory } = await checkRecheck({ outputDirectory, expectedPlanSha256: expected }); const archived = await import(pathToFileURL(join(directory, 'runtime', SELF))); await archived.runRecheck({ outputDirectory: directory, expectedPlanSha256: expected }); }
  else throw new Error('Usage: recheck-unresolved.mjs freeze DIRECTORY PRODUCT_SHA | check DIRECTORY PLAN_SHA | run DIRECTORY PLAN_SHA');
}
