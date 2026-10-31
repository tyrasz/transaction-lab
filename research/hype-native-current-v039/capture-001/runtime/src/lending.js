// Hyperlend USDC position semantics, bound to observed deployed implementations.
// Source provenance and public traces: reports/lending-discovery/.
import { CHAIN_ID, POOL, USDC, HUSDC, VUSDC } from './config.js';
import { formatUnits } from './analyze.js';
const ZERO = '0x' + '0'.repeat(40);
const MAX = (1n << 256n) - 1n;
const RAY = 10n ** 27n;
const MINT = '0x458f5fa412d0f69b08dd84872b0215675cc67bc1d5b6fd93300a1c3878b86196';
const BURN = '0x4cf25bc1d991c17529c25213d3cc0cda295eeaad5f13f361969b12ea48015f90';
const TOPICS = {
  withdraw: '0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7',
  borrow: '0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0',
  repay: '0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051',
};
const IMPLEMENTATIONS = { [HUSDC]: '0x410aa1ab680b886c875e99a7a4bfaf188508a7a3', [VUSDC]: '0x8158e5569475a443a5723ccac462930f590449ed' };
const lower = value => typeof value === 'string' ? value.toLowerCase() : '';
const addr = value => /^0x[0-9a-f]{40}$/i.test(value ?? '') ? value.toLowerCase() : null;
const addressWord = value => /^0x0{24}[0-9a-f]{40}$/i.test(value ?? '') ? '0x' + value.slice(-40).toLowerCase() : null;
const fields = (data, count) => typeof data === 'string' && /^0x[0-9a-f]*$/i.test(data) && data.length === 2 + count * 64 ? Array.from({length:count},(_,i)=>'0x'+data.slice(2+i*64,66+i*64)) : null;
const ceilDiv = (a,b) => (a+b-1n)/b;
export const isKnownLiability = (chainId, token) => Number(chainId) === CHAIN_ID && lower(token) === VUSDC;

export function decodeLendingCall(request, metadata = {}) {
  if (Number(request?.chainId) !== CHAIN_ID || addr(request.to) !== POOL) return null;
  const operation = { '0x69328dec':'withdraw', '0xa415bcad':'borrow', '0x573ade81':'repay' }[lower(request.data).slice(0,10)];
  if (!operation) return null;
  const args = fields('0x'+request.data.slice(10), {withdraw:3,borrow:5,repay:4}[operation]);
  if (!args) return null;
  const asset = addressWord(args[0]), account = addr(request.from);
  const supportedScope = asset===USDC && (operation==='withdraw' || BigInt(args[2])===2n);
  const onBehalfOf = operation === 'withdraw' ? account : addressWord(args[operation==='borrow'?4:3]);
  const recipient = operation === 'withdraw' ? addressWord(args[2]) : operation === 'borrow' ? account : supportedScope ? HUSDC : null;
  if (!asset || !account || !onBehalfOf || (operation!=='repay' && !recipient) || (operation==='borrow' && BigInt(args[3])>65535n)) return null;
  const amountRaw = BigInt(args[1]);
  return { name:'Hyperlend',operation,asset,account,onBehalfOf,recipient,
    amountRaw:amountRaw.toString(), amount:formatUnits(amountRaw,metadata[asset]?.decimals),
    amountMode:operation!=='borrow' && amountRaw===MAX ? 'all' : 'exact',
    ...(operation==='withdraw'?{}:{interestRateMode:BigInt(args[2]).toString()}),
    ...(operation==='borrow'?{referralCode:Number(BigInt(args[3]))}:{}),
    positionToken:supportedScope?(operation==='withdraw'?HUSDC:VUSDC):null, positionAccount:supportedScope?onBehalfOf:null,
  };
}
export const supportsLending = protocol => Boolean(protocol?.asset===USDC && ['withdraw','borrow','repay'].includes(protocol.operation) && (protocol.operation==='withdraw'||protocol.interestRateMode==='2'));

