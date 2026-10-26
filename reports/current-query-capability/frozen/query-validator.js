// Original-position Hyperlend balance and configured-token allowance reads. Every execution is ephemeral;
// this module never signs, submits, or persists a transaction.
import { CHAIN_ID, POOL, USDC, HUSDC, VUSDC } from './config.js';
import { StateValidationError, failState, stateErrorDescription, uint, hex, UINT256_MAX, buildStateOverrides } from './state.js';
import { assertNoProviderErrorResult } from './rpc.js';

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const WORD = /^0x[0-9a-f]{64}$/i;
const BYTES = /^0x(?:[0-9a-f]{2})*$/i;
const BALANCE = /^0x70a082310{24}[0-9a-f]{40}$/i;
const ALLOWANCE = /^0xdd62ed3e0{24}[0-9a-f]{40}0{24}[0-9a-f]{40}$/i;
const IMPLEMENTATIONS = {
  [USDC]: '0x003f73f58ca78880da3642c5cb71d7459b3fe4f8',
  [HUSDC]: '0x410aa1ab680b886c875e99a7a4bfaf188508a7a3',
  [VUSDC]: '0x8158e5569475a443a5723ccac462930f590449ed',
};
const POOL_IMPLEMENTATION = '0xbebb62c7ff8b96db4325d9481c44e09a92d49b06';
const PROBE = '0x000000000000000000000000000000000000ba1a';
const MAX_PAIRS = 12;
const MAX_CALLS = 64;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 32 * 1024 * 1024;
const lower = value => typeof value === 'string' ? value.toLowerCase() : '';
const isAddress = value => typeof value === 'string' && ADDRESS.test(value);
const isWord = value => typeof value === 'string' && WORD.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const quantity = (value, max = UINT256_MAX) => { const n = uint(value); return n !== null && n <= max ? n : null; };
const bytes = value => typeof value === 'string' && BYTES.test(value);
const failed = frame => Boolean(frame?.error || frame?.revertReason);
const identityKey = (request, block) => JSON.stringify({ chainId: uint(request?.chainId)?.toString(), from: lower(request?.from), to: lower(request?.to), data: lower(request?.data), value: uint(request?.value)?.toString(), hash: lower(block?.hash), number: uint(block?.number)?.toString(), timestamp: uint(block?.timestamp)?.toString() });

function rootScope(request) {
  if (!bytes(request?.data)) return null;
  const data = lower(request.data), target = lower(request.to), selector = data.slice(0, 10);
  const fields = count => data.length === 10 + count * 64 ? Array.from({ length: count }, (_, i) => '0x' + data.slice(10 + i * 64, 74 + i * 64)) : null;
  const paddedAddress = value => typeof value === 'string' && /^0x0{24}[0-9a-f]{40}$/.test(value);
  const generic = () => isAddress(target) ? { operation: 'confirmed_contract_call', token: null, requiresCodeProof: true } : null;
  if ([USDC, HUSDC].includes(target) && ['0x095ea7b3', '0xd505accf'].includes(selector)) {
    const args = fields(selector === '0x095ea7b3' ? 2 : selector === '0xd505accf' ? 7 : -1);
    if (!args || !paddedAddress(args[0]) || (selector === '0xd505accf' && (!paddedAddress(args[1]) || BigInt(args[4]) > 255n))) return null;
    return { operation: selector === '0x095ea7b3' ? 'approve' : 'permit', token: target };
  }
  if (target !== POOL) return generic();
  const operation = { '0x617ba037': 'supply', '0x69328dec': 'withdraw', '0xa415bcad': 'borrow', '0x573ade81': 'repay' }[selector];
  if (!operation) return generic();
  const args = fields({ supply: 4, withdraw: 3, borrow: 5, repay: 4 }[operation]);
  if (!args || args[0] !== '0x' + USDC.slice(2).padStart(64, '0')) return null;
  if (operation === 'supply' && (!paddedAddress(args[2]) || BigInt(args[3]) > 65535n)) return null;
  if (operation === 'withdraw' && !paddedAddress(args[2])) return null;
  if (operation === 'borrow' && (BigInt(args[2]) !== 2n || BigInt(args[3]) > 65535n || !paddedAddress(args[4]))) return null;
  if (operation === 'repay' && (BigInt(args[2]) !== 2n || !paddedAddress(args[3]))) return null;
  return { operation, token: null };
}

