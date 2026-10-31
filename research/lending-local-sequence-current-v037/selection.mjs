// Pure transcript reducer. This module performs no I/O. The coordinator must
// independently verify the external source pin, persist native wire bytes, and
// prove I/O drainage before dispatching a target. A selected header is a supplier
// observation, not a consensus, finality, persistence or process-closure claim.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual, types } from 'node:util';
import { verifyEthereumHeader } from '../../engines/local-evm/ethereum-header.js';
import { ethereumCommon } from '../../engines/local-evm/ethereum-profile.js';
import { parseStrictJson } from './strict-json.mjs';

export const SELECTION_ENDPOINT = 'https://eth.drpc.org';
export const HEADER_SELECTION_POLICY = Object.freeze({ requests: 3, responseBytes: 2 * 1024 * 1024,
  totalBytes: 6 * 1024 * 1024, requestMs: 15000, phaseMs: 60000, drainMs: 10000,
  headerAgeMs: 120000, headerFutureMs: 30000, firstTargetMs: 180000 });
const SHA = /^[0-9a-f]{64}$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const error = message => Object.assign(new Error(message), { code: 'CURRENT_HEADER_SELECTION_INVALID' });
const need = (condition, message) => { if (!condition) throw error(message); };
const copy = value => JSON.parse(JSON.stringify(value));
function record(value, keys, name) {
  need(value && typeof value === 'object' && !types.isProxy(value) && !Array.isArray(value)
    && [null, Object.prototype].includes(Object.getPrototypeOf(value)), `${name} must be a plain record.`);
  const actual = Reflect.ownKeys(value);
  need(actual.length === keys.length && actual.every(key => typeof key === 'string' && keys.includes(key)), `${name} has unexpected fields.`);
  for (const key of actual) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    need(d.enumerable && Object.hasOwn(d, 'value'), `${name} has an accessor or hidden field.`);
  }
}
function clock(value) {
  record(value, ['wallMs', 'monotonicMs'], 'Clock');
  need(Number.isSafeInteger(value.wallMs) && value.wallMs >= 0 && Number.isFinite(value.monotonicMs)
    && value.monotonicMs >= 0 && value.monotonicMs <= Number.MAX_SAFE_INTEGER, 'Clock values are invalid.');
  return { ...value };
}
function elapsed(from, to) {
  need(to.wallMs >= from.wallMs && to.monotonicMs >= from.monotonicMs, 'Clock reversal.');
  return Math.max(to.wallMs - from.wallMs, to.monotonicMs - from.monotonicMs);
}
function binding(value) {
  record(value, ['intentPlanSha256', 'sourceManifestSha256', 'nodeSha256'], 'Source binding');
  need(Object.values(value).every(v => typeof v === 'string' && SHA.test(v)), 'External source binding is missing a SHA-256 pin.');
  return { ...value };
}
function rawRecord(value) {
  record(value, ['endpoint', 'requestText', 'httpStatus', 'responseBase64', 'responseBytesObserved', 'complete', 'error'], 'Raw response');
  need(typeof value.endpoint === 'string' && value.endpoint.length <= 512 && typeof value.requestText === 'string' && value.requestText.length <= 4096, 'Invalid retained request.');
  need(value.httpStatus === null || Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599, 'Invalid HTTP status.');
  need(typeof value.complete === 'boolean' && (value.error === null || typeof value.error === 'string' && value.error.length <= 1024), 'Invalid transport disposition.');
  need(typeof value.responseBase64 === 'string' && value.responseBase64.length <= Math.ceil(HEADER_SELECTION_POLICY.responseBytes / 3) * 4, 'Retained response exceeds the byte limit.');
  const bytes = Buffer.from(value.responseBase64, 'base64');
  need(bytes.toString('base64') === value.responseBase64 && bytes.length <= HEADER_SELECTION_POLICY.responseBytes, 'Response is not canonical bounded base64.');
  need(Number.isSafeInteger(value.responseBytesObserved) && value.responseBytesObserved >= bytes.length, 'Observed response byte count is invalid.');
  return { raw: { ...value }, bytes };
}

