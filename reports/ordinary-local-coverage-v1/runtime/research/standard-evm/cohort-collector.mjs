// Prospective selection orchestration only. Inject createCohortTransport census
// scopes sharing the runner's global budget. This module never creates a fetch,
// substitutes a block/provider, retries a read, or dispatches simulations.
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { verifyEthereumHeader } from '../../engines/local-evm/ethereum-header.js';
import { validateCohortCensus, CENSUS_LIMITS } from './cohort-census.mjs';

export const COLLECTOR_LIMITS = Object.freeze({ waitMs: 20 * 60 * 1000, waitChunkMs: 60 * 1000, headersPerProvider: 256, calls: 514, resultBytes: 8 * 1024 * 1024, parsedResultBytes: 64 * 1024 * 1024 });
const PROVIDERS = ['drpc', 'publicnode'], HASH = /^0x[0-9a-fA-F]{64}$/;
const fault = code => { throw Object.assign(new Error(code), { code }); };
const requireTrue = (condition, code) => { if (!condition) fault(code); };
const has = (o, k) => Object.hasOwn(o, k);
const freeze = value => { if (value && typeof value === 'object') { for (const v of Object.values(value)) freeze(v); Object.freeze(value); } return value; };
function fields(value, required, optional = []) {
  requireTrue(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype, 'collector_invalid_options');
  const own = Reflect.ownKeys(value);
  requireTrue(required.every(k => own.includes(k)), 'collector_invalid_options');
  for (const k of own) {
    const d = Object.getOwnPropertyDescriptor(value, k);
    requireTrue(typeof k === 'string' && [...required, ...optional].includes(k) && d.enumerable && has(d, 'value'), 'collector_invalid_options');
  }
}
function jsonCopy(value) {
  const active = new Set(); let nodes = 0;
  function copy(v, depth) {
    requireTrue(++nodes <= CENSUS_LIMITS.dataNodes && depth <= CENSUS_LIMITS.depth, 'collector_result_shape');
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'string') { requireTrue(Buffer.byteLength(v) <= CENSUS_LIMITS.fieldBytes, 'collector_result_shape'); return v; }
    if (typeof v === 'number') { requireTrue(Number.isSafeInteger(v), 'collector_result_shape'); return v; }
    requireTrue(v && typeof v === 'object' && (Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype) && !active.has(v), 'collector_result_shape');
    active.add(v); const keys = Reflect.ownKeys(v), array = Array.isArray(v), result = array ? [] : {};
    if (array) requireTrue(keys.length === v.length + 1, 'collector_result_shape');
    for (const k of keys) {
      if (array && k === 'length') continue;
      const d = Object.getOwnPropertyDescriptor(v, k);
      requireTrue(typeof k === 'string' && !['__proto__', 'constructor', 'prototype'].includes(k) && d.enumerable && has(d, 'value'), 'collector_result_shape');
      if (array) requireTrue(/^(0|[1-9][0-9]*)$/.test(k) && Number(k) < v.length, 'collector_result_shape');
      result[k] = copy(d.value, depth + 1);
    }
    active.delete(v); return result;
  }
  const result = copy(value, 0);
  requireTrue(Buffer.byteLength(JSON.stringify(result)) <= COLLECTOR_LIMITS.resultBytes, 'collector_result_bytes');
  return result;
}
function verifyHeader(header, expectedHash, expectedNumber, hashList) {
  let proof;
  try { proof = verifyEthereumHeader({ header, expectedHash }); } catch { fault('collector_header_invalid'); }
  if (expectedNumber !== undefined) requireTrue(proof.number === expectedNumber.toString(), 'collector_header_number');
  if (hashList) requireTrue(Array.isArray(header.transactions) && header.transactions.length <= CENSUS_LIMITS.censusTransactions && header.transactions.every(v => typeof v === 'string' && HASH.test(v)) && new Set(header.transactions.map(v => v.toLowerCase())).size === header.transactions.length, 'collector_hash_list_invalid');
  return proof;
}
function safeCause(error) {
  const d = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code') : null;
  return d && has(d, 'value') && typeof d.value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(d.value) ? d.value : 'unknown_error';
}
async function defaultWaitUntil(deadlineMs, { signal }) {
  while (Date.now() < deadlineMs) await delay(Math.min(COLLECTOR_LIMITS.waitChunkMs, Math.max(1, deadlineMs - Date.now())), undefined, { signal });
}
async function cancellableWait(waitUntil, deadlineMs, signal) {
  if (!signal) return waitUntil(deadlineMs, { signal });
  if (signal.aborted) fault('collector_cancelled');
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(Object.assign(new Error('collector_cancelled'), { code: 'collector_cancelled' }));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(() => { if (signal.aborted) fault('collector_cancelled'); return waitUntil(deadlineMs, { signal }); }), aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

/**
 * API: {transports:{drpc,publicnode},seed,sampleSize:16,save,now?,waitUntil?,signal?}.
 * Transports are injected .call(method,params,{signal}) census scopes. save(event)
 * must return undefined synchronously; any failure latches before another read.
 * waitUntil(chunkDeadlineMs,{signal}) is injectable for offline controls; both
 * the chunk and final time are rechecked. Caller clocks are not authenticated.
 * Returned attempts contain parsed results, NOT exact HTTP/RPC wire bytes;
 * createCohortTransport owns those and enforces the global run deadline/budget.
 */
export async function collectProspectiveCensus(options) {
  const artifacts = { schemaVersion: '1.0', parsedResultsOnly: true, anchorDeclaration: null, finalizedObservations: [], observations: [], attempts: [], stages: [], failure: null, saveStatus: 'not_started', parsedResultBytes: 0, limits: { ...COLLECTOR_LIMITS } };
  let save, now, signal, waitUntil, transports, seed, lastTime = null, saveFailed = false, activeStage = 'options', census = null;
  const transportCalls = {};
  function clock() {
    let value; try { value = now(); } catch { fault('collector_clock_invalid'); }
    requireTrue(Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000 && (lastTime === null || value >= lastTime), 'collector_clock_invalid');
    lastTime = value; return value;
  }
  function cancelled() { if (signal?.aborted) fault('collector_cancelled'); }
  function stage(kind, details, at = clock()) {
    activeStage = kind;
    const event = { index: artifacts.stages.length, kind, at: new Date(at).toISOString(), details };
    artifacts.stages.push(event);
    if (saveFailed) fault('collector_save_failed');
    try {
      const returned = save(freeze(structuredClone(event)));
      if (returned !== undefined) { if (typeof returned?.catch === 'function') returned.catch(() => {}); fault('collector_synchronous_save_required'); }
      artifacts.saveStatus = 'saved';
    } catch { saveFailed = true; artifacts.saveStatus = 'failed'; fault('collector_save_failed'); }
  }
  async function call(provider, method, params, purpose) {
    cancelled(); requireTrue(!saveFailed && artifacts.attempts.length < COLLECTOR_LIMITS.calls, 'collector_attempt_budget');
    const attempt = { index: artifacts.attempts.length, provider, method, params: structuredClone(params), purpose, startedAt: new Date(clock()).toISOString(), status: 'planned', transportInvoked: false };
    artifacts.attempts.push(attempt); stage('call_planned', { ...attempt });
    try {
      cancelled();
      attempt.status = 'pending'; attempt.transportInvoked = true;
      const result = jsonCopy(await transportCalls[provider](method, structuredClone(params), { signal }));
      const size = Buffer.byteLength(JSON.stringify(result));
      requireTrue(artifacts.parsedResultBytes + size <= COLLECTOR_LIMITS.parsedResultBytes, 'collector_parsed_result_budget');
      artifacts.parsedResultBytes += size;
      Object.assign(attempt, { status: 'completed', result, parsedResultBytes: size, completedAt: null });
      attempt.completedAt = new Date(clock()).toISOString();
      stage('call_completed', structuredClone(attempt)); cancelled(); return result;
    } catch (error) {
      if (attempt.status === 'pending') {
        Object.assign(attempt, { status: 'failed', error: safeCause(error), completedAt: lastTime === null ? null : new Date(lastTime).toISOString() });
        if (!saveFailed) stage('call_failed', structuredClone(attempt));
      }
      throw error;
    }
  }
  try {
    fields(options, ['transports', 'seed', 'sampleSize', 'save'], ['now', 'waitUntil', 'signal']);
    ({ transports, seed, save } = options); now = options.now ?? Date.now; waitUntil = options.waitUntil ?? defaultWaitUntil; signal = options.signal;
    fields(transports, PROVIDERS);
    requireTrue(typeof seed === 'string' && HASH.test(seed) && options.sampleSize === 16 && typeof save === 'function' && typeof now === 'function' && typeof waitUntil === 'function', 'collector_invalid_options');
    requireTrue(transports.drpc !== transports.publicnode, 'collector_invalid_transports');
    for (const provider of PROVIDERS) {
      const transport = transports[provider], descriptor = transport && Object.getOwnPropertyDescriptor(transport, 'call');
      requireTrue(descriptor && has(descriptor, 'value') && typeof descriptor.value === 'function', 'collector_invalid_transports');
      transportCalls[provider] = descriptor.value.bind(transport);
      for (const [key, expected] of [['provider', provider], ['profile', 'census']]) if (has(transport, key)) {
        const d = Object.getOwnPropertyDescriptor(transport, key); requireTrue(d && has(d, 'value') && d.value === expected, 'collector_invalid_transports');
      }
    }
    if (signal !== undefined) requireTrue(signal instanceof AbortSignal, 'collector_invalid_signal');
    seed = seed.toLowerCase(); cancelled(); stage('started', { providers: [...PROVIDERS], seed, sampleSize: 16 });
    const primaryChain = await call('drpc', 'eth_chainId', [], 'anchor_chain'); requireTrue(primaryChain === '0x1', 'collector_wrong_chain');
    const latestHeader = await call('drpc', 'eth_getBlockByNumber', ['latest', false], 'anchor_header');
    const verifiedHeader = verifyHeader(latestHeader, latestHeader?.hash, undefined, true), H = BigInt(verifiedHeader.number);
    requireTrue(H <= (1n << 64n) - 3n, 'collector_target_overflow');
    const anchorObservedAtMs = clock(), waitDeadlineMs = anchorObservedAtMs + COLLECTOR_LIMITS.waitMs;
    requireTrue(Number.isSafeInteger(waitDeadlineMs) && waitDeadlineMs <= 8_640_000_000_000_000, 'collector_clock_invalid');
    const targetBlockNumbers = [(H + 1n).toString(), (H + 2n).toString()];
    artifacts.anchorDeclaration = { chainId: 1, anchor: { blockNumber: H.toString(), blockHash: verifiedHeader.blockHash }, latestHeader, verifiedHeader, targetBlockNumbers, seed, sampleSize: 16, anchorObservedAt: new Date(anchorObservedAtMs).toISOString(), waitDeadline: new Date(waitDeadlineMs).toISOString(), waitMs: COLLECTOR_LIMITS.waitMs };
    stage('anchor_declared', structuredClone(artifacts.anchorDeclaration), anchorObservedAtMs);
    while (clock() < waitDeadlineMs) {
      cancelled(); const before = clock(), chunkDeadline = Math.min(waitDeadlineMs, before + COLLECTOR_LIMITS.waitChunkMs);
      stage('wait_chunk_started', { until: new Date(chunkDeadline).toISOString(), durationMs: chunkDeadline - before }, before);
      try { await cancellableWait(waitUntil, chunkDeadline, signal); } catch (error) { if (signal?.aborted) fault('collector_cancelled'); throw error; }
      cancelled(); const after = clock(); requireTrue(after >= chunkDeadline, 'collector_wait_incomplete');
      stage('wait_chunk_completed', { until: new Date(chunkDeadline).toISOString() }, after);
    }
    cancelled(); stage('wait_completed', { deadline: new Date(waitDeadlineMs).toISOString() });
    const secondaryChain = await call('publicnode', 'eth_chainId', [], 'secondary_chain'); requireTrue(secondaryChain === '0x1', 'collector_wrong_chain');
    // Observe both tips once before traversing either branch or loading bodies.
    for (const provider of PROVIDERS) {
      const header = await call(provider, 'eth_getBlockByNumber', ['finalized', false], 'fixed_finalized_tip');
      const observedAt = new Date(clock()).toISOString();
      artifacts.finalizedObservations.push({ provider, observedAt, header });
      stage('finalized_observed', { provider, observedAt, header });
    }
    for (const tip of artifacts.finalizedObservations) {
      tip.verifiedHeader = verifyHeader(tip.header, tip.header?.hash, undefined, true);
      const count = BigInt(tip.verifiedHeader.number) - H + 1n;
      requireTrue(count >= 3n, 'collector_finality_below_targets');
      requireTrue(count <= BigInt(COLLECTOR_LIMITS.headersPerProvider), 'collector_ancestry_cap');
    }
    const targetSet = new Set(targetBlockNumbers);
    for (const tip of artifacts.finalizedObservations) {
      const provider = tip.provider, headers = [], top = BigInt(tip.verifiedHeader.number);
      let expectedHash = tip.verifiedHeader.blockHash;
      for (let number = top; number >= H; number--) {
        cancelled(); const target = targetSet.has(number.toString()); let header;
        if (number === H && provider === 'drpc') {
          requireTrue(expectedHash === verifiedHeader.blockHash, 'collector_anchor_branch_mismatch'); header = latestHeader;
          stage('header_reused', { provider, blockNumber: number.toString(), blockHash: expectedHash, source: 'anchor_header' });
        } else if (number === top && !target) {
          header = tip.header; stage('header_reused', { provider, blockNumber: number.toString(), blockHash: expectedHash, source: 'fixed_finalized_tip' });
        } else header = await call(provider, 'eth_getBlockByHash', [expectedHash, target], target ? 'target_full_body' : 'ancestry_header');
        const proof = verifyHeader(header, expectedHash, number, !target);
        if (number === top) requireTrue(isDeepStrictEqual(proof, tip.verifiedHeader), 'collector_finalized_commitment_changed');
        headers.push(header); expectedHash = proof.parentHash;
      }
      headers.reverse();
      const observation = { provider, chainId: '0x1', finalizedObservedAt: tip.observedAt, finalizedBlockHash: tip.verifiedHeader.blockHash, headers };
      artifacts.observations.push(observation); stage('provider_collected', { provider, headerCount: headers.length, finalizedBlockHash: observation.finalizedBlockHash });
    }
    cancelled(); activeStage = 'census_validation';
    census = validateCohortCensus({ chainId: 1, anchor: artifacts.anchorDeclaration.anchor, targetBlockNumbers, anchorObservedAt: artifacts.anchorDeclaration.anchorObservedAt, seed, sampleSize: 16, observations: artifacts.observations });
    stage('complete', { censusId: census.censusId, censusTransactions: census.census.length, selectedTransactions: census.selected.length });
    return freeze({ status: 'complete', census, artifacts });
  } catch (error) {
    artifacts.failure = { stage: activeStage, code: safeCause(error), at: lastTime === null ? null : new Date(lastTime).toISOString() };
    if (typeof save === 'function' && !saveFailed && lastTime !== null) {
      try { stage('selection_failed', structuredClone(artifacts.failure), lastTime); } catch { artifacts.failure = { ...artifacts.failure, causeCode: artifacts.failure.code, code: 'collector_save_failed' }; }
    }
    return freeze({ status: 'selection_failed', census: null, artifacts });
  }
}