/** Logs/frames have already been stripped of reverted subtrees by the analyzer. */
export function reconcileLending({protocol,logs,movements,frames,returnData}) {
  const reasons = [], positionChanges = [];
  const fail = message => reasons.push(message);
  const op = protocol.operation, token = protocol.positionToken, owner = protocol.positionAccount;
  const eventEntries = logs.filter(({log})=>lower(log.address)===POOL && lower(log.topics?.[0])===TOPICS[op]);
  let actual = null;
  if(eventEntries.length!==1) fail('Exactly one matching Hyperlend operation event is required.');
  else {
    const log=eventEntries[0].log, data=fields(log.data,{withdraw:1,borrow:4,repay:2}[op]);
    const topic=log.topics;
    let matches=topic?.length===4 && addressWord(topic[1])===USDC && data;
    if(matches && op==='withdraw') matches=addressWord(topic[2])===protocol.account && addressWord(topic[3])===protocol.recipient;
    if(matches && op==='borrow') matches=addressWord(topic[2])===owner && /^0x[0-9a-f]{64}$/i.test(topic[3]) && BigInt(topic[3])===BigInt(protocol.referralCode) && addressWord(data[0])===protocol.account && BigInt(data[2])===2n;
    if(matches && op==='repay') matches=addressWord(topic[2])===owner && addressWord(topic[3])===protocol.account && BigInt(data[1])===0n;
    if(!matches) fail('Hyperlend operation event arguments do not match the request.');
    else actual=BigInt(data[op==='borrow'?1:0]);
  }
  if(actual!==null) {
    const requested=BigInt(protocol.amountRaw);
    if(actual<=0n || (op==='repay'?actual>requested:protocol.amountMode!=='all' && actual!==requested)) fail('Executed USDC amount does not match the operation request limits.');
    if(op!=='borrow' && (!fields(returnData,1) || BigInt(returnData)!==actual)) fail('Returned executed amount does not match the Hyperlend operation event.');
    const usdcMoves=movements.filter(m=>m.address===USDC);
    if(usdcMoves.length!==1 || usdcMoves[0].from!==(op==='repay'?protocol.account:HUSDC) || usdcMoves[0].to!==(op==='repay'?HUSDC:protocol.recipient) || BigInt(usdcMoves[0].amountRaw)!==actual) fail('USDC Transfer evidence does not reconcile to the executed amount and recipient.');
  }
  const positionEvents=logs.filter(({log})=>lower(log.address)===token && [MINT,BURN].includes(lower(log.topics?.[0])));
  let implied=null, positionEvent=null;
  if(positionEvents.length!==1) fail('Exactly one position Mint or Burn event is required.');
  else {
    const {log,...location}=positionEvents[0], data=fields(log.data,3), mint=lower(log.topics?.[0])===MINT;
    const actor=addressWord(log.topics?.[1]), target=addressWord(log.topics?.[2]);
    if(!data || log.topics?.length!==3 || actor!==(op==='borrow'?protocol.account:owner) || target!==(mint?owner:op==='withdraw'?protocol.recipient:ZERO)) fail('Position event arguments do not match the affected account.');
    else {
      const [value,interest,index]=data.map(BigInt);
      implied=(mint?value:-value)-interest;
      positionEvent={token,account:owner,event:mint?'Mint':'Burn',role:token===VUSDC?'liability':'receipt_token',valueRaw:value.toString(),accruedInterestRaw:interest.toString(),indexRaw:index.toString(),deltaRaw:implied.toString(),delta:formatUnits(implied,6),basis:'position_event_minus_accrued_interest',...location};
      positionChanges.push(positionEvent);
      const transfers=movements.filter(m=>m.address===token);
      if(transfers.length!==1 || transfers[0].from!==(mint?ZERO:owner) || transfers[0].to!==(mint?owner:ZERO) || BigInt(transfers[0].amountRaw)!==value) fail('Position Transfer and Mint/Burn event amounts do not reconcile.');
    }
  }
  let rounding=null;
  const selector={withdraw:'0xb18d6afd',borrow:'0x9ceeaca7',repay:'0xf5298aca'}[op];
  const calls=frames.filter(({frame})=>frame.type==='CALL' && addr(frame.from)===POOL && addr(frame.to)===token && lower(frame.input).startsWith(selector));
  if(calls.length!==1) fail('One verified scaled-position call is required.');
  else if(actual!==null && positionEvent) {
    const {frame,path}=calls[0], args=fields('0x'+frame.input.slice(10),op==='repay'?3:5);
    const implementationIndex=(frame.calls??[]).findIndex(child=>child.type==='DELEGATECALL' && addr(child.from)===token && addr(child.to)===IMPLEMENTATIONS[token] && !child.error && !child.revertReason && lower(child.input)===lower(frame.input));
    const implementationPath=`${path}.${implementationIndex}`;
    let valid=Boolean(args && implementationIndex>=0 && positionEvent.framePath===implementationPath && movements.filter(m=>m.address===token).every(m=>m.framePath===implementationPath));
    if(valid && op==='withdraw') valid=addressWord(args[0])===owner && addressWord(args[1])===protocol.recipient && BigInt(args[2])===actual;
    if(valid && op==='borrow') valid=addressWord(args[0])===protocol.account && addressWord(args[1])===owner && BigInt(args[2])===actual;
    if(valid && op==='repay') valid=addressWord(args[0])===owner;
    if(valid) {
      const q=BigInt(args[op==='repay'?1:3]), index=BigInt(args[op==='repay'?2:4]);
      valid=index>0n && index===BigInt(positionEvent.indexRaw) && q>0n;
      if(valid) {
        const expected=op==='repay'?actual*RAY/index:ceilDiv(actual*RAY,index);
        // For withdraw-all the implementation burns the entire scaled balance.
        valid=op==='withdraw' && protocol.amountMode==='all' ? q*index/RAY===actual : q===expected;
        const floor=q*index/RAY, ceil=ceilDiv(q*index,RAY);
        const withdrawAll=op==='withdraw' && protocol.amountMode==='all';
        const repayAll=op==='repay' && (protocol.amountMode==='all' || actual<BigInt(protocol.amountRaw));
        const fullPosition=withdrawAll || repayAll;
        const minimum=fullPosition?-actual:op==='borrow'?floor:-ceil, maximum=fullPosition?-actual:op==='borrow'?ceil:-floor;
        rounding={model:op==='withdraw'?'ceil_scaled_burn_floor_balance':op==='borrow'?'ceil_scaled_mint_ceil_balance':'floor_scaled_burn_ceil_balance',scaledAmountRaw:q.toString(),indexRaw:index.toString(),minDeltaRaw:minimum.toString(),maxDeltaRaw:maximum.toString(),implementation:IMPLEMENTATIONS[token],basis:'verified_implementation_and_traced_scaled_inputs'};
        valid=valid && implied>=minimum && implied<=maximum;
      }
    }
    if(!valid) fail('Position delta does not reconcile to the verified implementation, scaled inputs and rounding bounds.');
  }
  if(movements.some(m=>![USDC,token].includes(m.address))) fail('Additional token movements fall outside this lending operation interpretation.');
  Object.assign(protocol,{actualAmountRaw:actual?.toString()??null,actualAmount:actual===null?null:formatUnits(actual,6),positionDeltaRaw:implied?.toString()??null,positionDelta:implied===null?null:formatUnits(implied,6),reconciliation:{status:reasons.length?'unreconciled':'reconciled',basis:'pool_transfer_and_scaled_position_evidence',rounding,reasons}});
  return {positionChanges,reasons};
}
