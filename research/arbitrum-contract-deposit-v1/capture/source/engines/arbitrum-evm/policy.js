import fs from 'node:fs';
import assert from 'node:assert/strict';
import { encodeDeployData,encodeFunctionData,decodeFunctionData } from 'viem';
import { deploylessCallViaBytecodeBytecode } from './node_modules/viem/_esm/constants/contracts.js';
import { LIMITS,ZERO,ETH,ADDRESS,clone,hex,plain } from './common.js';
import { headerShape,simulationShape,callShape } from './wire-validation.js';
const source=fs.readFileSync(new URL('./node_modules/viem/_esm/actions/public/simulateCalls.js',import.meta.url),'utf8');
function literal(name){const m=[...source.matchAll(new RegExp(`const ${name} = '(0x[0-9a-f]+)'`,'g'))];assert.equal(m.length,1);return m[0][1];}
export const STATIC_CODE=literal('staticCallCode'),BALANCE_CODE=literal('getBalanceCode');
export const STATIC_ABI=[{type:'function',name:'query',stateMutability:'view',inputs:[{type:'address',name:'target'},{type:'bytes',name:'data'}],outputs:[]}];
const NATIVE_ABI=[{type:'function',name:'getBalance',stateMutability:'view',inputs:[{type:'address'}],outputs:[{type:'uint256'}]}];
export const TRANSFER='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const balanceData=sender=>'0x70a08231'+sender.slice(2).padStart(64,'0');
export const nativeProbe=sender=>encodeDeployData({abi:[{type:'constructor',inputs:[{type:'bytes'},{type:'bytes'}]}],bytecode:deploylessCallViaBytecodeBytecode,args:[BALANCE_CODE,encodeFunctionData({abi:NATIVE_ABI,functionName:'getBalance',args:[sender]})]});
export const helperData=(target,data)=>encodeFunctionData({abi:STATIC_ABI,functionName:'query',args:[target,data]});
export const originalCall=s=>({from:s.from,to:s.to,data:s.data,value:hex(s.value),gas:hex(s.gas),gasPrice:'0x0'});
export function candidates(discovery,s){const account='0x'+s.from.slice(2).padStart(64,'0');const addresses=discovery[0].calls[0].logs.filter(l=>l.topics[0]===TRANSFER&&l.address!==ETH&&(l.topics[1]===account||l.topics[2]===account)).map(l=>l.address);return [...new Set([...addresses,s.to])].filter(a=>a!==ETH&&a!==ZERO);}
export function scratchAddress(s,assets){const occupied=new Set([s.from,...assets]);let n=0xdeadbeefn;while(occupied.has('0x'+n.toString(16).padStart(40,'0')))n++;return '0x'+n.toString(16).padStart(40,'0');}
export function expectedMain(s,assets){const scratch=scratchAddress(s,assets),override={[scratch]:{code:STATIC_CODE}};return [{calls:[originalCall(s),{from:s.from,to:ZERO}]},{calls:[{data:nativeProbe(s.from)}]},...[balanceData(s.from),'0x313ce567','0xc87b56dd'+'0'.repeat(64),'0x95d89b41'].map(data=>({calls:assets.map(address=>({to:scratch,gas:'0xf4240',data:helperData(address,data)})),stateOverrides:override}))];}
export function createPolicy(s){let selected=null,selection=0,discovery=null,main=null,assets=[],pendingDiscovery=false,pendingMain=false;const pre=new Set(),observations=[];
  return {
    pin(header){assert.equal(selected,null);headerShape(header);if(s.block!=='latest')assert.equal(header.number,s.block);selected=clone(header);},
    get state(){return {selected,discovery,main,assets:[...assets],scratch:selected?scratchAddress(s,assets):null,observations};},
    validate(method,params,phase){assert.ok(Array.isArray(params));
      if(phase==='selection'){assert.ok(selection<2);assert.equal(method,selection===0?'eth_chainId':'eth_getBlockByNumber');assert.deepEqual(params,selection===0?[]:[s.block,false]);selection++;return;}
      assert.ok(selected);
      if(phase==='final'){assert.equal(method,'eth_getBlockByNumber');assert.deepEqual(params,[selected.number,false]);return;}
      if(phase==='prechecks'){assert.ok(method==='eth_getBalance'||method==='eth_getCode');assert.deepEqual(params,[s.from,selected.number]);assert.ok(!pre.has(method));pre.add(method);return;}
      assert.equal(phase,'viem');assert.equal(params[1],selected.number);
      if(method==='eth_simulateV1'){
        assert.equal(params.length,2);plain(params[0],['blockStateCalls','traceTransfers','validation']);assert.equal(params[0].traceTransfers,true);assert.equal(params[0].validation,false);
        if(!discovery){assert.equal(pendingDiscovery,false);pendingDiscovery=true;assert.deepEqual(params[0].blockStateCalls,[{calls:[originalCall(s)]}]);}
        else {assert.equal(pendingMain,false);pendingMain=true;assert.deepEqual(params[0].blockStateCalls,expectedMain(s,assets));}
        return;
      }
      assert.equal(method,'eth_call');assert.ok(discovery);let key;
      if(params[0]?.to===undefined){assert.deepEqual(params,[{from:s.from,data:nativeProbe(s.from)},selected.number]);key='native';}
      else {assert.equal(params.length,3);const scratch=scratchAddress(s,assets);const decoded=decodeFunctionData({abi:STATIC_ABI,data:params[0].data});assert.equal(decoded.functionName,'query');const address=decoded.args[0].toLowerCase();assert.ok(assets.includes(address));assert.equal(decoded.args[1],balanceData(s.from));assert.deepEqual(params,[{from:ZERO,to:scratch,gas:'0xf4240',data:helperData(address,balanceData(s.from))},selected.number,{[scratch]:{code:STATIC_CODE}}]);key=address;}
      assert.ok(!pre.has(key));pre.add(key);
    },
    observe(method,params,result,id){
      if(method==='eth_simulateV1'){
        simulationShape(result,params[0].blockStateCalls,selected);
        assert.ok(BigInt(result[0].calls[0].gasUsed)<=BigInt(s.gas),'Original gas use exceeds declared limit.');
        if(params[0].blockStateCalls.length===1){assert.equal(discovery,null);discovery=clone(result);assets=candidates(result,s);assert.ok(assets.length<=LIMITS.assets);assets.forEach(a=>assert.match(a,ADDRESS));}
        else {assert.ok(discovery);assert.equal(main,null);assert.deepEqual(callShape(result[0].calls[0]),callShape(discovery[0].calls[0]),'Original simulations disagree.');main=clone(result);}
      }
      observations.push({method,params:clone(params),result:clone(result),id});
    },
  };
}
