// Initial-only lifecycle declarations. No execution or expected poststate.
import assert from 'node:assert/strict';
import {createTx,createTxFromRLP} from '../../engines/fixture-evm/node_modules/@ethereumjs/tx/dist/esm/index.js';
import {getCalldataFloorGas} from '../../engines/fixture-evm/node_modules/@ethereumjs/tx/dist/esm/util/intrinsic.js';
import {createMPT} from '../../engines/local-evm/node_modules/@ethereumjs/mpt/dist/esm/index.js';
import {RLP} from '../../engines/local-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js';
import {bytesToHex,hexToBytes} from '../../engines/local-evm/node_modules/@ethereumjs/util/dist/esm/index.js';
import {feeFixture,feeCommon,TEST_KEY,TX_SENDER,TARGET,COINBASE} from '../../engines/local-evm/test/fee-fixture.js';
import {amsterdamExecutionFixture} from '../../engines/local-evm/test/amsterdam-execution-fixture.js';
import {initcode,createdAddress,word} from '../../engines/local-evm/test/lifecycle-fixture.js';
import {program,createParts,callBytes} from '../../engines/local-evm/test/amsterdam-creation-attempts-fixture.js';
import {allocationRoot,normalizeAllocation} from '../amsterdam-storage-creation-v033/observations.mjs';

export const CASES=Object.freeze([
  {id:'shanghai_constructor_selfdestruct_self_fee',fork:'Shanghai',mode:'constructor_self'},
  {id:'osaka_constructor_selfdestruct_self_fee',fork:'Osaka',mode:'constructor_self'},
  {id:'amsterdam_constructor_selfdestruct_self_fee',fork:'Amsterdam',mode:'constructor_self'},
  {id:'amsterdam_constructor_sweep_refund_fee',fork:'Amsterdam',mode:'constructor_sweep'},
  {id:'shanghai_fresh_query_selfdestruct',fork:'Shanghai',mode:'query_self'},
  {id:'osaka_fresh_query_selfdestruct',fork:'Osaka',mode:'query_self'},
  {id:'amsterdam_fresh_query_selfdestruct',fork:'Amsterdam',mode:'query_self'},
  {id:'amsterdam_query_creation_revert_and_retain',fork:'Amsterdam',mode:'query_creation'},
].map(c=>Object.freeze({...c,kind:'CREATE2',rootCreate:false,scenario:'success'})));
export const SYSTEMS=Object.freeze(['0x00000961ef480eb55e80d19ad83579a64c007002','0x0000bbddc7ce488642fb579f8b00f3a590007251','0x0000bff46984e3725691fa540a8c7589300d8282','0x000064d678505ad48f8ccb093bc65613800e8282']);
export const PRODUCT_LIMITS=Object.freeze({wallMs:12000,requestMs:1000,drainMs:1000,killWaitMs:1000,inputs:Object.freeze({wallMs:10000}),execution:Object.freeze({wallMs:10000})});
export const BENEFICIARY='0x'+'aa'.repeat(20),QUERY_HELPER='0x'+'bb'.repeat(20),SELF_GETTER='0x'+'cc'.repeat(20),REVERT_GETTER='0x'+'dd'.repeat(20),RETAIN_GETTER='0x'+'ee'.repeat(20);
export const MAIN_SALT=word(123),QUERY_SALT=word(124),READ_TOPIC=word(0xc1);
// SLOAD991 is retained in slot1 and emitted as the actual 32-byte LOG1 payload.
export const CONSTRUCTOR_PREFIX='6103df54806001556000527f'+READ_TOPIC.slice(2)+'60206000a16103e7600055602a600255';
export const SELF_RUNTIME='30ff',SCALAR_RUNTIME='60025460005260206000f3';
const storage=()=>({[word(0)]:999n,[word(991)]:123456n});
const old=()=>({nonce:0n,balance:17n,code:'0x',storage:storage()});
const scalar=to=>({to,data:'0x70a08231'+TX_SENDER.slice(2).padStart(64,'0')});
const native=account=>({kind:'native_balance',account});
const return42='602a60005260206000f3';

