import { plain, DATA, ZERO, LIMITS } from './common.js';
export class ArbitrumInputError extends Error { constructor(message){super(message);this.name='ArbitrumInputError';this.code='ARBITRUM_INPUT';} }
export function validateArbitrumCall(input) {
  try { plain(input,['chainId','from','to','data','value','gas','block']); } catch {throw new ArbitrumInputError('Only chainId, from, to, data, value, gas and block are accepted.');}
  if(input.chainId!==42161&&input.chainId!=='42161')throw new ArbitrumInputError('Only Arbitrum One chain 42161 is supported.');
  for(const k of ['from','to'])if(typeof input[k]!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(input[k]))throw new ArbitrumInputError(k+' must be a 20-byte address.');
  if(input.from.toLowerCase()===ZERO)throw new ArbitrumInputError('The zero address cannot be the sender.');
  if(typeof input.data!=='string'||input.data.length>2+2*LIMITS.calldataBytes||!DATA.test(input.data.toLowerCase()))throw new ArbitrumInputError('data must be even-length hexadecimal calldata of at most 32 KiB.');
  const value=Object.hasOwn(input,'value')?input.value:'0', gas=Object.hasOwn(input,'gas')?input.gas:'2000000', block=Object.hasOwn(input,'block')?input.block:'latest';
  if(typeof value!=='string'||!/^(?:0|[1-9][0-9]{0,77})$/.test(value)||BigInt(value)>=(1n<<256n))throw new ArbitrumInputError('value must be a canonical decimal uint256 string.');
  if(typeof gas!=='string'||!/^[1-9][0-9]{4,6}$/.test(gas)||BigInt(gas)<21000n||BigInt(gas)>5000000n)throw new ArbitrumInputError('gas must be a canonical decimal string from 21000 to 5000000.');
  if(typeof block!=='string'||!(block==='latest'||/^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/.test(block)))throw new ArbitrumInputError('block must be latest or a canonical hexadecimal block number.');
  return Object.freeze({chainId:42161,from:input.from.toLowerCase(),to:input.to.toLowerCase(),data:input.data.toLowerCase(),value,gas,block});
}
