// Offline only. Archived modules are imported only after their full source and
// Node identities verify. Optional replay consumes saved local inputs only.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { isDeepStrictEqual as equal } from 'node:util';
import { verifyFrozenSources, verifyNodeRuntime } from './freeze.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const need = (condition, message) => { if (!condition) throw Error(message); };
const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const PREFIX = 'research/delegated-sender-development-v1';
function inventory(root, sub = '') {
  const result = [];
  for (const entry of readdirSync(join(root, sub), { withFileTypes: true })) {
    if (!sub && ['runtime', 'evidence-manifest.json'].includes(entry.name)) continue;
    const path = sub ? sub + '/' + entry.name : entry.name; need(!entry.isSymbolicLink(), 'Evidence symlink');
    if (entry.isDirectory()) result.push(...inventory(root, path));
    else { need(entry.isFile(), 'Nonregular evidence'); const s = lstatSync(join(root, path)); need(s.size <= 256 * 1024 * 1024, 'Evidence file limit'); const bytes = readFileSync(join(root, path)); result.push({ path, bytes: bytes.length, sha256: sha(bytes) }); }
    need(result.length <= 3000, 'Evidence count limit');
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
export function validateReplayMetadata(attempt) {
  need(attempt && ['completed', 'unavailable'].includes(attempt.status), 'Invalid attempt status');
  const isolation = attempt.isolation;
  let bound = 145000 + 25000 + 1000;
  if (isolation) {
    const limits = isolation.limits;
    need(Number.isSafeInteger(isolation.wallMs) && isolation.wallMs > 0 && isolation.wallMs <= 145000 &&
      Number.isSafeInteger(isolation.drainMs) && isolation.drainMs > 0 && isolation.drainMs <= 25000 && limits &&
      limits.wallMs === isolation.wallMs && limits.drainMs === isolation.drainMs &&
      Number.isSafeInteger(limits.killWaitMs) && limits.killWaitMs > 0 && limits.killWaitMs <= 1000, 'Isolation time bounds differ');
    bound = isolation.wallMs + isolation.drainMs + limits.killWaitMs;
    need(finite(isolation.durationMs) && isolation.durationMs <= bound, 'Invalid isolation duration');
    need(isolation.childPid === null || (Number.isSafeInteger(isolation.childPid) && isolation.childPid > 0), 'Invalid child PID');
    if (attempt.status === 'completed') need(Number.isSafeInteger(isolation.childPid) && isolation.childPid > 0 && isolation.processClosed === true && isolation.exitCode === 0 && isolation.exitSignal === null, 'Completed child identity/closure differs');
  } else need(attempt.status === 'unavailable', 'Completed attempt lacks isolation');
  for (const records of [attempt.inputEvidence, attempt.broker?.records]) {
    if (records === null || records === undefined) continue;
    need(Array.isArray(records), 'Invalid timing record list');
    for (const record of records) if (Object.hasOwn(record, 'durationMs')) need(finite(record.durationMs) && record.durationMs <= bound, 'Invalid input/broker duration');
  }
}
export function validateTerminalTiming(results, policy) {
  const timing = results.terminalTiming, limitMs = policy.dispatchMs + policy.terminalDrainMs;
  need(timing && equal(Object.keys(timing).sort(), ['status', 'clockValid', 'limitMs', 'wallStartedAtMs', 'wallFinishedAtMs', 'wallElapsedMs', 'monotonicElapsedMs'].sort()) &&
    timing.status === 'within_budget' && timing.clockValid === true && timing.limitMs === limitMs && limitMs <= policy.liveCeilingMs &&
    Number.isSafeInteger(timing.wallStartedAtMs) && timing.wallStartedAtMs === Date.parse(results.startedAt) &&
    Number.isSafeInteger(timing.wallFinishedAtMs) && timing.wallFinishedAtMs >= timing.wallStartedAtMs && timing.wallFinishedAtMs <= Date.parse(results.finishedAt) &&
    finite(timing.wallElapsedMs) && timing.wallElapsedMs === timing.wallFinishedAtMs - timing.wallStartedAtMs && timing.wallElapsedMs <= limitMs &&
    finite(timing.monotonicElapsedMs) && timing.monotonicElapsedMs <= limitMs && timing.monotonicElapsedMs === results.executionWindowMs,
  'Terminal timing verdict/bound differs');
}
export function semanticAttempt(attempt) {
  // Compare complete engine outputs, immutable facts, usage, reads and changes.
  // Host PID/wall duration are not replay outputs; broker/input durations vary.
  validateReplayMetadata(attempt);
  const value = structuredClone(attempt);
  if (value.isolation) { delete value.isolation.childPid; delete value.isolation.durationMs; }
  for (const e of value.inputEvidence ?? []) delete e.durationMs;
  for (const e of value.broker?.records ?? []) delete e.durationMs;
  return value;
}
export function savedInputTransport(wires) {
  let cursor = 0, mismatch = null;
  return { rpc: { async call(method, params) {
    const wire = wires[cursor++];
    if (!wire || wire.profile !== 'local' || wire.request.method !== method || !equal(wire.request.params, params)) {
      mismatch ??= 'Saved local input request sequence differs'; throw Error(mismatch);
    }
    if (wire.status !== 'completed') throw Object.assign(new Error('Retained provider input failure'), { code: wire.error });
    return structuredClone(wire.parsed.result);
  } }, check() { need(mismatch === null && cursor === wires.length, mismatch ?? 'Saved local input reads were not fully consumed'); } };
}
export async function verifyEvidence({ outputDirectory, expectedManifestSha256, expectedPlanSha256, replay = false }) {
  need(hash(expectedManifestSha256) && hash(expectedPlanSha256) && typeof replay === 'boolean', 'External evidence and plan hashes required');
  const directory = realpathSync(resolve(outputDirectory)), manifestPath = join(directory, 'evidence-manifest.json');
  const stat = lstatSync(manifestPath); need(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 8 * 1024 * 1024, 'Invalid evidence manifest');
  const raw = readFileSync(manifestPath); need(sha(raw) === expectedManifestSha256, 'Evidence manifest differs');
  const manifest = JSON.parse(raw), files = inventory(directory);
  need(manifest.schemaVersion === '1.0' && manifest.planSha256 === expectedPlanSha256 && equal(files, manifest.files) && files.reduce((n, f) => n + f.bytes, 0) <= 2 * 1024 * 1024 * 1024, 'Evidence inventory differs');
  const byPath = new Map(files.map(f => [f.path, f]));
  const read = path => { const entry = byPath.get(path); need(entry, 'Missing artifact: ' + path); const bytes = readFileSync(join(directory, path)); need(bytes.length === entry.bytes && sha(bytes) === entry.sha256, 'Artifact changed: ' + path); return JSON.parse(bytes); };
  need(byPath.get('plan.json')?.sha256 === expectedPlanSha256 && byPath.get('source-manifest.json')?.sha256 === manifest.sourceManifestSha256, 'Plan/source binding differs');
  const source = await verifyFrozenSources({ outputDirectory: directory, expectedManifestSha256: manifest.sourceManifestSha256 }); await verifyNodeRuntime(source.manifest.runtime);
  const archived = async path => { need(source.manifest.files.some(f => f.path === path && f.kind === 'file'), 'Archived module absent'); return import(pathToFileURL(join(directory, 'runtime', path))); };
  const modules = Object.assign({}, ...await Promise.all([
    PREFIX + '/run.mjs', PREFIX + '/inputs.mjs', PREFIX + '/outcomes.mjs',
    'research/standard-evm/cohort-verify.mjs', 'engines/local-evm/ethereum-header.js', 'engines/local-evm/verified-state-proof.js',
    'engines/local-evm/authenticated-ancestry.js', 'engines/local-evm/input-facts.js',
  ].map(archived)));
  const { plan } = await modules.loadPlan({ outputDirectory: directory, expectedPlanSha256 });
  const started = read('STARTED.json'), results = read('results.json');
  need(equal(started, { schemaVersion: '1.0', planSha256: expectedPlanSha256, sourceManifestSha256: manifest.sourceManifestSha256, startedAt: started.startedAt, pid: started.pid, runtime: plan.runtime }) && Number.isSafeInteger(started.pid) && started.pid > 0 && timestamp(started.startedAt), 'Start identity differs');
  need(results.schemaVersion === '1.0' && results.planSha256 === expectedPlanSha256 && results.sourceManifestSha256 === manifest.sourceManifestSha256 && equal(results.scope, plan.scope), 'Result binding differs');
  need(results.startedAt === started.startedAt && timestamp(results.finishedAt) && timestamp(plan.frozenAt) && Date.parse(plan.frozenAt) <= Date.parse(started.startedAt) && Date.parse(started.startedAt) <= Date.parse(results.finishedAt) && finite(results.durationMs) && finite(results.executionWindowMs) && results.durationMs >= results.executionWindowMs, 'Chronology differs');
  validateTerminalTiming(results, plan.policy);
  // Incomplete persistence/source failures remain retained artifacts, but this
  // complete-audit path must not turn them into an attested comparison.
  need(results.status === 'complete' && results.comparisonsUsable === true && results.sourceUnchanged === true && results.runtimeUnchanged === true && equal(results.failures, []) && results.caseRun?.status === 'complete' && results.caseRun.fatal === null && results.caseRun.rows.length === 2, 'Interrupted packet lacks complete audited comparisons');
  const wirePaths = files.filter(f => f.path.startsWith('wire/')).map(f => f.path).sort(); need(wirePaths.every(p => /^wire\/\d{6}\.json$/.test(p)), 'Unexpected wire path');
  const wires = wirePaths.map(read), summaries = wires.map(modules.verifyCohortWireRecord), claimed = new Set();
  need(wires.every((w, i) => w.globalId === i + 1 && wirePaths[i] === `wire/${String(w.globalId).padStart(6, '0')}.json` && w.profile === 'local' && w.provider === 'drpc'), 'Fresh wire order/provider differs');
  let bytes = 0; for (const w of wires) { need(bytes < plan.policy.totalResponseBytes, 'Dispatch after global byte exhaustion'); bytes += w.transport.observedBytes; }
  need(wires.length <= plan.policy.totalCalls && equal(results.budget.limits, { calls: plan.policy.totalCalls, totalBytes: plan.policy.totalResponseBytes, wallMs: plan.policy.dispatchMs }) && results.budget.calls === wires.length && results.budget.dispatches === wires.filter(w => w.dispatched).length && results.budget.observedBytes === bytes && results.budget.saveFailure === false, 'Global budget differs');
  let proofsVerified = 0, replayed = 0, priorWire = 0; const outcomes = [];
  for (const [index, item] of plan.cases.entries()) {
    need(equal(read(`cases/${item.id}/request.json`), item), 'Case envelope/header differs');
    const localPath = `cases/${item.id}/local.json`, local = read(localPath), seal = read(`cases/${item.id}/LOCAL_SEALED.json`), used = read(`cases/${item.id}/RECORDED_ORACLE_USED.json`);
    const record = results.caseRun.rows[index]; need(record.id === item.id && record.transactionHash === item.transactionHash && record.status === 'retained' && record.localArtifact === localPath && record.outcomeArtifact === `cases/${item.id}/outcome.json`, 'Fixed case ledger differs');
    need(equal(local.implementation, plan.localImplementation) && Array.isArray(local.transportWireIds), 'Local implementation/phase inventory differs');
    const phase = local.transportWireIds.map(id => { const w = wires[id - 1]; need(w && !claimed.has(id) && id > priorWire, 'Duplicate or unordered phase wire'); claimed.add(id); priorWire = id; return w; });
    const meta = byPath.get(localPath); need(equal(seal, { schemaVersion: '1.0', path: localPath, bytes: meta.bytes, sha256: meta.sha256, wireIds: local.transportWireIds, lastWireId: local.transportWireIds.at(-1) ?? null, at: seal.at }) && timestamp(seal.at), 'Durable local seal differs');
    need(timestamp(used.at) && used.previouslyKnown === true && used.freshCalls === 0 && used.originalManifestSha256 === modules.ORIGINAL_MANIFEST_SHA && used.originalArtifact === `cases/${item.id}/oracle.json` && Date.parse(used.at) >= Date.parse(seal.at), 'Recorded oracle was not read after durable local seal');
    need(phase.length === 0 || Date.parse(seal.at) >= Date.parse(phase.at(-1).startedAt), 'Local seal predates input dispatch');
    if (local.transportUsage) {
      const u = local.transportUsage; need(equal(u.limits, { calls: 256, totalBytes: 32 * 1024 * 1024, requestMs: 25000, responseBytes: 8 * 1024 * 1024, wallMs: 145000 }) && u.attempts === phase.length && u.dispatches === phase.filter(w => w.dispatched).length && u.observedBytes === phase.reduce((n, w) => n + w.transport.observedBytes, 0) && phase.length <= 256, 'Phase transport budget differs');
      let before = 0; for (const w of phase) { need(before < u.limits.totalBytes, 'Dispatch after phase byte exhaustion'); before += w.transport.observedBytes; }
    } else need(phase.length === 0 && local.dispatch === 'budget_unattempted', 'Attempted phase lacks usage');
    for (const w of phase) need(w.request.method === 'eth_getBlockByHash' || (['eth_getProof', 'eth_getCode'].includes(w.request.method) && equal(w.request.params.at(-1), { blockHash: item.header.hash, requireCanonical: true })), 'Local wire escaped pinned input profile');
    if (local.attempt) validateReplayMetadata(local.attempt);
    proofsVerified += (await modules.verifyLocalBindings(local, phase, item.header, modules)).proofsVerified;
    if (local.attempt?.inputs) await modules.validateInputFacts({ inputs: local.attempt.inputs, inputEvidence: local.attempt.inputEvidence, stateRoot: item.header.stateRoot });
    if (local.attempt?.isolation) need(local.attempt.isolation.processClosed === true && local.attempt.broker.pendingAtReturn === 0, 'Local process not drained');
    if (replay && local.attempt?.status === 'completed') {
      // Execute before opening parsed provider trace/diff. The only RPC adapter
      // available here consumes saved local proof/code/header replies in order.
      const playback = savedInputTransport(phase), executor = await archived('engines/local-evm/isolated-call.js');
      const repeated = await executor.executeIsolatedEthereumCall({ request: item.request, header: item.header, rpc: playback.rpc, limits: local.attempt.isolation.limits }); playback.check();
      need(equal(semanticAttempt(repeated), semanticAttempt(local.attempt)), 'Archived local execution did not reproduce exact non-timing output/facts/usage/reads/changes'); replayed++;
    }
    const oracle = modules.readRecordedOracle({ outputDirectory: directory, item }); need(equal(used.wireIds, oracle.transportWireIds), 'Used oracle wire list differs');
    const outcome = await modules.adjudicateLocalOutcome({ transactionHash: item.transactionHash, request: item.request, header: item.header, expectedLocalImplementation: plan.localImplementation, local, oracle });
    need(equal(outcome, read(record.outcomeArtifact)) && equal(record.outcome, outcome.outcome) && record.allChannelsComplete === outcome.allChannelsComplete, 'Outcome does not reproduce'); outcomes.push({ id: item.id, ...outcome.outcome });
  }
  need(claimed.size === wires.length, 'Unjoined fresh wire remains');
  await modules.loadPlan({ outputDirectory: directory, expectedPlanSha256 }); await verifyNodeRuntime(plan.runtime);
  need(equal(inventory(directory), files) && sha(readFileSync(manifestPath)) === expectedManifestSha256, 'Evidence changed during audit');
  return { status: 'verified', expectedManifestSha256, expectedPlanSha256, sourceManifestSha256: manifest.sourceManifestSha256, sourceFiles: source.manifest.filesCount,
    evidenceFiles: files.length, freshInputWires: wires.length, recordedOracleWires: 8, proofsVerified, replayed, outcomes, scope: plan.scope,
    limitations: { newPublicCalls: 0, newIndependentOpcodeImplementation: false, replayHostPidAndTimingExcluded: true, unretainedObservedHashesVerified: summaries.every(s => s.unretainedObservedHashVerified), originalDenominatorModified: false } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, manifest, plan, flag] = process.argv.slice(2); need(directory && manifest && plan && (flag === undefined || flag === '--replay'), 'Use verify.mjs DIR MANIFEST_SHA PLAN_SHA [--replay]');
  console.log(JSON.stringify(await verifyEvidence({ outputDirectory: directory, expectedManifestSha256: manifest, expectedPlanSha256: plan, replay: flag === '--replay' }), null, 2));
}
