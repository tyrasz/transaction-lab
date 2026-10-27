import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { verifyEthereumHeader } from './ethereum-header.js';
import { ethereumQuantity, ethereumCallGas, ethereumCommon } from './ethereum-profile.js';
import { ISOLATED_LIMITS, IsolationError, decode, encode, envelope, fields, need, normalizeLimits, validateRpcRequest } from './isolated-protocol.js';
export { ISOLATED_LIMITS, IsolationError } from './isolated-protocol.js';

const WORKER = fileURLToPath(new URL('./isolated-worker.js', import.meta.url));
const sha = text => createHash('sha256').update(text).digest('hex');
const EMPTY = { output: null, inputs: null, inputEvidence: null, inputUsage: null, inputReads: null, stateReads: null, changes: null };
const safe = (code, message) => ({ code, message });

/** Executes one unsigned chain-1 call in a fixed Node child. rpc.call is a trusted
 * bounded parent adapter; raw transport evidence remains its responsibility.
 * No endpoint/expected execution/poststate is given to the child. Process/V8
 * bounds are not OS permissions or hard total-memory/network restrictions.
 */
export async function executeIsolatedEthereumCall(options) {
  let request, header, limits, rpc, signal, headerVerification;
  try {
    fields(options, ['request', 'header', 'rpc', 'limits', 'signal'], ['request', 'header', 'rpc']);
    ({ rpc, signal } = options); need(typeof rpc?.call === 'function');
    need(signal === undefined || (typeof signal.aborted === 'boolean' && typeof signal.addEventListener === 'function' && typeof signal.removeEventListener === 'function'));
    limits = normalizeLimits(options.limits);
    request = decode(encode(options.request, 128 * 1024), 128 * 1024); fields(request, ['from', 'to', 'data', 'value', 'gas']);
    need(['from', 'to'].every(k => typeof request[k] === 'string' && /^0x[0-9a-f]{40}$/i.test(request[k])));
    ethereumQuantity(request.value); const gas = ethereumQuantity(request.gas);
    header = decode(encode(options.header, 128 * 1024), 128 * 1024);
    headerVerification = verifyEthereumHeader({ header, expectedHash: header.hash });
    need(gas <= 5000000n && gas >= ethereumCallGas(request.data, ethereumCommon(header)).minimum);
    header.hash = header.hash.toLowerCase();
  } catch {
    return { status: 'unavailable', error: safe('LOCAL_ISOLATED_INPUT', 'The fixed call, header or limits are invalid.'), ...EMPTY, headerVerification: null, isolation: null, broker: { calls: 0, records: [], pendingAtReturn: 0 } };
  }
  const began = performance.now(), records = [], active = new Set(), controllers = new Set();
  let child, closed = false, sealed = false, failure = null, candidate = null, pendingId = null, totalBytes = 0, stdioBytes = 0, dispatches = 0, timer, killTimer;
  let exitCode = null, exitSignal = null, terminateRequested = false, completion;
  const finished = new Promise(resolve => { completion = resolve; });
  function fail(code, message) {
    if (sealed || failure) return;
    failure = safe(code, message); candidate = null;
    for (const controller of controllers) controller.abort();
    if (child && !closed) {
      terminateRequested = true;
      try { child.kill('SIGKILL'); } catch { /* Report unconfirmed termination below. */ }
      killTimer ??= setTimeout(completion, limits.killWaitMs);
    } else completion();
  }
  function expired() { if (performance.now() - began >= limits.wallMs) fail('LOCAL_ISOLATED_TIMEOUT', 'The isolated process exceeded its wall-time budget.'); return failure !== null; }
  function send(message, maxBytes) {
    if (failure || sealed || !child?.connected) return;
    try { child.send(encode(message, maxBytes), error => { if (error && !closed) fail('LOCAL_ISOLATED_IPC', 'The isolated process channel failed.'); }); }
    catch { fail('LOCAL_ISOLATED_IPC', 'The isolated process channel failed.'); }
  }
  async function broker(message) {
    const controller = new AbortController(); controllers.add(controller);
    const entry = { id: message.id, request: { method: message.method, params: structuredClone(message.params) }, status: 'pending', representation: 'parsed_rpc_result_not_wire_bytes' };
    records.push(entry); const started = performance.now(); let requestTimer, abortListener;
    const actual = Promise.resolve().then(() => {
      need(!sealed && !failure && !controller.signal.aborted && !expired(), 'LOCAL_ISOLATED_ABORTED', 'The pinned read was cancelled before dispatch.');
      entry.dispatched = true; dispatches++;
      return rpc.call(message.method, structuredClone(message.params), { signal: controller.signal });
    });
    // Track the underlying adapter separately from the deadline race. A caller
    // that ignores abort is reported as undrained; late data cannot change output.
    active.add(actual); actual.finally(() => active.delete(actual)).catch(() => {});
    try {
      const cancelled = new Promise((_, reject) => { abortListener = () => reject(new IsolationError('LOCAL_ISOLATED_ABORTED', 'The pinned read was cancelled.')); controller.signal.addEventListener('abort', abortListener, { once: true }); });
      const result = await Promise.race([actual, cancelled, new Promise((_, reject) => { requestTimer = setTimeout(() => { reject(new IsolationError('LOCAL_ISOLATED_RPC_TIMEOUT', 'A parent state read timed out.')); controller.abort(); }, Math.max(1, Math.min(limits.requestMs, limits.wallMs - (started - began)))); })]);
      if (sealed || failure || expired()) return;
      const text = encode(result, limits.responseBytes); totalBytes += Buffer.byteLength(text);
      entry.resultBytes = Buffer.byteLength(text); entry.resultSha256 = sha(text);
      need(totalBytes <= limits.totalResponseBytes, 'LOCAL_ISOLATED_SIZE', 'Parent state reads exceeded their total byte limit.');
      entry.status = 'received'; pendingId = null;
      send({ v: 1, type: 'rpc_result', id: message.id, result: JSON.parse(text) }, limits.responseBytes + 1024);
    } catch (error) {
      if (sealed || failure) return;
      entry.status = 'unavailable'; entry.error = safe('RPC_UNAVAILABLE', 'The pinned parent read was unavailable.'); pendingId = null;
      if (error instanceof IsolationError) fail(error.code, error.message);
      else send({ v: 1, type: 'rpc_error', id: message.id, code: 'RPC_UNAVAILABLE' }, 1024);
    } finally {
      clearTimeout(requestTimer); controller.signal.removeEventListener('abort', abortListener); controller.abort(); controllers.delete(controller);
      if (!sealed) entry.durationMs = Math.max(0, performance.now() - started);
    }
  }
  function validateResult(result) {
    fields(result, Object.keys(EMPTY));
    need(result.output && ['success', 'reverted', 'failed', 'unsupported', 'unavailable', 'invalid'].includes(result.output.execution?.status));
    const context = result.inputs?.context;
    need(context?.chainId === 1 && context.blockHash === header.hash && context.stateRoot === header.stateRoot.toLowerCase() && isDeepStrictEqual(context.header, header));
    need(Array.isArray(result.inputEvidence) && result.inputEvidence.length === records.length && result.inputUsage?.calls === records.length);
    for (const [i, entry] of result.inputEvidence.entries()) {
      need(entry.id === i + 1 && isDeepStrictEqual(entry.request, records[i].request));
      if (Object.hasOwn(entry, 'result')) need(sha(encode(entry.result, limits.responseBytes)) === records[i].resultSha256);
    }
    need(Array.isArray(result.changes?.accounts));
    for (const reads of [result.stateReads, result.inputReads]) {
      fields(reads, ['total', 'distinct', 'reads']);
      need(Number.isSafeInteger(reads.total) && reads.total >= 0 && Number.isSafeInteger(reads.distinct) && reads.distinct >= 0 && reads.distinct <= reads.total && Array.isArray(reads.reads) && reads.reads.length === reads.distinct);
    }
    return result;
  }
  const cancel = () => fail('LOCAL_ISOLATED_CANCELLED', 'The isolated call was cancelled.');
  try {
    if (signal?.aborted) cancel();
    if (!failure) {
      signal?.addEventListener('abort', cancel, { once: true });
      child = childProcess.fork(WORKER, [], { execPath: process.execPath, execArgv: [`--max-old-space-size=${limits.heapMiB}`],
        cwd: fileURLToPath(new URL('.', import.meta.url)), env: {}, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'json' });
      child.once('error', () => fail('LOCAL_ISOLATED_PROCESS', 'The isolated process could not run.'));
      child.once('close', (code, sig) => {
        closed = true; exitCode = code; exitSignal = sig;
        if (!failure) expired();
        if (!failure && (!candidate || code !== 0 || sig)) fail('LOCAL_ISOLATED_EXIT', 'The isolated process exited without a complete valid result.');
        completion();
      });
      for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
        if (sealed) return; stdioBytes += bytes.length;
        if (stdioBytes > limits.stdioBytes) fail('LOCAL_ISOLATED_STDIO', 'The isolated process exceeded its diagnostic output bound.');
      });
      child.on('message', raw => {
        if (sealed || failure || expired()) return;
        try {
          need(candidate === null);
          const message = decode(raw, limits.outputBytes);
          if (message.type === 'rpc') {
            need(pendingId === null && records.length < limits.calls);
            validateRpcRequest(message, header.hash, records.length + 1); pendingId = message.id;
            void broker(message);
          } else if (message.type === 'result') {
            envelope(message, 'result', ['result']); need(message.id === 1 && pendingId === null); candidate = validateResult(message.result);
          } else if (message.type === 'rpc_cancel') {
            envelope(message, 'rpc_cancel', []); need(message.id === pendingId);
            fail('LOCAL_ISOLATED_RPC_CANCELLED', 'The worker cancelled its required pinned read.');
          } else {
            envelope(message, 'failure', ['code']); need(message.id === 1 && message.code === 'LOCAL_ISOLATED_WORKER_FAILED');
            fail('LOCAL_ISOLATED_WORKER_FAILED', 'The isolated worker could not complete.');
          }
        } catch { fail('LOCAL_ISOLATED_PROTOCOL', 'The isolated worker protocol was invalid.'); }
      });
      timer = setTimeout(() => fail('LOCAL_ISOLATED_TIMEOUT', 'The isolated process exceeded its wall-time budget.'), Math.max(1, limits.wallMs - (performance.now() - began)));
      send({ v: 1, type: 'start', id: 1, payload: { request, header, limits } }, 256 * 1024);
    }
    await finished;
  } catch { fail('LOCAL_ISOLATED_PROCESS', 'The isolated process could not run.'); await finished; }
  clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', cancel);
  for (const controller of controllers) controller.abort();
  if (active.size) {
    let drainTimer;
    try { await Promise.race([Promise.allSettled([...active]), new Promise(resolve => { drainTimer = setTimeout(resolve, limits.drainMs); })]); }
    finally { clearTimeout(drainTimer); }
  }
  // Copy and seal once. Adapter promises that disregard abort may settle later,
  // but cannot alter the result or cause any subsequent dispatch.
  sealed = true;
  for (const entry of records) if (entry.status === 'pending') { entry.status = 'unavailable'; entry.error = safe('RPC_ABORTED', 'The pinned read was not admitted before process completion.'); }
  return {
    status: failure ? 'unavailable' : 'completed', error: failure,
    ...(failure ? EMPTY : candidate), headerVerification,
    isolation: { worker: 'engines/local-evm/isolated-worker.js', processSeparated: true, childPid: child?.pid ?? null,
      node: process.version, v8: process.versions.v8, v8OldSpaceMiB: limits.heapMiB, hardTotalRssCap: false,
      osNetworkSandbox: false, osFilesystemSandbox: false, sourceImplementationBound: false,
      wallMs: limits.wallMs, drainMs: limits.drainMs, durationMs: performance.now() - began,
      terminateRequested, processClosed: closed, exitCode, exitSignal, stdioBytes, limits },
    broker: { calls: records.length, dispatches, accountedParsedResultBytes: totalBytes, records: structuredClone(records), pendingAtReturn: active.size,
      rawWireCaptured: false, inRangeBlockhash: 'unsupported_without_independent_ancestry' },
  };
}