export async function storageRoot(values){const trie=await createMPT({useKeyHashing:true});for(const[k,v]of Object.entries(values)){const n=BigInt(v);assert(n>=0n&&n<2n**256n);if(n===0n)continue;const s=n.toString(16);await trie.put(hexToBytes(k),RLP.encode(hexToBytes('0x'+s.padStart(Math.ceil(s.length/2)*2,'0'))));}return bytesToHex(trie.root());}
function queryHelper(init){const{copy,op}=createParts(init,{kind:'CREATE2',value:0,salt:QUERY_SALT});
  return program([...copy,op+'50'+'602a600052'+'600035',{push2:'revert'},'57'+'60206000f3',{label:'revert'},'5b60206000fd',{label:'init'},init]);}
function modeGetter(mode){return program(['60'+mode.toString(16).padStart(2,'0')+'600052',callBytes(QUERY_HELPER,{inputLength:32,gas:600000}),
  '3d602014',{push2:'data_ok'},'57'+'60006000fd',{label:'data_ok'},'5b6020600060003e60206000f3']);}

export async function fixture(index,scaffold=true){
  assert(Number.isSafeInteger(index)&&index>=0&&index<CASES.length);assert.equal(typeof scaffold,'boolean');const c=CASES[index];
  const runtime=c.mode==='query_self'?SELF_RUNTIME:c.mode==='query_creation'?SCALAR_RUNTIME:'';
  const init=c.mode==='constructor_self'?CONSTRUCTOR_PREFIX+'30ff':c.mode==='constructor_sweep'?CONSTRUCTOR_PREFIX+'73'+BENEFICIARY.slice(2)+'ff':initcode(runtime,CONSTRUCTOR_PREFIX);
  const target=createdAddress({creator:TARGET,kind:'CREATE2',salt:MAIN_SALT,init});
  const {copy,op}=createParts(init,{kind:'CREATE2',value:5,salt:MAIN_SALT});
  const postFunding=c.mode==='constructor_sweep'?callBytes(target,{value:3,gas:100000}):'';
  const factory=program([...copy,op+'600052'+postFunding+'60206000f3',{label:'init'},init]);
  const queryInit=CONSTRUCTOR_PREFIX+'30ff',queryTarget=c.mode==='query_creation'?createdAddress({creator:QUERY_HELPER,kind:'CREATE2',salt:QUERY_SALT,init:queryInit}):null;
  const coinbase=index<4?target:COINBASE;
  const accounts={
    [target]:old(),
    ...(index>=4?{[COINBASE]:{nonce:1n,balance:9n,code:'0x',storage:{}}}:{}),
    ...(c.mode==='query_self'?{[SELF_GETTER]:{nonce:1n,balance:0n,code:'0x'+callBytes(target,{gas:200000})+return42,storage:{}}}:{}),
    ...(queryTarget?{[queryTarget]:old(),[QUERY_HELPER]:{nonce:7n,balance:1000n,code:queryHelper(queryInit),storage:{}},
      [REVERT_GETTER]:{nonce:1n,balance:0n,code:modeGetter(1),storage:{}},[RETAIN_GETTER]:{nonce:1n,balance:0n,code:modeGetter(0),storage:{}}}:{}),
    ...(scaffold?Object.fromEntries(SYSTEMS.map(a=>[a,{nonce:1n,balance:0n,code:'0x00',storage:{}}])):{}),
  };
  assert(!Object.hasOwn(accounts,BENEFICIARY));
  const options={baseFee:7n,maxFee:13n,priorityFee:3n,coinbase,gas:'5000000',value:'0',data:'0x',
    target:{nonce:7n,balance:1000n,code:factory,storage:{}},accounts};
  const f=c.fork==='Amsterdam'?await amsterdamExecutionFixture(options):await feeFixture({fork:c.fork.toLowerCase(),...options});
  const queries=index<4?[native(TX_SENDER),native(TARGET),native(target),...(index===3?[native(BENEFICIARY)]:[])]:c.mode==='query_self'?
    [scalar(SELF_GETTER),native(target),native(TX_SENDER)]:[scalar(REVERT_GETTER),scalar(RETAIN_GETTER),native(queryTarget),native(target),native(TX_SENDER)];
  assert(queries.length<=8);assert(new Set([TARGET,target,QUERY_HELPER,SELF_GETTER,REVERT_GETTER,RETAIN_GETTER,BENEFICIARY,...SYSTEMS]).size===7+SYSTEMS.length);
  return{...f,common:f.common??feeCommon(f),chainId:c.fork==='Amsterdam'?11155111:1,creator:TARGET,creationTarget:target,init,runtime,queries,
    queryCreation:queryTarget?{creator:QUERY_HELPER,target:queryTarget,nonce:'7',salt:QUERY_SALT,initcode:'0x'+queryInit}:null};
}

