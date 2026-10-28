import { readFileSync } from 'node:fs';
import { RLP } from '@ethereumjs/rlp';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { proofFixture, A, B, word } from './proof-fixture.js';
export { A, B, word };
const template = JSON.parse(readFileSync(new URL('../../../reports/ethereum-local-reference/plan.json', import.meta.url))).header;
const order = ['parentHash','sha3Uncles','miner','stateRoot','transactionsRoot','receiptsRoot','logsBloom','difficulty','number','gasLimit','gasUsed','timestamp','extraData','mixHash','nonce','baseFeePerGas','withdrawalsRoot','blobGasUsed','excessBlobGas','parentBeaconBlockRoot','requestsHash'];
const integers = new Set(['difficulty','number','gasLimit','gasUsed','timestamp','baseFeePerGas','blobGasUsed','excessBlobGas']);
export function rehash(header) {
  const copy = structuredClone(header);
  copy.hash = '0x' + Buffer.from(keccak_256(RLP.encode(order.map(key => {
    let value = copy[key].slice(2);
    if (integers.has(key)) { value = BigInt(copy[key]) === 0n ? '' : BigInt(copy[key]).toString(16); if (value.length % 2) value = '0' + value; }
    return Buffer.from(value, 'hex');
  })))).toString('hex'); return copy;
}
// Synthetic linked headers, using a recorded header solely as a field template.
// These are deliberately not chain observations or consensus attestations.
export function chain(depth = 256, stateRoot = template.stateRoot) {
  const blocks = []; let parentHash = word(99);
  for (let offset = depth; offset >= 0; offset--) {
    const header = rehash({ ...template, stateRoot, parentHash,
      number: '0x' + (BigInt(template.number) - BigInt(offset)).toString(16),
      timestamp: '0x' + (BigInt(template.timestamp) - BigInt(offset * 12)).toString(16) });
    blocks.push(header); parentHash = header.hash;
  }
  return { header: blocks.at(-1), blocks, byHash: new Map(blocks.map(h => [h.hash,h])) };
}
export async function fixture(code, depth = 4, change) {
  const initial = await proofFixture({ requested: [], code }), linked = chain(depth, initial.input.stateRoot), calls = [];
  return { ...linked, calls, request: { from:B,to:A,data:'0x',value:'0',gas:'1000000' }, rpc: { async call(method,params,options) {
    calls.push({ method, params: structuredClone(params) });
    let result;
    if (method === 'eth_getBlockByHash') result = structuredClone(linked.byHash.get(params[0]));
    else {
      if (JSON.stringify(params.at(-1)) !== JSON.stringify({blockHash:linked.header.hash,requireCanonical:true})) throw Error('Unpinned test read');
      const proof = await proofFixture({code,address:params[0],requested:method==='eth_getProof'?params[1]:[]});
      result = method==='eth_getProof'?proof.input.proof:proof.input.code;
    }
    return change ? change({method,params,result,options}) : result;
  } } };
}
export const blockhashCode = distance => '0x6000' + (distance === 0 ? '43' : '60' + distance.toString(16).padStart(2,'0') + '4303') + '4060005260206000f3';