export function createHeaderSelection({ sourceBinding, started }) {
  const externalBinding = binding(sourceBinding), start = clock(started);
  let last = start, pending = null, count = 0, totalBytes = 0, header = null, headerVerification = null;
  let latestReceived = null, finished = null, status = 'selecting', failure = null;
  const events = [];
  function tick(at) {
    const next = clock(at);
    elapsed(last, next); last = next;
    need(elapsed(start, next) <= HEADER_SELECTION_POLICY.phaseMs, 'Header selection phase exceeded its dual-clock budget.');
    return next;
  }
  function guarded(action) {
    // Terminal reports are immutable. Later source/persistence/closure faults
    // belong in the capture/coordinator wrapper, not in a rewritten transcript.
    need(status === 'selecting', 'Selection is already terminal.');
    const eventCount = events.length, wasSelecting = status === 'selecting';
    try { return action(); }
    catch (e) {
      status = 'unavailable'; failure = { code: 'CURRENT_HEADER_SELECTION_INVALID', message: String(e?.message ?? e).slice(0, 1024) };
      // A rejected request clock or malformed raw-record schema may fail before
      // it can be represented as a request/response event. Retain an explicitly
      // unavailable marker at the last accepted clock. This is not evidence of
      // its asserted cause; the coordinator separately retains native failures.
      if (wasSelecting && events.length === eventCount) {
        events.push({ kind: 'failure', clock: { ...last }, error: failure.message });
        finished = { ...last };
      }
      throw error(failure.message);
    }
  }
  function snapshot() {
    return copy({ schemaVersion: '1.0', kind: 'current_header_selection', endpoint: SELECTION_ENDPOINT,
      policy: HEADER_SELECTION_POLICY, sourceBinding: externalBinding, started: start, status, error: failure,
      events, requests: count, responseBytesObserved: totalBytes, latestReceived, finished,
      header: status === 'selected' ? header : null, headerVerification: status === 'selected' ? headerVerification : null,
      scope: { consensusVerified: false, finalityVerified: false, nativeIoClosureVerifiedHere: false, sourceIdentityVerifiedHere: false } });
  }
  return Object.freeze({
    request(at) { return guarded(() => {
      need(status === 'selecting' && pending === null && count < 3, 'No further header request is permitted.');
      const sampled = tick(at);
      const method = count === 0 ? 'eth_chainId' : 'eth_getBlockByNumber';
      const params = count === 0 ? [] : [count === 1 ? 'latest' : header.number, false];
      const request = { endpoint: SELECTION_ENDPOINT, requestText: JSON.stringify({ jsonrpc: '2.0', id: count + 1, method, params }) };
      pending = { ...request, started: sampled, index: count };
      count++;
      events.push({ kind: 'request', clock: sampled, request });
      return copy(request);
    }); },
    accept(value, at) { return guarded(() => {
      need(status === 'selecting' && pending !== null, 'There is no pending header request.');
      const { raw, bytes } = rawRecord(value);
      // Retain a bounded raw failure before temporal/semantic checks. Full native
      // transport records remain the coordinator's original-write responsibility.
      events.push({ kind: 'response', clock: clock(at), record: raw,
        requestSha256: digest(raw.requestText), responseSha256: digest(bytes), responseBytesRetained: bytes.length });
      totalBytes += raw.responseBytesObserved;
      const sampled = tick(at);
      need(elapsed(pending.started, sampled) <= HEADER_SELECTION_POLICY.requestMs, 'Header request exceeded its dual-clock budget.');
      need(totalBytes <= HEADER_SELECTION_POLICY.totalBytes && raw.responseBytesObserved <= HEADER_SELECTION_POLICY.responseBytes, 'Observed response byte limit exceeded.');
      need(raw.endpoint === pending.endpoint && raw.requestText === pending.requestText, 'Raw request differs from the prescribed request.');
      need(raw.httpStatus === 200 && raw.complete && raw.error === null && bytes.length === raw.responseBytesObserved, 'Header transport did not complete successfully.');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes), response = parseStrictJson(text);
      record(response, ['jsonrpc', 'id', 'result'], 'JSON-RPC response');
      need(response.jsonrpc === '2.0' && response.id === pending.index + 1, 'JSON-RPC response identity differs.');
      if (pending.index === 0) need(response.result === '0x1', 'Supplier chain is not mainnet.');
      else if (pending.index === 1) {
        const verified = verifyEthereumHeader({ header: response.result, expectedHash: response.result?.hash, chainId: 1 });
        ethereumCommon(response.result, 1);
        const timestampMs = BigInt(verified.timestamp) * 1000n, receiptMs = BigInt(sampled.wallMs);
        need(receiptMs - timestampMs <= BigInt(HEADER_SELECTION_POLICY.headerAgeMs)
          && timestampMs - receiptMs <= BigInt(HEADER_SELECTION_POLICY.headerFutureMs), 'Selected header timestamp is stale or too far in the future.');
        header = copy(response.result); headerVerification = verified; latestReceived = sampled;
      } else need(isDeepStrictEqual(response.result, header), 'Canonical reread differs from the complete selected header.');
      pending = null;
      return snapshot();
    }); },
    finish(at) { return guarded(() => {
      need(status === 'selecting' && count === 3 && pending === null && header !== null, 'All three header reads must complete before selection finishes.');
      const lastResponse = events.at(-1);
      events.push({ kind: 'finish', clock: clock(at) });
      const sampled = tick(at);
      // finish must follow actual coordinator drainage; this bounds the interval
      // but cannot independently attest that native I/O has settled.
      need(lastResponse?.kind === 'response' && elapsed(lastResponse.clock, sampled) <= HEADER_SELECTION_POLICY.drainMs, 'Selection terminal drain interval exceeded its budget.');
      finished = sampled; status = 'selected';
      return snapshot();
    }); },
    fail(reason, at) { return guarded(() => {
      need(status === 'selecting', 'Selection is already terminal.');
      need(typeof reason === 'string' && reason.length > 0 && reason.length <= 1024, 'Failure reason is invalid.');
      // An unavailable terminal marker may be recorded after the phase deadline.
      // It cannot produce a selected header or authorize target dispatch.
      const sampled = clock(at); elapsed(last, sampled); last = sampled;
      events.push({ kind: 'failure', clock: sampled, error: reason });
      status = 'unavailable'; failure = { code: 'CURRENT_HEADER_SELECTION_INVALID', message: reason }; finished = sampled;
      return snapshot();
    }); },
    snapshot,
  });
}

