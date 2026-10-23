import { formatUnits } from './analyze.js';

const POOL = '0x00a89d7a5a02160f20150ebea7a2b5e4879a1a8b';
const USDC = '0xb88339cb7199b77e23db6e890353e22632ba630f';
const HUSDC = '0x744e4f26ee30213989216e1632d9be3547c4885b';
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const WORD = /^0x[0-9a-f]{64}$/i;
const UINT = /^(?:0x[0-9a-f]+|[0-9]+)$/i;
const CODE = /^0x(?:[0-9a-f]{2})*$/i;
const ZERO_WORD = `0x${'0'.repeat(64)}`;
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const uint = value => typeof value === 'string' && UINT.test(value) ? BigInt(value) : (Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null);
const hex = value => `0x${BigInt(value).toString(16)}`;
const lower = value => typeof value === 'string' ? value.toLowerCase() : '';

class BalanceValidationError extends Error {}
function failure(message) { throw new BalanceValidationError(message); }

function publicRpcFailure(error) {
  const descriptions = {
    RPC_TIMEOUT: 'The balance measurement provider timed out.',
    RPC_CONNECTION_ERROR: 'The balance measurement provider could not be reached.',
    RPC_HTTP_ERROR: 'The balance measurement provider returned an HTTP error.',
    RPC_EXECUTION_ERROR: 'The balance measurement provider rejected a read-only RPC request.',
    RPC_INVALID_RESPONSE: 'The balance measurement provider returned an invalid response.',
    RPC_RESPONSE_TOO_LARGE: 'The balance measurement response exceeded its size limit.',
    METHOD_NOT_ALLOWED: 'The balance measurement RPC method is not enabled.',
  };
  const code = Object.hasOwn(descriptions, error?.code) ? error.code : 'RPC_ERROR';
  return { code, message: descriptions[code] ?? 'The balance measurement RPC request failed.', ...(Number.isSafeInteger(error?.detail?.rpcCode) ? { rpcCode: error.detail.rpcCode } : {}) };
}

function decodeScope(request, analysis) {
  if (uint(request?.chainId) !== 999n || lower(request?.to) !== POOL || uint(request?.value) !== 0n || !ADDRESS.test(request?.from ?? '')) return null;
  if (analysis?.protocol?.name !== 'Hyperlend' || analysis.protocol.operation !== 'supply' || analysis.protocol.asset !== USDC || analysis.coverage?.status !== 'supported' || analysis.execution?.status !== 'success') return null;
  if (!/^0x617ba037[0-9a-f]{256}$/i.test(request.data ?? '')) return null;
  const args = request.data.slice(10);
  if (args.slice(0, 64).toLowerCase() !== USDC.slice(2).padStart(64, '0')) return null;
  const amount = BigInt(`0x${args.slice(64, 128)}`);
  if (!/^0{24}/i.test(args.slice(128, 192))) return null;
  const beneficiary = `0x${args.slice(152, 192)}`.toLowerCase();
  if (beneficiary !== analysis.protocol.onBehalfOf || amount.toString() !== analysis.protocol.amountRaw || BigInt(`0x${args.slice(192)}`) > 65535n) return null;
  return { sender: request.from.toLowerCase(), beneficiary, amount };
}

function buildOverrides(diff) {
  if (!isObject(diff?.pre) || !isObject(diff?.post)) failure('Provider returned no valid pre/post state diff.');
  const beforeAccounts = Object.keys(diff.pre);
  const afterAccounts = Object.keys(diff.post);
  if (beforeAccounts.some(account => !Object.hasOwn(diff.post, account)) || afterAccounts.some(account => !Object.hasOwn(diff.pre, account))) {
    failure('Account creation or deletion is outside this balance measurement adapter.');
  }
  if (beforeAccounts.length > 100) failure('State diff exceeds the bounded Hyperlend adapter scope.');
  const overrides = {};
  let totalSlots = 0;
  for (const account of beforeAccounts) {
    if (!ADDRESS.test(account)) failure('State diff contains an invalid account address.');
    const pre = diff.pre[account];
    const post = diff.post[account];
    if (!isObject(pre) || !isObject(post)) failure('State diff contains an invalid account record.');
    if ((pre.code !== undefined && (typeof pre.code !== 'string' || !CODE.test(pre.code))) || (post.code !== undefined && (typeof post.code !== 'string' || !CODE.test(post.code)))) failure('State diff contains malformed contract code.');
    if (post.code !== undefined && lower(post.code) !== lower(pre.code)) failure('Contract code changes are outside this balance measurement adapter.');
    const override = {};
    for (const field of ['balance', 'nonce']) {
      if (pre[field] !== undefined && uint(pre[field]) === null) failure(`State diff contains malformed ${field}.`);
      if (post[field] !== undefined) {
        const value = uint(post[field]);
        if (value === null || value > (1n << 256n) - 1n) failure(`State diff contains malformed ${field}.`);
        override[field] = hex(value);
      }
    }
    if ((pre.storage !== undefined && !isObject(pre.storage)) || (post.storage !== undefined && !isObject(post.storage))) failure('State diff contains malformed storage.');
    const before = pre.storage ?? {};
    const after = post.storage ?? {};
    const slots = new Set([...Object.keys(before), ...Object.keys(after)]);
    totalSlots += slots.size;
    if (totalSlots > 2000) failure('State diff contains too many slots for this bounded adapter.');
    if (slots.size) {
      override.stateDiff = {};
      for (const slot of slots) {
        if (!WORD.test(slot) || (before[slot] !== undefined && !WORD.test(before[slot])) || (after[slot] !== undefined && !WORD.test(after[slot]))) failure('State diff contains malformed storage slots.');
        // In diffMode, a slot present only in pre was cleared by execution.
        override.stateDiff[slot] = after[slot] ?? ZERO_WORD;
      }
    }
    if (Object.keys(override).length) overrides[account] = override;
  }
  if (!Object.keys(overrides).length) failure('The successful deposit produced no usable state changes.');
  return overrides;
}

