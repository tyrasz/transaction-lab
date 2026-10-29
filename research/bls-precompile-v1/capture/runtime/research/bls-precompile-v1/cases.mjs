import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const PREFIX = 'research/bls-precompile-v1';
export const GETH_COMMIT = '1df30b18d9ed35ee9d28ffd4648442c2204554ad';
export const TOOLCHAIN_SHA = '791a91bca058b516b21a66097787f96959477958219eaee9dd20e73367b21333';
export const SOURCE_INVENTORY_SHA = '36e245fda711de52fe5e0b8c917d4bbbffd840ed7edfc0696f29cbb1f8b24dff';
export const FAMILIES = Object.freeze({blsG1Add:'0b',blsG1Mul:'0c',blsG1MultiExp:'0c',blsG2Add:'0d',blsG2Mul:'0e',blsG2MultiExp:'0e',blsMapG1:'10',blsMapG2:'11',blsPairing:'0f'});
export const FILES = Object.keys(FAMILIES).flatMap(n=>[n+'.json','fail-'+n+'.json']).sort();
export const FORKS = Object.freeze({prague:'1746612311',osaka:'1764798551'});
export const LIMITS = Object.freeze({calldataBytes:32768,gas:5000000,caseWallMs:5000,batchWallMs:90000,totalWallMs:600000,closeGraceMs:1000,stdoutBytes:32*1024*1024,stderrBytes:1024*1024,totalOutputBytes:256*1024*1024});
export const FROM='0x'+'11'.repeat(20), COINBASE='0x'+'55'.repeat(20);
export const sha = b=>createHash('sha256').update(b).digest('hex');
export const jsonBytes = x=>Buffer.from(JSON.stringify(x,null,2)+'\n');
export const addr = h=>'0x'+'0'.repeat(38)+h;
export const word = n=>'0x'+BigInt(n).toString(16).padStart(64,'0');

export function vectorRows(file,raw){
  assert(FILES.includes(file));const list=JSON.parse(raw);assert(Array.isArray(list)&&list.length>0&&list.length<200);
  const failure=file.startsWith('fail-'),family=file.replace(/^fail-/,'').replace(/\.json$/,'');
  return list.map((v,index)=>{
    assert(v&&typeof v==='object'&&!Array.isArray(v));assert(typeof v.Name==='string'&&v.Name.length<512);
    assert(typeof v.Input==='string'&&/^(?:[a-fA-F0-9]{2})*$/.test(v.Input));assert(v.Input.length/2<=1024*1024);
    if(failure){assert(typeof v.ExpectedError==='string'&&v.ExpectedError.length>0);assert(!Object.hasOwn(v,'Expected'));}
    else{assert(typeof v.Expected==='string'&&/^(?:[a-fA-F0-9]{2})*$/.test(v.Expected));assert(Number.isSafeInteger(v.Gas)&&v.Gas>0);assert(!Object.hasOwn(v,'ExpectedError'));}
    const data='0x'+v.Input.toLowerCase(),bytes=Buffer.from(v.Input,'hex');let zero=0;for(const b of bytes)if(b===0)zero++;
    const nonzero=bytes.length-zero,intrinsic=21000+4*zero+16*nonzero,floor=21000+10*(zero+4*nonzero);
    // Failed-input fixtures do not declare a gas amount. One million message gas
    // is a fixed ample allowance, not an inferred RequiredGas oracle.
    const gas=Math.max(intrinsic+(failure?1000000:v.Gas),floor),messageGas=gas-intrinsic;
    const reasons=[];if(bytes.length>LIMITS.calldataBytes)reasons.push('calldata_over_32768');if(gas>LIMITS.gas)reasons.push('transaction_gas_over_5000000');
    return {id:file+'#'+index,file,index,name:v.Name,family,address:addr(FAMILIES[family]),failure,inputSha256:sha(bytes),inputBytes:bytes.length,
      expectation:failure?{kind:'exception',gethError:v.ExpectedError}:{kind:'success',output:'0x'+v.Expected.toLowerCase(),executionGas:String(v.Gas)},
      intrinsicGas:String(intrinsic),calldataFloor:String(floor),gas:String(gas),messageGas:String(messageGas),status:reasons.length?'unsupported':'admitted',reasons,data};
  });
}
export function declaredRows(files){
  assert.deepEqual(Object.keys(files).sort(),FILES);const vectors=FILES.flatMap(file=>vectorRows(file,files[file]));
  assert.equal(vectors.length,928);assert.equal(vectors.filter(v=>v.failure).length,59);
  return Object.keys(FORKS).flatMap(fork=>vectors.map(v=>({...v,id:fork+'/'+v.id,fork})));
}
export function headerFor(fork){assert(Object.hasOwn(FORKS,fork));return{number:'25000000',timestamp:FORKS[fork],gasLimit:'60000000',baseFeePerGas:'0',mixHash:word(9),miner:COINBASE,parentHash:word(99),hash:word(100),stateRoot:word(101)};}
export function executionInput(row){
  assert(row.status==='admitted');const account={exists:true,nonce:'1',balance:'0',code:'0x',storage:{}};
  return {request:{from:FROM,to:row.address,data:row.data,value:'0',gas:row.gas},header:headerFor(row.fork),accounts:{[FROM]:{...account,nonce:'7',balance:'1000000000'},[COINBASE]:account,[row.address]:account}};
}
const BLS_ERRORS=new Set(['invalid input length','input is empty','point not on curve','fp point not in field']);
export function compareRow(row,record){
  assert.equal(record.id,row.id);assert.deepEqual(record.input,executionInput(row));const out=record.output;
  if(!out||!['success','failed','reverted'].includes(out.execution?.status))return{status:'unavailable',reason:out?.execution?.error??'missing_execution',channels:null};
  const e=out.execution,expected=row.expectation,expectedGas=row.failure?row.messageGas:expected.executionGas;
  const before=BigInt(row.intrinsicGas)+BigInt(expectedGas),used=before>BigInt(row.calldataFloor)?before:BigInt(row.calldataFloor);
  const channels={status:row.failure?e.status==='failed'&&BLS_ERRORS.has(e.error):e.status==='success'&&e.error===null,
    output:e.returnData===(row.failure?'0x':expected.output),gas:e.executionGasUsed===expectedGas&&e.gasRefundCounter==='0'&&out.gasAccounting?.gasUsed===String(used),
    logs:Array.isArray(out.logs)&&out.logs.length===0,state:JSON.stringify(record.changes?.accounts)===JSON.stringify([{address:FROM,nonce:{before:'0x7',after:'0x8'}}]),
    context:out.profile?.hardfork===row.fork&&out.profile?.intrinsicGas===row.intrinsicGas&&out.profile?.messageGasLimit===row.messageGas&&out.profile?.calldataFloor===row.calldataFloor&&out.profile?.feesSettled===false};
  return {status:Object.values(channels).every(Boolean)?'matched':'mismatched',reason:null,channels,expectedError:row.failure?expected.gethError:null,actualError:e.error};
}
