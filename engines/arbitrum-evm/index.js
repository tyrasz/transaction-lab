import assert from 'node:assert/strict';
import { createPublicClient,custom } from 'viem';
import { arbitrum } from 'viem/chains';
import { simulateCalls } from 'viem/actions';
import { validateArbitrumCall } from './validate.js';
import { createPolicy } from './policy.js';
import { createTransport } from './transport.js';
import { projectObservations } from './projection.js';
import { ENDPOINT,LIMITS,clone,json,safeError,fail,QUANTITY,DATA } from './common.js';
export { validateArbitrumCall,ArbitrumInputError } from './validate.js';
export const ARBITRUM_CAPABILITIES=Object.freeze({available:true,chainId:42161,status:'experimental',operation:'provider_unsigned_single_call',library:'viem@2.57.13',blockSelection:['latest','canonical_hex_number'],gas:{default:'2000000',minimum:'21000',maximum:'5000000'},limits:LIMITS,inventoryComplete:false,consensusVerified:false,feesVerified:false,destinationCreditVerified:false,securityAssessed:false});
const limitations=Object.freeze([
  'Provider observations only; Arbitrum consensus, state proofs, deployed implementation identity and Nitro execution are not independently verified.',
  'Discovery covers sender-related Transfer emitters plus the call destination, not a complete asset or position inventory. Missing and failed probes are unknown.',
  'Original execution is an unsigned zero-gas-price call in synthetic successor blocks, with no signed transaction admission or actual Arbitrum fee reproduction.',
  'The library adds a zero-address call and separate measurement blocks. Its code-only STATICCALL helper overrides are retained in RPC evidence; no caller funds, allowance or code are replaced.',
  'A token pre-read returning empty data is not an observed zero balance. Only successful exact 32-byte pre/post results produce measured amounts.',
  'Symbols and decimals are untrusted provider-returned metadata. Native/token balances concern only the declared sender; allowance and protocol position changes are not measured.',
  'A simulated source execution or balance change does not establish bridge attestation, destination settlement, credited amount or security.',
]);
export async function simulateArbitrumCall(input,{fetchImpl=fetch,signal}={}){
  const request=validateArbitrumCall(input),policy=createPolicy(request),transport=createTransport({policy,fetchImpl,signal});
  const report={kind:'arbitrum_provider_preview',schemaVersion:'1.0',request,status:'unavailable',error:null,
    source:{kind:'provider_simulation',chainId:42161,provider:ENDPOINT,providerURL:ENDPOINT,library:{name:'viem',version:'2.57.13'},requestedBlock:request.block,blockNumber:null,blockHash:null,header:null,headerConfirmed:false,blockBinding:'number_with_header_reread',twoPassConsistent:false,consensusVerified:false,originalTransactionReplay:false,profile:'unsigned_zero_gas_price_synthetic_successor_blocks'},
    execution:{status:'unavailable',data:null,gasUsed:null,logs:[],error:null},assetChanges:[],coverage:{scope:'partial_provider_observed',inventoryComplete:false,discoveredAssets:0,measuredAssets:0,unverifiedAssets:0,feesVerified:false,destinationCreditVerified:false,securityAssessed:false,limitations:[...limitations]},
    prechecks:[],rawViem:{status:'unavailable',result:null,error:null},rpcEvidence:[],usage:null};
  let cause=null,drain=null;
  try{
    if(await transport.request({method:'eth_chainId',params:[]})!=='0xa4b1')fail('ARBITRUM_EVIDENCE');
    const header=await transport.request({method:'eth_getBlockByNumber',params:[request.block,false]});policy.pin(header);
    Object.assign(report.source,{blockNumber:BigInt(header.number).toString(),blockHash:header.hash,header:clone(header)});
    transport.setPhase('prechecks');
    for(const method of ['eth_getBalance','eth_getCode']){
      const row={method,status:'unavailable',value:null};try{const value=await transport.request({method,params:[request.from,header.number]});assert.match(value,method==='eth_getBalance'?QUANTITY:DATA);row.status='observed';row.value=value;}catch{row.reason='precheck_unavailable';}report.prechecks.push(row);
    }
    transport.setPhase('viem');
    const client=createPublicClient({chain:arbitrum,batch:{multicall:false},ccipRead:false,cacheTime:0,transport:custom(transport,{retryCount:0})});
    try{const result=await simulateCalls(client,{account:request.from,blockNumber:BigInt(header.number),calls:[{to:request.to,data:request.data,value:BigInt(request.value),gas:BigInt(request.gas),gasPrice:0n}],traceAssetChanges:true,traceTransfers:true,validation:false});report.rawViem={status:'returned',result:clone(result),error:null};}
    catch(e){report.rawViem.error=safeError(e);}
    finally{transport.endPhase();drain=await transport.drain();}
    transport.setPhase('final');
    try{const final=await transport.request({method:'eth_getBlockByNumber',params:[header.number,false]});assert.deepEqual(final,header);report.source.headerConfirmed=true;}catch{fail(signal?.aborted?'ARBITRUM_CANCELLED':'ARBITRUM_HEADER');}
  }catch(e){cause=safeError(e);}
  finally{transport.endPhase();drain=await transport.drain();transport.finish();}
  const usage=transport.snapshot();report.rpcEvidence=usage.evidence;delete usage.evidence;report.usage={...usage,drain};report.coverage.discoveredAssets=policy.state.assets.length;
  try{
    if(signal?.aborted)fail('ARBITRUM_CANCELLED');if(!drain?.complete)fail('ARBITRUM_DRAIN');if(usage.hardFailure)fail(usage.hardFailure);if(!usage.withinBounds||usage.viemStopped||usage.discarded.length)fail('ARBITRUM_BUDGET');if(!report.source.headerConfirmed)fail('ARBITRUM_HEADER');if(cause)throw Object.assign(new Error(),{arbitrumCode:cause.code});
    const projected=projectObservations({request,policy,evidence:report.rpcEvidence});Object.assign(report,projected);report.source.twoPassConsistent=true;
    const measured=report.assetChanges.filter(a=>a.status==='measured').length;Object.assign(report.coverage,{discoveredAssets:policy.state.assets.length,measuredAssets:measured,unverifiedAssets:report.assetChanges.length-measured});
    report.status=report.coverage.unverifiedAssets||report.rawViem.error?'partial':'completed';
  }catch(e){report.error=safeError(e,'ARBITRUM_EVIDENCE');}
  if(Buffer.byteLength(json(report))>LIMITS.outputBytes){report.status='unavailable';report.error=safeError({arbitrumCode:'ARBITRUM_BUDGET'});report.execution={status:'unavailable',data:null,gasUsed:null,logs:[],error:null};report.assetChanges=[];report.rawViem={status:'withheld_output_limit',result:null,error:report.error};report.coverage.measuredAssets=0;}
  return report;
}
