// Fixed initial declarations only. Importing or building these fixtures never
// invokes product execution, EELS apply_body, or another EVM.
import assert from 'node:assert/strict';
import {createTx,createTxFromRLP} from '../../engines/fixture-evm/node_modules/@ethereumjs/tx/dist/esm/index.js';
import {getCalldataFloorGas} from '../../engines/fixture-evm/node_modules/@ethereumjs/tx/dist/esm/util/intrinsic.js';
import {createMPT} from '../../engines/local-evm/node_modules/@ethereumjs/mpt/dist/esm/index.js';
import {RLP} from '../../engines/local-evm/node_modules/@ethereumjs/rlp/dist/esm/index.js';
import {bytesToHex,hexToBytes} from '../../engines/local-evm/node_modules/@ethereumjs/util/dist/esm/index.js';
import {feeFixture,feeCommon,TEST_KEY,TX_SENDER,TARGET} from '../../engines/local-evm/test/fee-fixture.js';
import {amsterdamExecutionFixture} from '../../engines/local-evm/test/amsterdam-execution-fixture.js';
import {initcode,createdAddress,word} from '../../engines/local-evm/test/lifecycle-fixture.js';
import {program,createParts,callBytes,HELPER} from '../../engines/local-evm/test/amsterdam-creation-attempts-fixture.js';
import {allocationRoot,normalizeAllocation} from '../amsterdam-storage-creation-v033/observations.mjs';

export const CASES=Object.freeze([
  {id:'shanghai_root_create_old_equal',fork:'Shanghai',kind:'CREATE',rootCreate:true,scenario:'success'},
  {id:'cancun_internal_create_old_equal',fork:'Cancun',kind:'CREATE',rootCreate:false,scenario:'success'},
  {id:'prague_root_create_old_equal',fork:'Prague',kind:'CREATE',rootCreate:true,scenario:'success'},
  {id:'osaka_internal_create2_old_equal',fork:'Osaka',kind:'CREATE2',rootCreate:false,scenario:'success'},
  {id:'osaka_constructor_revert_caught',fork:'Osaka',kind:'CREATE2',rootCreate:false,scenario:'constructor_revert'},
  {id:'osaka_ancestor_revert_caught',fork:'Osaka',kind:'CREATE2',rootCreate:false,scenario:'ancestor_revert'},
  {id:'amsterdam_root_constructor_revert',fork:'Amsterdam',kind:'CREATE',rootCreate:true,scenario:'constructor_revert'},
  {id:'amsterdam_ancestor_revert_caught',fork:'Amsterdam',kind:'CREATE2',rootCreate:false,scenario:'ancestor_revert'},
].map(Object.freeze));
export const SYSTEMS=Object.freeze(['0x00000961ef480eb55e80d19ad83579a64c007002','0x0000bbddc7ce488642fb579f8b00f3a590007251','0x0000bff46984e3725691fa540a8c7589300d8282','0x000064d678505ad48f8ccb093bc65613800e8282']);
export const SENTINEL_RUNTIME='6000546000526001546020526002546040526103df5460605260806000f3';
export const CONSTRUCTOR_PREFIX='6103df546001556103e7600055602a600255';
export const REVERT='60006000fd',DIRTY_CALLER='6037600055',RESTORE_CALLER='600c600055';
export const PRODUCT_LIMITS=Object.freeze({wallMs:12000,requestMs:1000,drainMs:1000,killWaitMs:1000,inputs:Object.freeze({wallMs:10000}),execution:Object.freeze({wallMs:10000})});
export const initialStorage=()=>({[word(0)]:999n,[word(991)]:123456n});
export async function storageRoot(storage){const trie=await createMPT({useKeyHashing:true});for(const[k,v]of Object.entries(storage)){const n=BigInt(v);if(n===0n)continue;const s=n.toString(16);await trie.put(hexToBytes(k),RLP.encode(hexToBytes('0x'+s.padStart(Math.ceil(s.length/2)*2,'0'))));}return bytesToHex(trie.root());}

