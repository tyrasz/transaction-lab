import { RLP } from '@ethereumjs/rlp';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { ethereumCommon, ethereumQuantity } from './ethereum-profile.js';

const DATA = /^0x(?:[0-9a-f]{2})*$/i, QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/i;
const EMPTY_OMMERS = '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347';
const CORE = ['parentHash', 'sha3Uncles', 'miner', 'stateRoot', 'transactionsRoot', 'receiptsRoot', 'logsBloom', 'difficulty', 'number', 'gasLimit', 'gasUsed', 'timestamp', 'extraData', 'mixHash', 'nonce', 'baseFeePerGas', 'withdrawalsRoot'];
const CANCUN = ['blobGasUsed', 'excessBlobGas', 'parentBeaconBlockRoot'];
const EXTRAS = ['hash', 'size', 'transactions', 'uncles', 'withdrawals', 'totalDifficulty'];
const fail = message => { throw Object.assign(new Error(message), { code: 'LOCAL_HEADER_INVALID' }); };
const bytes = value => Uint8Array.from(Buffer.from(value.slice(2), 'hex'));
function data(value, length) {
  if (typeof value !== 'string' || !DATA.test(value) || (length !== undefined && value.length !== length * 2 + 2)) fail('Header byte field has an invalid encoding or width.');
  return bytes(value);
}
function integer(value, bits = 64) {
  if (typeof value !== 'string' || !QUANTITY.test(value) || value.length > 66) fail('Header integer is not a canonical RPC quantity.');
  const n = ethereumQuantity(value);
  if (n >= 1n << BigInt(bits)) fail('Header integer exceeds its field width.');
  if (n === 0n) return new Uint8Array();
  let h = n.toString(16); if (h.length % 2) h = '0' + h;
  return bytes('0x' + h);
}

/** Recompute the post-Merge Ethereum execution-header hash, including active
 * Shanghai/Cancun/Prague suffixes. EIP-4788 specifies the Cancun RLP order;
 * EIP-7685 appends requestsHash. This binds stateRoot to an externally chosen
 * block hash, not to consensus, finality, chain membership or body validity. */
export function verifyEthereumHeader({ header, expectedHash }) {
  if (!header || typeof header !== 'object' || Array.isArray(header) || ![Object.prototype, null].includes(Object.getPrototypeOf(header))) fail('A plain RPC header is required.');
  const allowed = [...CORE, ...CANCUN, 'requestsHash', ...EXTRAS];
  for (const key of Reflect.ownKeys(header)) {
    const d = Object.getOwnPropertyDescriptor(header, key);
    if (typeof key !== 'string' || !allowed.includes(key) || !d.enumerable || !Object.hasOwn(d, 'value')) fail('Unsupported header field or property.');
  }
  data(expectedHash, 32); data(header.hash, 32);
  if (header.hash.toLowerCase() !== expectedHash.toLowerCase()) fail('Returned header hash differs from the requested hash.');
  const common = ethereumCommon(header), cancun = common.isActivatedEIP(4844), prague = common.isActivatedEIP(7685);
  if (header.sha3Uncles?.toLowerCase() !== EMPTY_OMMERS || header.difficulty !== '0x0' || header.nonce !== '0x0000000000000000') fail('Post-Merge fixed header fields are inconsistent.');
  if (ethereumQuantity(header.gasUsed) > ethereumQuantity(header.gasLimit) || ethereumQuantity(header.gasLimit) === 0n) fail('Header gas quantities are inconsistent.');
  if ((!cancun && CANCUN.some(k => Object.hasOwn(header, k))) || (!prague && Object.hasOwn(header, 'requestsHash'))) fail('Header contains fields before their configured fork.');
  const values = CORE.map(key => {
    if (['difficulty', 'baseFeePerGas'].includes(key)) return integer(header[key], 256);
    if (['number', 'gasLimit', 'gasUsed', 'timestamp'].includes(key)) return integer(header[key]);
    if (key === 'extraData') { const result = data(header[key]); if (result.length > 32) fail('Header extraData exceeds 32 bytes.'); return result; }
    return data(header[key], key === 'miner' ? 20 : key === 'logsBloom' ? 256 : key === 'nonce' ? 8 : 32);
  });
  if (cancun) values.push(integer(header.blobGasUsed), integer(header.excessBlobGas), data(header.parentBeaconBlockRoot, 32));
  if (prague) values.push(data(header.requestsHash, 32));
  const encoded = RLP.encode(values), computed = '0x' + Buffer.from(keccak_256(encoded)).toString('hex');
  if (computed !== expectedHash.toLowerCase()) fail('Execution-header fields do not hash to the requested block.');
  return Object.freeze({ status: 'verified', blockHash: computed, stateRoot: header.stateRoot.toLowerCase(), parentHash: header.parentHash.toLowerCase(), number: ethereumQuantity(header.number).toString(), timestamp: ethereumQuantity(header.timestamp).toString(), hardfork: common.hardfork(), encodedBytes: encoded.length, headerFields: values.length, consensusVerified: false, finalityVerified: false, bodyVerified: false });
}
