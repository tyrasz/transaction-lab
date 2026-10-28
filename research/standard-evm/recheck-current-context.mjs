// Two known Ethereum envelopes at freshly selected state. This is development
// evidence, not historical replay or a replacement for any sealed cohort row.
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
import { verifyEthereumHeader } from '../../engines/local-evm/ethereum-header.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SELF = 'research/standard-evm/recheck-current-context.mjs';
const V2 = 'reports/ordinary-ethereum-cohort-v2';
const V2_MANIFEST_SHA = '583dfee6412385547791da6069ed6e33322928e0b0231e645c4e956711d1bc2a';
const V2_PLAN_SHA = 'f50095fc407c4966251413f765b9998818e928bc900f6be30c8b881ec0b622e6';
const CASES = [
  ['002', '0x2e3906379c97fc20f4453813a9ed0b602ed5c126286bff0bd371adfecc5a6912'],
  ['007', '0x76cda4947526f97179b0bb325183c5e70c8ae7ec066c61294623e521722d2f04'],
];
export const CURRENT_CONTEXT_POLICY = Object.freeze({ chainId: 1, provider: 'drpc', calls: 646, totalBytes: 132 * 1024 * 1024,
  wallMs: 12 * 60 * 1000, requestMs: 25000, responseBytes: 8 * 1024 * 1024, phaseBytes: 32 * 1024 * 1024,
  selectionCalls: 2, selectionBytes: 2 * 1024 * 1024, selectionWallMs: 50000,
  localCalls: 256, productCalls: 65, phaseWallMs: 145000, drainMs: 25000, gas: '5000000',
  selection: 'one_eth_chainId_and_one_latest_header_per_case_before_local_execution',
  retries: 0, replacements: 0, providerFallback: false, stateSubstitution: false, savedInputSupplements: false });