function rpcFailure(error) {
  const known = new Set(['RPC_TIMEOUT', 'RPC_CONNECTION_ERROR', 'RPC_HTTP_ERROR', 'RPC_EXECUTION_ERROR', 'RPC_INVALID_RESPONSE', 'RPC_RESPONSE_TOO_LARGE', 'METHOD_NOT_ALLOWED']);
  return { code: known.has(error?.code) ? error.code : 'RPC_ERROR', message: 'The historical state provider failed a read-only RPC request.', ...(Number.isSafeInteger(error?.detail?.rpcCode) ? { rpcCode: error.detail.rpcCode } : {}) };
}

// Normalize semantic callTracer fields. Input-gas annotations may differ between
// RPC execution wrappers; gasUsed is mandatory and compared at every frame.
function semanticTrace(trace) {
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

function allLogs(trace) { return failed(trace) ? [] : [...trace.logs, ...trace.calls.flatMap(allLogs)]; }
function hasContractLifecycle(trace) {
  return ['CREATE', 'CREATE2', 'SELFDESTRUCT'].includes(trace.type) || trace.calls.some(hasContractLifecycle);
}
function sortedEventContent(logs) {
  return logs.map(log => JSON.stringify({ address: lower(log.address), topics: log.topics.map(lower), data: lower(log.data) })).sort();
}
function oneTrace(result) {
  if (!Array.isArray(result) || result.length !== 1 || !Array.isArray(result[0]) || result[0].length !== 1 || !object(result[0][0])) failState('Historical RPC must return exactly one bundle containing one result.');
  return result[0][0];
}
function assertFrame(frame, { type, from, to, input, output, childCount }) {
  if (failed(frame) || frame.type !== type || frame.from !== lower(from) || frame.to !== lower(to) || frame.input !== lower(input) || (output !== undefined && frame.output !== lower(output)) || frame.value !== '0' || frame.logs.length || frame.calls.length !== childCount) failState('Historical state query does not match the verified token call behavior.');
}
function validateQuery(result, query, sender) {
  const root = semanticTrace(oneTrace(result));
  if (!isWord(root.output)) failState('Historical state query did not return exactly one uint256 word.');
  assertFrame(root, { type: 'CALL', from: sender, to: query.to, input: query.data, childCount: 1 });
  const implementation = root.calls[0];
  const positionBalance = query.to !== USDC && BALANCE.test(query.data);
  assertFrame(implementation, { type: 'DELEGATECALL', from: query.to, to: IMPLEMENTATIONS[query.to], input: query.data, output: root.output, childCount: positionBalance ? 1 : 0 });
  if (positionBalance) {
    const indexInput = (query.to === HUSDC ? '0xd15e0053' : '0x386497fd') + USDC.slice(2).padStart(64, '0');
    const pool = implementation.calls[0];
    assertFrame(pool, { type: 'STATICCALL', from: query.to, to: POOL, input: indexInput, childCount: 1 });
    if (!isWord(pool.output) || BigInt(pool.output) === 0n) failState('Historical position query returned an invalid reserve index.');
    assertFrame(pool.calls[0], { type: 'DELEGATECALL', from: POOL, to: POOL_IMPLEMENTATION, input: indexInput, output: pool.output, childCount: 0 });
  }
  return { amount: BigInt(root.output), gasUsed: BigInt(root.gasUsed) };
}

export { semanticTrace, validateQuery, hasContractLifecycle };
