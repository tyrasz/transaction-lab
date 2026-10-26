export class InputError extends Error {
  constructor(message, code = 'INVALID_INPUT') { super(message); this.code = code; }
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const UINT256_MAX = (1n << 256n) - 1n;

function object(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('A JSON object is required.');
}
function chain(value) {
  if (value !== 999 && value !== '999') throw new InputError('Only HyperEVM chain 999 is supported.', 'UNSUPPORTED_CHAIN');
  return 999;
}
function address(value, field) {
  if (typeof value !== 'string' || !ADDRESS.test(value)) throw new InputError(`${field} must be a 20-byte hex address.`);
  return value.toLowerCase();
}
export function validateSimulation(input) {
  object(input);
  for (const key of Object.keys(input)) {
    if (!['chainId', 'from', 'to', 'data', 'value', 'block'].includes(key)) throw new InputError(`Unsupported request field: ${key}`);
  }
  const chainId = chain(input.chainId);
  const from = address(input.from, 'from');
  const to = address(input.to, 'to');
  const data = input.data ?? '0x';
  if (typeof data !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(data)) throw new InputError('data must contain an even number of hexadecimal digits.');
  if (data.length > 2 + 32768 * 2) throw new InputError('Calldata exceeds the 32 KiB limit.');
  const value = input.value ?? '0';
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 78 || BigInt(value) > UINT256_MAX) {
    throw new InputError('value must be an unsigned decimal wei string within uint256.');
  }
  const block = input.block ?? 'latest';
  if (typeof block !== 'string' || !(block === 'latest' || /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,15})$/.test(block))) {
    throw new InputError('block must be latest or a hexadecimal block number.');
  }
  return { chainId, from, to, data: data.toLowerCase(), value, block: block.toLowerCase() };
}

export function validateReplay(input) {
  object(input);
  for (const key of Object.keys(input)) if (!['chainId', 'transactionHash'].includes(key)) throw new InputError(`Unsupported request field: ${key}`);
  const chainId = chain(input.chainId);
  if (typeof input.transactionHash !== 'string' || !HASH.test(input.transactionHash)) throw new InputError('transactionHash must be a 32-byte hex hash.');
  return { chainId, transactionHash: input.transactionHash.toLowerCase() };
}
