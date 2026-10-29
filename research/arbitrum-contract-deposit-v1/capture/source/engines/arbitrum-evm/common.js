import { createHash } from 'node:crypto';
import { types } from 'node:util';
export const ENDPOINT = 'https://arb1.arbitrum.io/rpc';
export const LIMITS = Object.freeze({ calls:20,responseBytes:4*1024*1024,totalBytes:16*1024*1024,requestBytes:128*1024,requestMs:25000,overallMs:120000,viemDispatchMs:110000,finalReserveCalls:1,assets:12,calldataBytes:32768,outputBytes:64*1024*1024 });
export const ADDRESS = /^0x[0-9a-f]{40}$/;
export const HASH = /^0x[0-9a-f]{64}$/;
export const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/;
export const DATA = /^0x(?:[0-9a-f]{2})*$/;
export const WORD = /^0x[0-9a-f]{64}$/;
export const ZERO = '0x'+'0'.repeat(40);
export const ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
export const clone = value => JSON.parse(json(value));
export const hex = value => '0x'+BigInt(value).toString(16);
export function plain(value, allowed) {
  if (!value || typeof value!=='object' || types.isProxy(value) || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new Error('Plain data record required.');
  for(const key of Reflect.ownKeys(value)){const d=Object.getOwnPropertyDescriptor(value,key);if(typeof key!=='string'||!d.enumerable||!Object.hasOwn(d,'value')||(allowed&&!allowed.includes(key)))throw new Error('Unexpected data field.');}
}
export function safeError(error, fallback='ARBITRUM_UNAVAILABLE') { return {code: typeof error?.arbitrumCode==='string' ? error.arbitrumCode : fallback,message: ({ARBITRUM_CANCELLED:'The preview was cancelled.',ARBITRUM_BUDGET:'The preview budget was exhausted.',ARBITRUM_EVIDENCE:'Provider observations could not be consistently bound.',ARBITRUM_HEADER:'The selected complete header could not be confirmed.',ARBITRUM_DRAIN:'Pending provider operations did not settle.',ARBITRUM_UNAVAILABLE:'The provider preview is unavailable.'})[error?.arbitrumCode??fallback]??'The provider preview is unavailable.'}; }
export function fail(code){throw Object.assign(new Error(code),{arbitrumCode:code});}