export async function fixture(index,scaffold=true){
  assert(Number.isSafeInteger(index)&&index>=0&&index<CASES.length);const c=CASES[index];
  const init=c.scenario==='constructor_revert'?CONSTRUCTOR_PREFIX+REVERT:initcode(SENTINEL_RUNTIME,CONSTRUCTOR_PREFIX);
  const creator=c.rootCreate?TX_SENDER:c.scenario==='ancestor_revert'?HELPER:TARGET;
  const target=createdAddress({creator,nonce:c.rootCreate?1n:7n,kind:c.kind,init});
  const old={nonce:0n,balance:17n,code:'0x',storage:initialStorage()};
  const {copy,op}=createParts(init,{kind:c.kind,value:5});
  const body=program([DIRTY_CALLER,...copy,op+'600052'+RESTORE_CALLER+'60206000f3',{label:'init'},init]);
  const helper=program(['602b600155',...copy,op+'50'+REVERT,{label:'init'},init]);
  const root='0x'+DIRTY_CALLER+callBytes(HELPER)+RESTORE_CALLER+'602a60005260206000f3';
  const accounts={
    [target]:old,
    ...(c.scenario==='ancestor_revert'?{[HELPER]:{nonce:7n,balance:1000n,code:helper,storage:{[word(1)]:5n}}}:{}),
    ...(scaffold?Object.fromEntries(SYSTEMS.map(address=>[address,{nonce:1n,balance:0n,code:'0x00',storage:{}}])):{}),
  };
  const options={accounts,...(c.rootCreate?{to:null,value:'5',data:'0x'+init}:{target:{nonce:7n,balance:1000n,code:c.scenario==='ancestor_revert'?root:body,storage:{[word(0)]:12n}}})};
  const f=c.fork==='Amsterdam'?await amsterdamExecutionFixture(options):await feeFixture({fork:c.fork.toLowerCase(),...options});
  return{...f,common:f.common??feeCommon(f),chainId:c.fork==='Amsterdam'?11155111:1,creator,creationTarget:target,init};
}

export async function declaration(index){
  const c=CASES[index];assert(c);const f=await fixture(index),original=await fixture(index,false),r=f.request,h=f.header;
  const allocation=normalizeAllocation(f.allocation),originalAllocation=normalizeAllocation(original.allocation);
  const tx=createTx({type:2,chainId:BigInt(f.chainId),nonce:1n,gasLimit:BigInt(r.gas),to:r.to??undefined,value:BigInt(r.value),data:r.data,
    maxFeePerGas:BigInt(r.fees.maxFeePerGas),maxPriorityFeePerGas:BigInt(r.fees.maxPriorityFeePerGas)},{common:f.common}).sign(hexToBytes(TEST_KEY));
  const signedBytes=bytesToHex(tx.serialize()),decoded=createTxFromRLP(hexToBytes(signedBytes),{common:f.common});
  assert(decoded.verifySignature());assert.equal(decoded.getSenderAddress().toString(),r.from);assert.equal(bytesToHex(decoded.serialize()),signedBytes);
  assert.equal(await allocationRoot(allocation),h.stateRoot);assert.equal(await allocationRoot(originalAllocation),original.header.stateRoot);
  const historicalFloor=['Prague','Osaka','Amsterdam'].includes(c.fork);
  const environment={currentCoinbase:h.miner,currentGasLimit:h.gasLimit,currentNumber:h.number,currentTimestamp:h.timestamp,currentRandom:h.mixHash,currentDifficulty:h.difficulty,currentBaseFee:h.baseFeePerGas,withdrawals:[],
    ...(c.fork==='Shanghai'?{}:{currentExcessBlobGas:h.excessBlobGas,parentBeaconBlockRoot:h.parentBeaconBlockRoot}),...(c.fork==='Amsterdam'?{slotNumber:h.slotNumber}:{})};
  return JSON.parse(JSON.stringify({index,...c,chainId:f.chainId,request:r,header:h,headerHash:h.hash,
    originalAllocation,originalStateRoot:original.header.stateRoot,allocation,initialStateRoot:h.stateRoot,
    target:f.creationTarget,creator:f.creator,initialTargetStorageRoot:await storageRoot(allocation[f.creationTarget].storage),
    sentinel:{initcode:'0x'+f.init,runtime:'0x'+SENTINEL_RUNTIME,slots:['0','1','2','991']},
    probes:{oldEqualWrite:{slot:word(0),value:word(999)},hiddenRead:{slot:word(991),destinationSlot:word(1)},freshWrite:{slot:word(2),value:word(42)},
      callerOriginal:c.rootCreate?null:{address:TARGET,slot:word(0),initial:word(12),intermediate:word(55),restore:word(12)},
      ancestor:c.scenario==='ancestor_revert'?{address:HELPER,slot:word(1),initial:word(5),intermediate:word(43)}:null},
    environment,transaction:tx.toJSON(),signedBytes,transactionHash:bytesToHex(tx.hash()),transactionBody:bytesToHex(RLP.encode([hexToBytes(signedBytes)])),
    inputGas:{intrinsic:tx.getIntrinsicGas().toString(),calldataFloor:historicalFloor?getCalldataFloorGas(tx).toString():null},
    amendment:{kind:'identical_inert_system_STOP_accounts',addresses:[...SYSTEMS],originalAccountRowsChanged:false,actualDeployedChainState:false}}));
}
