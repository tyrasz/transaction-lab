// No endpoint, provider trace, poststate, filesystem state or expected output is
// accepted. This is a process boundary, not an OS network/filesystem sandbox.
import { createRpcStateInputs } from './rpc-state-inputs.js';
import { createProofStateManager } from './proof-state.js';
import { executeEthereumCall } from './ethereum-call.js';
import { decode, encode, envelope, fields, need, normalizeLimits } from './isolated-protocol.js';

let started = false, terminal = false, pending = null, nextId = 1, limits;
function send(value, maxBytes) {
  return new Promise((resolve, reject) => {
    if (!process.connected) return reject(new Error('Disconnected.'));
    process.send(encode(value, maxBytes), error => error ? reject(error) : resolve());
  });
}
function fatal() {
  if (terminal) return; terminal = true;
  pending?.reject(new Error('Worker protocol unavailable.')); pending = null;
  // Error details never cross this boundary.
  send({ v: 1, type: 'failure', id: 1, code: 'LOCAL_ISOLATED_WORKER_FAILED' }, 1024).finally(() => process.exit(1)).catch(() => {});
}
process.on('disconnect', () => { if (!terminal) process.exit(1); });
process.on('uncaughtException', fatal); process.on('unhandledRejection', fatal);
process.on('message', raw => {
  try {
    const message = decode(raw, started ? limits.responseBytes + 1024 : 256 * 1024);
    if (!started) {
      envelope(message, 'start', ['payload']); need(message.id === 1);
      if (message.payload?.mode === 'preview') fields(message.payload, ['request', 'header', 'limits', 'mode', 'queries']);
      else fields(message.payload, ['request', 'header', 'limits']);
      started = true; limits = normalizeLimits(message.payload.limits);
      void run(message.payload).catch(fatal); return;
    }
    need(!terminal && pending && message.id === pending.id);
    if (message.type === 'rpc_result') envelope(message, 'rpc_result', ['result']);
    else { envelope(message, 'rpc_error', ['code']); need(message.code === 'RPC_UNAVAILABLE'); }
    const current = pending; pending = null; current.cleanup();
    if (message.type === 'rpc_result') current.resolve(message.result); else current.reject(new Error('Pinned read unavailable.'));
  } catch { fatal(); }
});

async function run({ request, header, mode, queries }) {
  const rpc = { call(method, params, { signal } = {}) {
    return new Promise((resolve, reject) => {
      need(!pending && !terminal); const id = nextId++;
      const abort = () => {
        if (pending?.id !== id) return;
        pending = null; signal?.removeEventListener('abort', abort);
        void send({ v: 1, type: 'rpc_cancel', id }, 1024).catch(fatal);
        reject(new Error('Pinned read cancelled.'));
      };
      pending = { id, resolve, reject, cleanup: () => signal?.removeEventListener('abort', abort) };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) return abort();
      send({ v: 1, type: 'rpc', id, method, params }, 128 * 1024).catch(fatal);
    });
  } };
  let result;
  if (mode === 'preview') {
    const { executeEthereumPreview } = await import('./ethereum-preview.js');
    result = { preview: await executeEthereumPreview({ request, header, rpc, queries, limits: {
      wallMs: Math.min(limits.wallMs, limits.inputs.wallMs, limits.execution.wallMs), requestMs: limits.requestMs,
      calls: limits.calls, responseBytes: limits.responseBytes, totalBytes: limits.totalResponseBytes,
      ...Object.fromEntries(['accounts', 'slots', 'codeBytes', 'reads'].map(key => [key, limits.inputs[key]])),
      ...Object.fromEntries(['steps', 'frames', 'logs', 'traceBytes', 'gas', 'depth', 'memoryBytes', 'calldataBytes'].map(key => [key, limits.execution[key]])),
      rootReturnBytes: limits.execution.returnBytes,
    } }) };
  } else {
    const inputs = createRpcStateInputs({ chainId: 1, blockHash: header.hash, header, rpc, limits: {
      ...limits.inputs, calls: limits.calls, requestMs: limits.requestMs, responseBytes: limits.responseBytes, totalBytes: limits.totalResponseBytes,
    } });
    const state = createProofStateManager({ inputs });
    const output = await executeEthereumCall({ request, header, stateManager: state, blockchain: inputs.blockchain, limits: limits.execution });
    result = { output, inputs: inputs.snapshotInputs(), inputEvidence: inputs.snapshotEvidence(), inputUsage: inputs.snapshotUsage(),
      inputReads: inputs.snapshotReads(), stateReads: state.snapshotReads(), changes: state.snapshotChanges() };
  }
  need(!pending && !terminal);
  const message = encode({ v: 1, type: 'result', id: 1, result }, limits.outputBytes);
  terminal = true;
  await new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
  process.disconnect(); process.exitCode = 0;
}
