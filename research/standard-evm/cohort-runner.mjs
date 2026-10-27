import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual as equal } from 'node:util';
import { accountCohortOutcomes } from './cohort-accounting.mjs';
import { adjudicateCohortOutcome } from './cohort-outcomes.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const need = (ok, message) => { if (!ok) throw new Error(message); };
const unavailable = reason => ({ dispatch: 'unavailable', reason });
const unattempted = reason => ({ dispatch: 'budget_unattempted', reason });
const fatalCode = error => ['wire_save_failed', 'artifact_save_failed', 'source_drift', 'runtime_drift', 'local_drain_incomplete', 'product_drain_incomplete'].includes(error?.code);
const fallbackOutcome = (transactionHash, execution, reason) => ({
  outcome: { transactionHash, execution, comparison: execution === 'budget_unattempted' ? 'budget_unattempted' : 'not_comparable' },
  channels: {}, reasons: [reason], allChannelsComplete: false,
});
const rowIdentity = row => Object.fromEntries(['transactionHash', 'blockHash', 'blockNumber', 'transactionIndex', 'rank', 'selected'].map(k => [k, row[k]]));
function phaseSummary(phase, artifact) {
  if (!phase) return null;
  return { dispatch: phase.dispatch, artifact: artifact ?? null, ...(phase.reason ? { reason: phase.reason } : {}),
    ...(phase.httpStatus ? { httpStatus: phase.httpStatus } : {}),
    executionStatus: phase.attempt?.output?.execution?.status ?? phase.report?.execution?.status ?? null };
}
export function compactAdjudication(value) {
  return { ...value, channels: Object.fromEntries(Object.entries(value.channels).map(([name, channel]) => [name, {
    status: channel.status, ...(channel.reason ? { reason: channel.reason } : {}),
    ...(Object.hasOwn(channel, 'product') ? { productSha256: sha(JSON.stringify(channel.product)) } : {}),
    ...(Object.hasOwn(channel, 'local') ? { localSha256: sha(JSON.stringify(channel.local)) } : {}),
  }])) };
}

/** Sequential orchestration only. Real executors and a durable artifact writer
 * are injected by the frozen pilot. Local execution is saved BEFORE product
 * execution for each selected call; neither sees comparison/expected results.
 * Unsupported rows are retained without replacement. No retry API exists.
 */
