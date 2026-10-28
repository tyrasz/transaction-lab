// Pure, transport-independent validation for the configured token query paths.
// This validates observed call behavior only, not query state/fee/header effects.
import { POOL, USDC, HUSDC, VUSDC } from './config.js';
import { failState, uint, UINT256_MAX } from './state.js';

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const WORD = /^0x[0-9a-f]{64}$/i;
const BYTES = /^0x(?:[0-9a-f]{2})*$/i;
const BALANCE = /^0x70a082310{24}[0-9a-f]{40}$/i;
const ALLOWANCE = /^0xdd62ed3e0{24}[0-9a-f]{40}0{24}[0-9a-f]{40}$/i;
export const QUERY_IMPLEMENTATIONS = Object.freeze({
  [USDC]: '0x003f73f58ca78880da3642c5cb71d7459b3fe4f8',
  [HUSDC]: '0x410aa1ab680b886c875e99a7a4bfaf188508a7a3',
  [VUSDC]: '0x8158e5569475a443a5723ccac462930f590449ed',
});
const POOL_IMPLEMENTATION = '0xbebb62c7ff8b96db4325d9481c44e09a92d49b06';
const lower = value => typeof value === 'string' ? value.toLowerCase() : '';
const isAddress = value => typeof value === 'string' && ADDRESS.test(value);
const isWord = value => typeof value === 'string' && WORD.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const quantity = (value, max = UINT256_MAX) => { const n = uint(value); return n !== null && n <= max ? n : null; };
const bytes = value => typeof value === 'string' && BYTES.test(value);
const failed = frame => Boolean(frame?.error || frame?.revertReason);

/** Canonical balanceOf for configured tokens, allowance for USDC/hUSDC only. */
export function normalizeTokenQuery(query) {
  const supportedQuery = object(query) && typeof query.data === 'string' && ((Object.hasOwn(QUERY_IMPLEMENTATIONS, lower(query.to)) && BALANCE.test(query.data)) || ([USDC, HUSDC].includes(lower(query.to)) && ALLOWANCE.test(query.data)));
  if (!supportedQuery) failState('Historical state queries are restricted to configured token balanceOf and USDC/hUSDC allowance calls.');
  return { to: lower(query.to), data: lower(query.data) };
}

// Keep historical diagnostics and normalization semantics unchanged during this
// extraction. Input-gas annotations are omitted; gasUsed remains mandatory.
export function semanticTrace(trace) {
  let frames = 0, logs = 0;
  function visit(frame, depth = 0) {
    if (++frames > 1000 || depth > 32) failState('Historical trace exceeds its frame or depth limit.');
    if (!object(frame) || !['CALL', 'STATICCALL', 'DELEGATECALL', 'CALLCODE', 'CREATE', 'CREATE2', 'SELFDESTRUCT'].includes(frame.type) || !isAddress(frame.from) || !isAddress(frame.to) || !bytes(frame.input ?? '0x') || !bytes(frame.output ?? '0x') || quantity(frame.gasUsed) === null || (frame.gas !== undefined && quantity(frame.gas) === null) || (frame.value !== undefined && quantity(frame.value) === null)) failState('Historical call trace contains malformed execution fields.');
    if (Object.keys(frame).some(field => !['type', 'from', 'to', 'input', 'output', 'value', 'gas', 'gasUsed', 'error', 'revertReason', 'logs', 'calls'].includes(field))) failState('Historical call trace contains unsupported execution fields.');
    if (frame.calls !== undefined && !Array.isArray(frame.calls)) failState('Historical call trace contains malformed child calls.');
    if (frame.logs !== undefined && !Array.isArray(frame.logs)) failState('Historical call trace contains malformed logs.');
    for (const field of ['error', 'revertReason']) if (frame[field] !== undefined && (typeof frame[field] !== 'string' || frame[field].length > 2000)) failState('Historical call trace contains malformed failure data.');
    const normalized = { type: frame.type, from: lower(frame.from), to: lower(frame.to), input: lower(frame.input ?? '0x'), output: lower(frame.output ?? '0x'), value: (quantity(frame.value ?? '0x0')).toString(), gasUsed: quantity(frame.gasUsed).toString(), error: frame.error ?? null, revertReason: frame.revertReason ?? null, logs: [], calls: [] };
    for (const log of frame.logs ?? []) {
      if (++logs > 2000 || !object(log) || !isAddress(log.address) || !Array.isArray(log.topics) || log.topics.length > 4 || log.topics.some(topic => !isWord(topic)) || !bytes(log.data)) failState('Historical trace contains malformed or excessive event evidence.');
      if (Object.keys(log).some(field => !['address', 'topics', 'data', 'position', 'index', 'logIndex', 'removed'].includes(field))) failState('Historical call trace contains unsupported event fields.');
      const item = { address: lower(log.address), topics: log.topics.map(lower), data: lower(log.data) };
      for (const field of ['position', 'index', 'logIndex']) if (log[field] !== undefined) {
        if (quantity(log[field]) === null) failState('Historical event position is malformed.');
        item[field] = quantity(log[field]).toString();
      }
      if (log.removed) failState('Historical trace contains removed event evidence.');
      normalized.logs.push(item);
    }
    normalized.calls = (frame.calls ?? []).map(child => visit(child, depth + 1));
    return normalized;
  }
  return visit(trace);
}

/** Assert exact behavior of a frame already normalized by semanticTrace. */
export function assertReadOnlyFrame(frame, { type, from, to, input, output, childCount }) {
  if (failed(frame) || frame.type !== type || frame.from !== lower(from) || frame.to !== lower(to) || frame.input !== lower(input) || (output !== undefined && frame.output !== lower(output)) || frame.value !== '0' || frame.logs.length || frame.calls.length !== childCount) failState('Historical state query does not match the verified token call behavior.');
}

/** Accept one raw callTracer object; RPC envelope validation stays with callers. */
export function validateTokenQueryTrace(trace, query, sender) {
  const q = normalizeTokenQuery(query);
  const root = semanticTrace(trace);
  if (!isWord(root.output)) failState('Historical state query did not return exactly one uint256 word.');
  assertReadOnlyFrame(root, { type: 'CALL', from: sender, to: q.to, input: q.data, childCount: 1 });
  const implementation = root.calls[0];
  const positionBalance = q.to !== USDC && BALANCE.test(q.data);
  assertReadOnlyFrame(implementation, { type: 'DELEGATECALL', from: q.to, to: QUERY_IMPLEMENTATIONS[q.to], input: q.data, output: root.output, childCount: positionBalance ? 1 : 0 });
  if (positionBalance) {
    const indexInput = (q.to === HUSDC ? '0xd15e0053' : '0x386497fd') + USDC.slice(2).padStart(64, '0');
    const pool = implementation.calls[0];
    assertReadOnlyFrame(pool, { type: 'STATICCALL', from: q.to, to: POOL, input: indexInput, childCount: 1 });
    if (!isWord(pool.output) || BigInt(pool.output) === 0n) failState('Historical position query returned an invalid reserve index.');
    assertReadOnlyFrame(pool.calls[0], { type: 'DELEGATECALL', from: POOL, to: POOL_IMPLEMENTATION, input: indexInput, output: pool.output, childCount: 0 });
  }
  return { amount: BigInt(root.output), gasUsed: BigInt(root.gasUsed) };
}