/** Saved-only semantic validation. External ledger/source/raw-native joins are
 * additional requirements; this reducer cannot attest them from self-reports. */
export function replayHeaderSelection(report) {
  need(report && Array.isArray(report.events) && report.events.length <= 7, 'Selection transcript has invalid event count.');
  const reducer = createHeaderSelection({ sourceBinding: report.sourceBinding, started: report.started });
  for (let i = 0; i < report.events.length; i++) {
    const event = report.events[i];
    try {
      if (event.kind === 'request') need(isDeepStrictEqual(reducer.request(event.clock), event.request), 'Saved request differs from prescribed request.');
      else if (event.kind === 'response') reducer.accept(event.record, event.clock);
      else if (event.kind === 'finish') reducer.finish(event.clock);
      else if (event.kind === 'failure') reducer.fail(event.error, event.clock);
      else throw error('Unknown selection event.');
    } catch (e) {
      // A retained response may itself prove a terminal transport/semantic failure.
      need(i === report.events.length - 1 && reducer.snapshot().status === 'unavailable', 'Transcript continues after selection failure.');
    }
  }
  const derived = reducer.snapshot();
  need(isDeepStrictEqual(derived, report), 'Saved selection does not equal independent transcript reduction.');
  return derived;
}

export function assertFirstTargetFresh(report, at) {
  const selected = replayHeaderSelection(report), sampled = clock(at);
  need(selected.status === 'selected', 'No usable selected header.');
  elapsed(selected.finished, sampled);
  need(elapsed(selected.latestReceived, sampled) <= HEADER_SELECTION_POLICY.firstTargetMs, 'First target dispatch is outside the selected-header freshness window.');
  return { firstTarget: sampled, elapsedSinceLatestMs: elapsed(selected.latestReceived, sampled), blockHash: selected.header.hash };
}