export async function declaration(index){
  assert(Number.isSafeInteger(index)&&index>=0&&index<CASES.length);const c=CASES[index],f=await fixture(index),original=await fixture(index,false),r=f.request,h=f.header;
  const allocation=normalizeAllocation(f.allocation),originalAllocation=normalizeAllocation(original.allocation);
  const tx=createTx({type:2,chainId:BigInt(f.chainId),nonce:1n,gasLimit:BigInt(r.gas),to:r.to,value:BigInt(r.value),data:r.data,
    maxFeePerGas:BigInt(r.fees.maxFeePerGas),maxPriorityFeePerGas:BigInt(r.fees.maxPriorityFeePerGas)},{common:f.common}).sign(hexToBytes(TEST_KEY));
  const signedBytes=bytesToHex(tx.serialize()),decoded=createTxFromRLP(hexToBytes(signedBytes),{common:f.common});
  assert(decoded.verifySignature());assert.equal(decoded.getSenderAddress().toString(),r.from);assert.equal(bytesToHex(decoded.serialize()),signedBytes);
  assert.equal(await allocationRoot(allocation),h.stateRoot);assert.equal(await allocationRoot(originalAllocation),original.header.stateRoot);
  const environment={currentCoinbase:h.miner,currentGasLimit:h.gasLimit,currentNumber:h.number,currentTimestamp:h.timestamp,currentRandom:h.mixHash,currentDifficulty:h.difficulty,currentBaseFee:h.baseFeePerGas,withdrawals:[],
    ...(c.fork==='Shanghai'?{}:{currentExcessBlobGas:h.excessBlobGas,parentBeaconBlockRoot:h.parentBeaconBlockRoot}),...(c.fork==='Amsterdam'?{slotNumber:h.slotNumber}:{})};
  const queryTemplates=f.queries.map((q,index)=>q.kind==='native_balance'?{index,kind:'native_balance',account:q.account,phases:['before','after']}:
    {index,kind:'contract_call',request:{from:r.from,to:q.to,data:q.data,value:'0',gas:'1000000'},phases:['before','after']});
  return JSON.parse(JSON.stringify({index,...c,chainId:f.chainId,request:r,header:h,headerHash:h.hash,
    originalAllocation,originalStateRoot:original.header.stateRoot,allocation,initialStateRoot:h.stateRoot,
    target:f.creationTarget,creator:f.creator,initialTargetStorageRoot:await storageRoot(allocation[f.creationTarget].storage),
    sentinel:{initcode:'0x'+f.init,runtime:'0x'+f.runtime,slots:['0','1','2','991']},
    probes:{oldEqualWrite:{slot:word(0),value:word(999)},hiddenRead:{slot:word(991),destinationSlot:word(1),logTopic:READ_TOPIC},freshWrite:{slot:word(2),value:word(42)},
      lifecycle:{mode:c.mode,beneficiary:c.mode==='constructor_sweep'?BENEFICIARY:f.creationTarget,postCreationFunding:c.mode==='constructor_sweep'?'3':'0',feeRecipient:h.miner}},
    queries:f.queries,queryTemplates,queryCreation:f.queryCreation?{...f.queryCreation,initialStorageRoot:await storageRoot(allocation[f.queryCreation.target].storage)}:null,
    environment,transaction:tx.toJSON(),signedBytes,transactionHash:bytesToHex(tx.hash()),transactionBody:bytesToHex(RLP.encode([hexToBytes(signedBytes)])),
    inputGas:{intrinsic:tx.getIntrinsicGas().toString(),calldataFloor:c.fork==='Shanghai'?null:getCalldataFloorGas(tx).toString()},
    amendment:{kind:'identical_inert_system_STOP_accounts',addresses:[...SYSTEMS],originalAccountRowsChanged:false,actualDeployedChainState:false}}));
}