export async function executeCohortCases({ census, expectedProductImplementation, expectedLocalImplementation,
  executeLocal, executeProduct, save, canAttempt = () => true, assertHealthy = () => {} }) {
  need([executeLocal, executeProduct, save, canAttempt, assertHealthy].every(value => typeof value === 'function'), 'Complete runner dependencies required');
  const selected = census?.selection?.rows?.filter(row => row.selected);
  need(Array.isArray(selected) && selected.length <= 16 && Array.isArray(census.selected) && equal(census.selected.map(rowIdentity), selected), 'Selected rows differ from the fixed sample');
  // Force independent selection/rank/denominator validation before dispatch.
  accountCohortOutcomes(census.selection, selected.map(row => ({ transactionHash: row.transactionHash, execution: 'budget_unattempted', comparison: 'budget_unattempted' })));
  const rows = [], began = performance.now(); let fatal = null, saveFailure = false;
  function persist(path, value) {
    try { need(save(path, structuredClone(value)) === undefined, 'Synchronous artifact writer required'); }
    catch { saveFailure = true; throw new Error('artifact_save_failed'); }
  }
  for (let index = 0; index < census.selected.length; index++) {
    const row = census.selected[index], id = String(index + 1).padStart(3, '0'), started = performance.now();
    const entry = { id, transactionHash: row.transactionHash, projection: row.projection, local: null, product: null, adjudication: null };
    rows.push(entry);
    if (fatal) { entry.adjudication = fallbackOutcome(row.transactionHash, 'provider_unavailable', 'Run interrupted; no replacement or further attempt'); continue; }
    try {
      assertHealthy();
      persist(`cases/${id}/request.json`, { transactionHash: row.transactionHash, parentHeader: row.parentHeader, projection: row.projection });
      need(['projectable', 'unsupported'].includes(row.projection?.status), 'Unrecognized projection status');
      if (row.projection.status === 'unsupported') {
        need(Array.isArray(row.projection.reasons) && row.projection.reasons.length > 0 && !row.projection.request, 'Unsupported projection is incomplete');
        entry.adjudication = fallbackOutcome(row.transactionHash, 'unsupported', 'Envelope cannot be represented by the frozen unsigned profile: ' + row.projection.reasons.join(', '));
      } else {
        const apiRequest = row.projection.request;
        need(apiRequest?.chainId === 1 && apiRequest.block === row.parentBlockHash && row.parentHeader?.hash === row.parentBlockHash, 'Projected parent context is inconsistent');
        const request = { from: apiRequest.from, to: apiRequest.to, data: apiRequest.data, value: apiRequest.value, gas: '5000000' };
        if (!canAttempt({ phase: 'local', row })) entry.local = unattempted('Frozen run budget or cancellation prevented the independent attempt');
        else {
          try { entry.local = await executeLocal({ id, row, request, header: row.parentHeader }); }
          catch (error) { if (fatalCode(error)) throw error; entry.local = unavailable('Independent execution could not produce a complete retained result'); }
        }
        assertHealthy();
        persist(`cases/${id}/local.json`, entry.local);
        entry.localArtifact = `cases/${id}/local.json`;
        if (!canAttempt({ phase: 'product', row })) entry.product = unattempted('Frozen run budget or cancellation prevented the product attempt');
        else {
          try { entry.product = await executeProduct({ id, row, apiRequest }); }
          catch (error) { if (fatalCode(error)) throw error; entry.product = unavailable('Product handler could not produce a complete retained result'); }
        }
        assertHealthy();
        persist(`cases/${id}/product.json`, entry.product);
        entry.productArtifact = `cases/${id}/product.json`;
        entry.adjudication = adjudicateCohortOutcome({ transactionHash: row.transactionHash, request, header: row.parentHeader,
          expectedProductImplementation, expectedLocalImplementation, product: entry.product, local: entry.local });
      }
      entry.durationMs = performance.now() - started;
      persist(`cases/${id}/outcome.json`, entry.adjudication);
    } catch (error) {
      fatal = { code: saveFailure ? 'artifact_save_failed' : fatalCode(error) ? error.code : 'case_orchestration_failed', caseId: id };
      entry.adjudication = fallbackOutcome(row.transactionHash, 'provider_unavailable', 'Case evidence could not be safely completed; run interrupted');
    }
    // Full proofs, response bodies and compared values are already retained in
    // per-case artifacts. Avoid accumulating every full execution in memory.
    entry.local = phaseSummary(entry.local, entry.localArtifact); entry.product = phaseSummary(entry.product, entry.productArtifact);
    delete entry.localArtifact; delete entry.productArtifact;
    entry.adjudication = compactAdjudication(entry.adjudication);
  }
  try { assertHealthy(); } catch (error) { fatal ??= { code: fatalCode(error) ? error.code : 'run_health_failed', caseId: null }; }
  const accounting = accountCohortOutcomes(census.selection, rows.map(row => row.adjudication.outcome));
  return { schemaVersion: '1.0', status: fatal ? 'interrupted' : 'complete', fatal, rows,
    accounting: fatal ? null : accounting, interruptedLedger: fatal ? accounting.ledger : null,
    durationMs: performance.now() - began,
    scope: { execution: 'unsigned_unpriced_parent_block_end', originalTransactionReplay: false,
      economicInventoryAccuracy: 'not_evaluated', securityAccuracy: 'not_evaluated', populationInference: 'descriptive_two_block_pilot_only' } };
}

/** Calls the actual archived API request handler, without a listening socket.
 * Status is the handler's HTTP response code; this does not measure network HTTP
 * transport. RPC bytes and timings are independently captured by the adapter.
 */
