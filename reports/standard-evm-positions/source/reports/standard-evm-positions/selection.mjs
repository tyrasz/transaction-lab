// Offline selection only: prior outputs identify a declared query, never supply
// state or amounts to the new simulation. Hash pins are part of this protocol.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

export const INPUT_FILES = Object.freeze([
  { path:'inputs/lending-plan.json', originalPath:'reports/ethereum-lending-local-reference/plan.json', sha256:'f9fb0e1b465bcf191185e1790204bf64a324634d98436ebb4a17f4cb6cd83288' },
  { path:'inputs/lending-manifest.json', originalPath:'reports/ethereum-lending-local-reference/manifest.json', sha256:'34b1e325ea08604705e50f06da81e442bb48cea017faf3058671e1e1a4e8f8c5' },
  { path:'inputs/deposit-plan.json', originalPath:'reports/ethereum-lending-local-reference/inputs/deposit-plan.json', sha256:'d458f18ebd659998296a05283e6987f945bb54d7fe5786551abf70c9d7640f8f' },
  { path:'inputs/morpho-product.json', originalPath:'reports/ethereum-lending-local-reference/morpho-kiln-usdc-deposit-product.json', sha256:'c20913cf524aff9e6b99ae098f050328fc013c7332c9c2768d2eb647e1191198' },
  { path:'inputs/sequence-plan.json', originalPath:'reports/standard-evm-sequence/plan.json', sha256:'14ad30f7f7031395ab2c4636ac649d0029a2ba3a9669ba1f61efa53afd4ae107' },
  { path:'inputs/sequence-manifest.json', originalPath:'reports/standard-evm-sequence/manifest.json', sha256:'6e861f3b9f21e8d878b5347a5990707a29fa32bca28a81bbce1cbf8ca473255c' },
]);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const BLUE='0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb';
export const VAULT='0xbeef01735c132ada46aa9aa4c54623caa92a64cb';
export const MARKET='0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64';
export const CALL_PATH=[1,11,1,52];
export function bindMorphoPosition(product, keccak) {
  const wires=product.transportEvidence.filter(x=>x.request.method==='debug_traceCall'&&x.request.params[2]?.tracer==='callTracer'&&x.request.params[0]?.gas==='0x4c4b40');
  assert.equal(wires.length,1);const wire=wires[0];
  assert.equal(sha(wire.requestText),wire.requestSha256);assert.deepEqual(JSON.parse(wire.requestText),wire.request);
  assert.equal(sha(wire.responseText),wire.transport.responseSha256);
  const envelope=JSON.parse(wire.responseText);assert.equal(envelope.id,wire.id);assert.equal(envelope.jsonrpc,'2.0');
  const found=[];
  function walk(frame,path=[],failed=false){
    failed ||= Boolean(frame.error||frame.revertReason);
    if(frame.to===BLUE&&frame.type==='CALL'&&frame.input?.startsWith('0xa99aad89'))found.push({frame,path,failed});
    (frame.calls??[]).forEach((child,index)=>walk(child,[...path,index],failed));
  }
  walk(envelope.result);assert.equal(found.length,1);
  const {frame,path,failed}=found[0];assert.deepEqual(path,CALL_PATH);assert.equal(failed,false);assert.equal(frame.from,VAULT);
  const words=frame.input.slice(10).match(/.{64}/g);assert.ok(words.length>=9);
  const marketParams='0x'+words.slice(0,5).join('');
  const market='0x'+Buffer.from(keccak(Buffer.from(marketParams.slice(2),'hex'))).toString('hex');assert.equal(market,MARKET);
  assert.equal('0x'+words[7].slice(24),VAULT);assert.equal(words[7].slice(0,24),'0'.repeat(24));
  assert.equal(frame.logs.length,1);const log=frame.logs[0];assert.equal(log.address,BLUE);
  assert.deepEqual(log.topics,['0xedf8870433c83823eb071d3df1caa8d008f12f6440918c20d75a3602cda30fe0',MARKET,...[VAULT,VAULT].map(x=>'0x'+x.slice(2).padStart(64,'0'))]);
  return {source:'inputs/morpho-product.json',wireId:wire.id,requestSha256:wire.requestSha256,responseSha256:wire.transport.responseSha256,
    callPath:path,signature:'supply((address,address,address,address,uint256),uint256,uint256,address,bytes)',selector:'0xa99aad89',marketParams,marketId:market,
    caller:frame.from,onBehalfOf:VAULT,event:{address:log.address,topics:log.topics,index:log.index,position:log.position},
    interpretation:'The inner vault owns this Blue position. The transaction sender holds outer wrapper shares; this query does not measure a sender-owned Blue position.'};
}
export function buildCases(files,keccak){
  const read=name=>{const item=INPUT_FILES.find(x=>x.path==='inputs/'+name), bytes=files[item.path];assert.equal(sha(bytes),item.sha256);return JSON.parse(bytes);};
  const lending=read('lending-plan.json'),deposits=read('deposit-plan.json'),product=read('morpho-product.json'),sequence=read('sequence-plan.json');
  for(const [manifestName,planName]of[['lending-manifest.json','lending-plan.json'],['sequence-manifest.json','sequence-plan.json']]){
    const manifest=read(manifestName);assert.equal(manifest.planSha256,INPUT_FILES.find(x=>x.path==='inputs/'+planName).sha256);
  }
  assert.deepEqual(deposits.cases.map(x=>x.id),['aave-usdc-supply-with-permit','morpho-kiln-usdc-deposit']);
  assert.deepEqual(lending.cases.map(x=>x.id),deposits.cases.map(x=>x.id));
  const [aave,morpho]=deposits.cases;
  function base(entry,index){
    const prior=lending.cases[index];assert.deepEqual(entry.request,prior.request);assert.equal(entry.blockHash,prior.header.hash);
    assert.equal(entry.request.value,'0x0');assert.equal(entry.request.gas,'0x4c4b40');
    const input={chainId:1,from:entry.request.from,to:entry.request.to,data:entry.request.data,value:'0',block:entry.blockHash};
    assert.deepEqual(input,prior.apiInput);return input;
  }
  const aaveBase=base(aave,0),morphoBase=base(morpho,1),binding=bindMorphoPosition(product,keccak);
  const accountQuery={kind:'aave_v3_user_account_data',contract:aaveBase.to,user:aaveBase.from};
  const positionQuery={kind:'morpho_blue_position',contract:BLUE,user:VAULT,marketId:MARKET};
  assert.notEqual(morphoBase.from,VAULT);assert.deepEqual(aave.queries.map(x=>x.id),['owner-usdc','beneficiary-aethusdc','reserve-usdc','owner-pool-usdc']);
  assert.deepEqual(morpho.queries.slice(0,3).map(x=>x.id),['owner-usdc','beneficiary-wrapper-shares','wrapper-vault-shares']);
  const tokenCalls=entry=>entry.queries.map(x=>structuredClone(x.call));
  const pair=sequence.cases.find(x=>x.id==='approve-then-supply');assert.ok(pair);assert.equal(pair.input.calls.length,2);
  assert.equal(pair.input.from,aaveBase.from);assert.equal(pair.input.block,aaveBase.block);assert.equal(pair.input.chainId,1);
  assert.ok(pair.input.calls.every(x=>!Object.hasOwn(x,'queries')));
  const sequenceInput=structuredClone(pair.input);
  sequenceInput.calls[0].queries=[tokenCalls(aave)[3],structuredClone(accountQuery)];
  sequenceInput.calls[1].queries=[...tokenCalls(aave),structuredClone(accountQuery)];
  const sharedProvenance={stateProfile:'unsigned_unpriced_historical_block_end',exactHistoricalReplay:false,priorOutputsUsedAsState:false,
    queryAmountsFrom:'New isolated before/after queries only; no saved trace/event values are used as measurements.',selection:'Fixed development inputs, not a representative cohort.'};
  const cases=[
    {id:'aave-position',profile:'single',route:'/api/evm/simulate',input:{...aaveBase,queries:[...tokenCalls(aave),accountQuery]},
      provenance:{...sharedProvenance,inputFile:'inputs/lending-plan.json',originalTransactionHash:lending.cases[0].originalTransactionHash,queryRoles:[...aave.queries.map(({id,label,roleEvidence})=>({id,label,roleEvidence})),{kind:accountQuery.kind,user:accountQuery.user,role:'transaction_sender_account_data'}]}},
    {id:'morpho-vault-position',profile:'single',route:'/api/evm/simulate',input:{...morphoBase,queries:[...tokenCalls(morpho).slice(0,3),positionQuery]},
      provenance:{...sharedProvenance,inputFile:'inputs/lending-plan.json',originalTransactionHash:lending.cases[1].originalTransactionHash,queryRoles:[...morpho.queries.slice(0,3).map(({id,label,roleEvidence})=>({id,label,roleEvidence})),{kind:positionQuery.kind,user:VAULT,role:'inner_vault_blue_position_not_sender_owned'}],morphoBinding:binding}},
    {id:'aave-approval-position-sequence',profile:'sequence',route:'/api/evm/simulate-sequence',input:sequenceInput,
      provenance:{...sharedProvenance,inputFile:'inputs/sequence-plan.json',inputCaseId:pair.id,syntheticUnsignedSequence:true,queryRoles:['Step 1: sender-to-Pool USDC allowance and sender Aave account data.','Step 2: original four Aave token queries and sender Aave account data.'],derivation:'Exact previous constructed approve/supply envelopes; only explicit mixed queries are added.'}},
  ];
  return cases.map(item=>{const requestText=JSON.stringify(item.input);return {...item,requestText,requestBytes:Buffer.byteLength(requestText),requestSha256:sha(requestText)};});
}
export async function selectedCases(root){
  const {keccak_256}=await import(pathToFileURL(resolve(root,'source/engines/standard-evm/node_modules/@noble/hashes/sha3.js')));
  return buildCases(Object.fromEntries(INPUT_FILES.map(x=>[x.path,readFileSync(resolve(root,x.path))])),keccak_256);
}