const SCOPE = Object.freeze({ purpose: 'development_of_two_known_envelopes_at_newly_selected_state', prospectiveHoldout: false,
  originalCohortResultsUnchanged: true, originalTransactionPosition: false, originalParentState: false, outerTransactionValidation: false,
  execution: 'unsigned_unpriced_at_one_predeclared_latest_selection_per_case', feesSettled: false,
  headerHashRecomputed: true, consensusVerified: false, finalityVerified: false, localBeforeProduct: true,
  selectedHeaderComparedInFullToProduct: true, selectionFailure: 'retained_without_retry_or_replacement',
  blobFeeContext: 'explicit_synthetic_zero_blob_fee_cap_and_block_blob_base_fee',
  productInvocation: 'actual_archived_handler_in_process_no_listening_socket',
  timing: '12min_execution_plus_up_to25s_terminal_drain_offline_integrity_and_sealing_excluded_not_hard_realtime_through_host_suspend',
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
    const apiRequest = { chainId: 1, from: envelope.from, to: envelope.to, data: envelope.input, value: envelope.value, block: 'latest', ...context };
    return { id, transactionHash: hash, originalParentHeader: header, apiRequest,
      localRequest: { from: apiRequest.from, to: apiRequest.to, data: apiRequest.data, value: apiRequest.value, gas: CURRENT_CONTEXT_POLICY.gas, ...context },
      original: { blockHash: envelope.blockHash, blockNumber: envelope.blockNumber, transactionIndex: envelope.transactionIndex, gas: envelope.gas,
        transactionType: envelope.type, nonce: envelope.nonce, ...(envelope.maxFeePerBlobGas ? { maxFeePerBlobGas: envelope.maxFeePerBlobGas } : {}) } };
  });
}
export function bindCurrentSelection(planned, selection) {
  need(selection?.status === 'selected' && selection.chainId === '0x1' && selection.selector === 'latest', 'selection_not_verified');
  const headerVerification = verifyEthereumHeader({ header: selection.header, expectedHash: selection.header?.hash });
  need(equal(selection.headerVerification, headerVerification), 'selected_header_verification_differs');
  need(planned.apiRequest.block === 'latest' && !Object.hasOwn(planned, 'header'), 'planned_state_not_latest');
  return { ...structuredClone(planned), header: structuredClone(selection.header), headerVerification,
    apiRequest: { ...structuredClone(planned.apiRequest), block: selection.header.hash },
    stateSource: 'once_selected_latest_header_after_source_freeze_original_state_not_reused' };
}
export function verifySelectedProductHeader(c, product) {
  const records = product.report?.evidence?.filter(e => ['eth_getBlockByHash', 'eth_getBlockByNumber'].includes(e.method) && Object.hasOwn(e, 'result')) ?? [];
  if (!records.length) return { status: 'unavailable', observedHeaders: 0, reason: 'Product did not retain a complete header observation' };
  const matched = records.every(e => equal(e.result, c.header));
  return { status: matched ? 'verified' : 'mismatch', observedHeaders: records.length,
    basis: 'exact_complete_header_equality_with_once_selected_header', consensusVerified: false, finalityVerified: false };
}
export function inspectCurrentCases({ repoRoot = ROOT } = {}) {
  const old = originalReader(repoRoot), selection = old('selection.json'), oldPlan = old('plan.json');
  need(sha(oldPlan.bytes) === V2_PLAN_SHA, 'original_plan_differs');
  const requests = Object.fromEntries(CASES.map(([id]) => [id, old(`cases/${id}/request.json`)]));
  return deriveCases(selection.value, Object.fromEntries(Object.entries(requests).map(([k, v]) => [k, v.value])));
}
export async function freezeCurrentContext({ repoRoot = ROOT, outputDirectory, expectedProductSha256 }) {
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
  }
  const plan = { schemaVersion: '1.0', title: 'Two known Ethereum contexts: newly selected state development check', frozenAt: new Date().toISOString(),
    policy: CURRENT_CONTEXT_POLICY, scope: SCOPE, provider: COHORT_PROVIDERS.drpc, originalManifestSha256: V2_MANIFEST_SHA, originalPlanSha256: V2_PLAN_SHA,
    sourceManifestSha256: frozen.manifestSha256, productImplementation: frozen.manifest.productImplementation, localImplementation: frozen.manifest.localImplementation,
    runtime: frozen.manifest.runtime, inputs, cases };
  writer.write('plan.json', plan); const planSha256 = sha(readFileSync(join(frozen.outputDirectory, 'plan.json')));
  writer.write('FROZEN.json', { planSha256, sourceManifestSha256: frozen.manifestSha256, publicDispatches: 0, frozenAt: plan.frozenAt });
  await checkCurrentContext({ outputDirectory: frozen.outputDirectory, expectedPlanSha256: planSha256 });
  return { outputDirectory: frozen.outputDirectory, planSha256, sourceManifestSha256: frozen.manifestSha256, sourceFiles: frozen.manifest.filesCount, cases: cases.map(c => c.id), publicDispatches: 0 };
}
export async function checkCurrentContext({ outputDirectory, expectedPlanSha256 }) {
  need(/^[a-f0-9]{64}$/.test(expectedPlanSha256), 'explicit_plan_hash_required');
  const directory = realpathSync(resolve(outputDirectory)), saved = read(join(directory, 'plan.json')), plan = saved.value;
  need(sha(saved.bytes) === expectedPlanSha256 && plan.schemaVersion === '1.0' && equal(plan.policy, CURRENT_CONTEXT_POLICY) && equal(plan.scope, SCOPE) &&
    plan.provider === COHORT_PROVIDERS.drpc && plan.originalManifestSha256 === V2_MANIFEST_SHA && plan.originalPlanSha256 === V2_PLAN_SHA, 'frozen_plan_differs');
  const source = await verifyFrozenSources({ outputDirectory: directory, expectedManifestSha256: plan.sourceManifestSha256 });
  need(source.manifest.files.some(f => f.path === SELF) && equal(plan.productImplementation, source.manifest.productImplementation) &&
    equal(plan.localImplementation, source.manifest.localImplementation) && equal(plan.runtime, source.manifest.runtime) && plan.productImplementation.version === '0.15.0', 'source_identity_differs');
  const requiredInputs = ['inputs/provenance.json', 'inputs/selection.json', ...CASES.map(([id]) => `inputs/${id}-request.json`)].sort();
  need(Array.isArray(plan.inputs) && equal(plan.inputs.map(i => i.path).sort(), requiredInputs), 'input_inventory_differs');
  for (const input of plan.inputs) { need(/^inputs\/[a-zA-Z0-9-]+\.json$/.test(input.path), 'input_path_invalid'); const bytes = read(join(directory, input.path)).bytes; need(equal(metadata(input.path, bytes), input), 'frozen_input_differs'); }
  const cases = deriveCases(read(join(directory, 'inputs/selection.json')).value, Object.fromEntries(CASES.map(([id]) => [id, read(join(directory, `inputs/${id}-request.json`)).value])));
  need(equal(plan.cases, cases), 'fixed_cases_differ');
  const frozen = read(join(directory, 'FROZEN.json')).value;
  need(equal(frozen, { planSha256: expectedPlanSha256, sourceManifestSha256: plan.sourceManifestSha256, publicDispatches: 0, frozenAt: plan.frozenAt }), 'freeze_record_differs');
  return { directory, plan, source };
}
export async function runCurrentContext({ outputDirectory, expectedPlanSha256 }) {
  const { directory, plan } = await checkCurrentContext({ outputDirectory, expectedPlanSha256 });
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
  // Verify the archived source, plan and input bytes before every phase.
  const sourceCheck = async () => { try { await checkCurrentContext({ outputDirectory: directory, expectedPlanSha256 }); } catch { fatal = 'source_or_input_drift'; throw Object.assign(new Error(fatal), { code: fatal }); } };
  function transport(c, profile) {
    const rpc = createCohortTransport({ budget, provider: 'drpc', profile, blockHash: c.header.hash,
      limits: { calls: profile === 'local' ? plan.policy.localCalls : plan.policy.productCalls, totalBytes: plan.policy.phaseBytes, responseBytes: plan.policy.responseBytes, requestMs: plan.policy.requestMs, wallMs: Math.max(1, Math.min(plan.policy.phaseWallMs, remaining())) },
      save: wire => writer.write(`wire/${String(wire.globalId).padStart(6, '0')}.json`, { ...wire, caseId: c.id }) });
    active.add(rpc); return rpc;
  }
  async function select(c) {
    await sourceCheck(); healthy();
    const rpc = createCohortTransport({ budget, provider: 'drpc', profile: 'census',
      limits: { calls: plan.policy.selectionCalls, totalBytes: plan.policy.selectionBytes, requestMs: plan.policy.requestMs,
        responseBytes: plan.policy.responseBytes, wallMs: Math.max(1, Math.min(plan.policy.selectionWallMs, remaining())) },
      save: wire => writer.write(`wire/${String(wire.globalId).padStart(6, '0')}.json`, { ...wire, caseId: c.id, phase: 'selection' }) });
    active.add(rpc); let chainId = null, header = null, verification = null, error = null;
    try {
      chainId = await rpc.call('eth_chainId', [], { signal: controller.signal });
      need(chainId === '0x1', 'selected_chain_differs');
      header = await rpc.call('eth_getBlockByNumber', ['latest', false], { signal: controller.signal });
      need(typeof header?.hash === 'string' && /^0x[0-9a-f]{64}$/.test(header.hash), 'selected_header_missing');
      verification = verifyEthereumHeader({ header, expectedHash: header.hash });
    } catch (e) { error = ['wire_save_failed', 'artifact_save_failed'].includes(e.code) ? e.code : 'selection_unavailable'; }
    await rpc.drain(); healthy();
    const result = { status: error ? 'unavailable' : 'selected', selector: 'latest', chainId, header, headerVerification: verification,
      ...(error ? { error } : {}), transportWireIds: rpc.records().map(r => r.globalId), transportUsage: rpc.usage(), transportDenied: rpc.denied() };
    active.delete(rpc); note('selection_finished', { caseId: c.id, status: result.status, blockHash: header?.hash ?? null }); return result;
  }
  async function local(c) {
    await sourceCheck(); healthy(); const rpc = transport(c, 'local');
    const attempt = await executeIsolatedEthereumCall({ request: c.localRequest, header: c.header, rpc, signal: controller.signal,
      limits: { wallMs: Math.max(1, Math.min(plan.policy.phaseWallMs, remaining())), drainMs: plan.policy.drainMs } });
    await rpc.drain(); healthy();
    need(attempt.broker?.pendingAtReturn === 0 && (!attempt.isolation?.childPid || attempt.isolation.processClosed), 'local_drain_incomplete');
    const output = { dispatch: attempt.status === 'completed' ? 'completed' : 'unavailable', implementation: plan.localImplementation, attempt,
      inputSource: 'live_pinned_proof_code_at_selected_header', transportWireIds: rpc.records().map(r => r.globalId), transportUsage: rpc.usage(), transportDenied: rpc.denied() };
    active.delete(rpc); note('local_finished', { caseId: c.id, dispatch: output.dispatch, execution: attempt.output?.execution?.status ?? null }); return output;
  }
  async function product(c) {
    await sourceCheck(); healthy(); const wire = transport(c, 'product'), phase = new AbortController(), signal = AbortSignal.any([controller.signal, phase.signal]);
    const rpc = new StandardRpcClient({ url: wire.url, limits: { calls: plan.policy.productCalls, totalBytes: plan.policy.phaseBytes, responseBytes: plan.policy.responseBytes, requestMs: plan.policy.requestMs, wallMs: Math.max(1, Math.min(plan.policy.phaseWallMs, remaining())) },
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
    for (const planned of plan.cases) {
      const row = { id: planned.id, transactionHash: planned.transactionHash, selection: null, local: null, product: null, outcome: null }; rows.push(row);
      let selection = { status: 'budget_unattempted', reason: 'Run budget or prior integrity failure prevented selection' }, c = null;
      let l = unattempted('Selection or run budget prevented local execution'), p = unattempted('Selection or run budget prevented product execution');
      if (!fatal) try {
        writer.write(`cases/${planned.id}/planned-input.json`, planned);
        if (canAttempt()) selection = await select(planned);
        writer.write(`cases/${planned.id}/selection.json`, selection);
        if (selection.status === 'selected') {
          c = bindCurrentSelection(planned, selection);
          writer.write(`cases/${c.id}/request.json`, c);
          if (canAttempt()) { l = unavailable('Local phase began but did not produce a retained terminal result'); l = await local(c); }
          writer.write(`cases/${c.id}/local.json`, l);
          if (canAttempt()) { p = unavailable('Product phase began but did not produce a retained terminal result'); p = await product(c); }
          writer.write(`cases/${c.id}/product.json`, p);
          const headerBinding = verifySelectedProductHeader(c, p);
          writer.write(`cases/${c.id}/header-binding.json`, headerBinding);
          // An inconsistent full header must never be promoted to comparator evidence.
          const admitted = headerBinding.status !== 'verified' ? unavailable('Product header did not match the once-selected complete header') : p;
          const outcome = adjudicate(c, l, admitted); writer.write(`cases/${c.id}/outcome.json`, outcome); row.outcome = compactAdjudication(outcome);
        } else {
          writer.write(`cases/${planned.id}/local.json`, l); writer.write(`cases/${planned.id}/product.json`, p);
        }
      } catch (error) { fatal = ['wire_save_failed', 'artifact_save_failed', 'source_or_input_drift', 'local_drain_incomplete', 'product_drain_incomplete'].includes(error.code) ? error.code : 'capture_interrupted'; failures.push({ caseId: planned.id, code: fatal }); controller.abort(); }
      row.selection = { status: selection.status, blockHash: c?.header.hash ?? null, blockNumber: c?.header.number ?? null };
      row.local = { dispatch: l.dispatch, execution: l.attempt?.output?.execution?.status ?? null };
      row.product = { dispatch: p.dispatch, httpStatus: p.httpStatus ?? null, execution: p.report?.execution?.status ?? null };
      if (!row.outcome) row.outcome = { outcome: { transactionHash: planned.transactionHash,
        execution: selection.status === 'unavailable' || p.dispatch === 'unavailable' ? 'provider_unavailable' : 'budget_unattempted',
        comparison: selection.status === 'unavailable' || p.dispatch === 'unavailable' ? 'not_comparable' : 'budget_unattempted' },
        reason: 'Selection/integrity/budget prevented a safely completed case; no replacement' };
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
  note('sealed', { status: result.status, ...sealed, calls: result.budget.calls, cases: rows.map(r => ({ id: r.id, outcome: r.outcome.outcome })) });
  return { ...result, evidence: sealed };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, outputDirectory, expected] = process.argv.slice(2);
  if (command === 'inspect') console.log(JSON.stringify(inspectCurrentCases(), null, 2));
  else if (command === 'freeze') console.log(JSON.stringify(await freezeCurrentContext({ outputDirectory, expectedProductSha256: expected }), null, 2));
  else if (command === 'check') { const { plan, source } = await checkCurrentContext({ outputDirectory, expectedPlanSha256: expected }); console.log(JSON.stringify({ status: 'verified', cases: plan.cases.map(c => c.id), sourceFiles: source.manifest.filesCount, planSha256: expected }, null, 2)); }
  else if (command === 'run') { const { directory } = await checkCurrentContext({ outputDirectory, expectedPlanSha256: expected }); const archived = await import(pathToFileURL(join(directory, 'runtime', SELF))); await archived.runCurrentContext({ outputDirectory: directory, expectedPlanSha256: expected }); }
  else throw new Error('Usage: recheck-current-context.mjs inspect | freeze DIRECTORY PRODUCT_SHA | check DIRECTORY PLAN_SHA | run DIRECTORY PLAN_SHA');
}