/** Read token balances on the same pinned state, then its traced ephemeral post-state. */
export async function measureBalances({ request, block, rpc, metadata = {}, analysis }) {
  const evidence = { request: [], response: [] };
  const warnings = [
    'Balances are measured by calling the configured USDC and hUSDC contracts before and after an ephemeral state diff at the same block hash and timestamp.',
    'This measurement covers the submitting account and deposit beneficiary for these two tokens. It does not assess transaction security or predict future blocks.',
  ];
  const base = { status: 'not_applicable', basis: 'prestate_diff_balanceOf', assets: [], warnings, evidence };
  const scope = decodeScope(request, analysis);
  if (!scope) return { ...base, warnings: ['Balance measurement is limited to successful, reconciled Hyperlend USDC supply simulations.'] };
  async function call(method, params) {
    evidence.request.push({ method, params });
    try {
      const result = await rpc.call(method, params);
      evidence.response.push({ method, result });
      return result;
    } catch (error) {
      const publicError = publicRpcFailure(error);
      evidence.response.push({ method, error: publicError });
      throw new BalanceValidationError(publicError.message);
    }
  }
  try {
    if (!WORD.test(block?.hash ?? '') || uint(block?.number) === null || uint(block?.timestamp) === null) failure('A complete pinned block identity is required for balance measurement.');
    for (const token of [USDC, HUSDC]) if (metadata[token]?.decimals !== 6) failure('Verified six-decimal metadata is required for USDC and hUSDC.');
    const pinned = { blockHash: block.hash.toLowerCase(), requireCanonical: true };
    const header = await call('eth_getBlockByHash', [block.hash, false]);
    if (lower(header?.hash) !== pinned.blockHash || uint(header?.number) !== uint(block.number) || uint(header?.timestamp) !== uint(block.timestamp)) failure('Provider block header does not match the pinned execution identity.');
    const tx = { from: scope.sender, to: request.to, data: request.data, value: '0x0', gas: '0x4c4b40' };
    const diff = await call('debug_traceCall', [tx, pinned, { tracer: 'prestateTracer', timeout: '15s', tracerConfig: { diffMode: true } }]);
    const overrides = buildOverrides(diff);
    const assets = [];
    const accounts = [...new Set([scope.sender, scope.beneficiary])];
    for (const account of accounts) for (const token of [USDC, HUSDC]) {
      const query = { from: scope.sender, to: token, data: `0x70a08231${account.slice(2).padStart(64, '0')}`, gas: '0x493e0' };
      const before = await call('eth_call', [query, pinned]);
      const after = await call('eth_call', [query, pinned, overrides]);
      if (typeof before !== 'string' || typeof after !== 'string' || !WORD.test(before) || !WORD.test(after)) failure('balanceOf did not return exactly one uint256 word.');
      const beforeRaw = BigInt(before);
      const afterRaw = BigInt(after);
      const deltaRaw = afterRaw - beforeRaw;
      assets.push({
        asset: { ...metadata[token], address: token, type: 'ERC20' }, account,
        beforeRaw: beforeRaw.toString(), afterRaw: afterRaw.toString(), deltaRaw: deltaRaw.toString(),
        before: formatUnits(beforeRaw, 6), after: formatUnits(afterRaw, 6), delta: formatUnits(deltaRaw, 6),
      });
    }
    const senderUSDC = assets.find(item => item.account === scope.sender && item.asset.address === USDC);
    const beneficiaryHUSDC = assets.find(item => item.account === scope.beneficiary && item.asset.address === HUSDC);
    if (BigInt(senderUSDC.deltaRaw) !== -scope.amount) failure('Measured USDC balance change disagrees with the successful supply principal.');
    const impliedPrincipal = uint(analysis.protocol.mintEventImpliedPrincipalRaw);
    if (impliedPrincipal === null || BigInt(beneficiaryHUSDC.deltaRaw) !== impliedPrincipal) failure('Measured hUSDC change disagrees with the traced Mint value minus accrued interest at the pinned context.');
    if (impliedPrincipal !== scope.amount) warnings.push('The measured hUSDC change differs from the requested USDC deposit and exactly matches the trace-reconciled Mint value minus accrued interest. The measured delta is preserved.');
    const confirmed = await call('eth_getBlockByNumber', [hex(block.number), false]);
    if (lower(confirmed?.hash) !== pinned.blockHash) failure('The pinned block is no longer canonical; no measured result is returned.');
    return {
      ...base, status: 'measured', assets,
      executionIdentity: { stateBlockHash: pinned.blockHash, blockNumber: uint(block.number).toString(), timestamp: uint(block.timestamp).toString(), stateBinding: 'block_hash', headerContext: 'unchanged', method: 'debug_traceCall/prestateTracer + eth_call/stateDiff' },
    };
  } catch (error) {
    const description = error instanceof BalanceValidationError ? error.message : 'An unexpected balance measurement failure occurred.';
    return { ...base, status: 'unavailable', warnings: [...warnings, `Balance measurement unavailable: ${description}`] };
  }
}