export async function invokeProductHandler({ createAppServer, standardApi, rpc, apiRequest, signal, abortPending = () => {}, wallMs = 145000, drainMs = 25000, responseBytes = 128 * 1024 * 1024 }) {
  need(typeof createAppServer === 'function' && standardApi?.implementation && typeof rpc?.call === 'function', 'Product runtime dependencies are missing');
  need(Number.isSafeInteger(wallMs) && wallMs > 0 && wallMs <= 145000 && Number.isSafeInteger(responseBytes) && responseBytes > 0 && responseBytes <= 128 * 1024 * 1024, 'Invalid product handler limits');
  need(Number.isSafeInteger(drainMs) && drainMs > 0 && drainMs <= 25000 && typeof abortPending === 'function', 'Invalid product drain');
  if (signal?.aborted) return { ...unattempted('Product invocation cancelled before dispatch'), drain: { handlerSettled: true, pendingRpcCalls: 0, complete: true } };
  const bodyText = JSON.stringify(apiRequest), request = { method: 'POST', path: '/api/evm/simulate', contentType: 'application/json', bodyText, bodySha256: sha(bodyText) };
  let factories = 0, invalidFactory = false, settled = false, complete = false, captured = null, timer, abort, handlerSettled = false, gateClosed = false;
  const active = new Set();
  const gatedRpc = {
    get rpcMs() { return rpc.rpcMs; },
    snapshotEvidence() { return rpc.snapshotEvidence?.() ?? []; },
    call(method, params) {
      if (gateClosed) return Promise.reject(new Error('Product invocation is closed'));
      const call = Promise.resolve().then(() => { if (gateClosed) throw new Error('Product invocation is closed'); return rpc.call(method, params); });
      active.add(call); call.finally(() => active.delete(call)).catch(() => {}); return call;
    },
  };
  const server = createAppServer({ persist: false, standardLoader: async () => standardApi,
    standardRpcFactory(options) { factories++; if (options?.profile !== 'single' || factories !== 1) { invalidFactory = true; throw new Error('Unexpected product RPC scope'); } return gatedRpc; },
    rpcFactory() { invalidFactory = true; throw new Error('Legacy provider is outside this run'); },
  });
  const handler = server.listeners('request')[0]; need(typeof handler === 'function', 'Product handler is unavailable');
  const req = Readable.from([Buffer.from(bodyText)]);
  Object.assign(req, { method: request.method, url: request.path, headers: { host: '127.0.0.1', 'content-type': request.contentType } });
  const began = performance.now();
  const pending = Promise.resolve().then(() => handler(req, {
    statusCode: 200, headers: null,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; return this; },
    end(body) {
      if (settled) return this;
      const bytes = Buffer.from(body ?? '');
      need(bytes.length <= responseBytes, 'Product response body exceeds its bound');
      captured = { status: this.statusCode, headers: this.headers, bodyText: bytes.toString('utf8'), bytes: bytes.length, sha256: sha(bytes) };
      complete = true; return this;
    },
  }));
  pending.finally(() => { handlerSettled = true; }).catch(() => {});
  let answer;
  try {
    await Promise.race([pending, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('product_handler_deadline')), wallMs);
      abort = () => reject(new Error('product_handler_cancelled'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    })]);
    need(complete && !invalidFactory && factories === 1, 'Product handler did not complete the expected single call');
    const report = JSON.parse(captured.bodyText);
    answer = { dispatch: 'completed', httpStatus: captured.status, report, invocation: 'in_process_archived_http_handler',
      request, response: captured, durationMs: performance.now() - began };
  } catch {
    answer = { ...unavailable('Product handler failed, was cancelled, or exceeded its bound'), invocation: 'in_process_archived_http_handler', request,
      response: complete ? captured : null, durationMs: performance.now() - began };
  } finally {
    settled = true; gateClosed = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
    try { abortPending(); } catch { answer = { ...unavailable('Pending product transport could not be cancelled'), request, response: null }; }
    if (!handlerSettled || active.size) {
      let drainTimer;
      try { await Promise.race([Promise.allSettled([pending, ...active]), new Promise(resolve => { drainTimer = setTimeout(resolve, drainMs); })]); }
      finally { clearTimeout(drainTimer); }
    }
    req.destroy(); server.close();
  }
  return { ...answer, drain: { handlerSettled, pendingRpcCalls: active.size, complete: handlerSettled && active.size === 0 }, durationMs: performance.now() - began };
}
