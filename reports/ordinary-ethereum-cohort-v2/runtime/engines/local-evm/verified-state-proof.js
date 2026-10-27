// Offline EIP-1186 verification against an explicitly supplied trusted stateRoot.
// Root authentication, header consensus/finality and complete state discovery
// are deliberately outside this module. No provider or execution API is used.
// Primary specifications: https://eips.ethereum.org/EIPS/eip-1186
// https://github.com/ethereum/go-ethereum/blob/master/trie/proof.go (minimal
// ordered hashed-node proofs; embedded children are already inside their parent).
import { verifyMerkleProof } from '@ethereumjs/mpt';
import { RLP } from '@ethereumjs/rlp';
import { keccak_256 } from '@noble/hashes/sha3.js';

export const STATE_PROOF_LIMITS = Object.freeze({ storageKeys:64, nodesPerProof:128, nodeBytes:2048, totalProofBytes:2*1024*1024, codeBytes:128*1024 });
const WORD=/^0x[0-9a-f]{64}$/i, ADDRESS=/^0x[0-9a-f]{40}$/i, DATA=/^0x(?:[0-9a-f]{2})*$/i, QUANTITY=/^0x(?:0|[1-9a-f][0-9a-f]*)$/i;
const MAX=(1n<<256n)-1n, MAX_NONCE=(1n<<64n)-1n;
const ZERO_HASH='0x'+'00'.repeat(32);
const bytes=x=>Uint8Array.from(Buffer.from(x.slice(2),'hex')), hex=x=>'0x'+Buffer.from(x).toString('hex');
const hash=x=>hex(keccak_256(x)), same=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
export const EMPTY_CODE_HASH=hash(new Uint8Array());
export const EMPTY_STORAGE_ROOT=hash(RLP.encode(new Uint8Array()));
export class StateProofError extends Error {
  constructor(message,code='STATE_PROOF_INVALID'){super(message);this.name='StateProofError';this.code=code;}
}
const need=(condition,message,code)=>{if(!condition)throw new StateProofError(message,code);};
function fields(value,allowed,required=allowed){
  need(value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value)),'Proof input must contain plain records.');
  const names=Reflect.ownKeys(value);
  for(const key of names){const d=Object.getOwnPropertyDescriptor(value,key);need(typeof key==='string'&&allowed.includes(key)&&d.enumerable&&Object.hasOwn(d,'value'),'Proof input contains an unsupported property.');}
  need(required.every(key=>Object.hasOwn(value,key)),'Proof input is missing a required property.');return value;
}
function array(value,max){
  need(Array.isArray(value),'Proof input must contain arrays.');need(value.length<=max,'Proof input exceeds its array limit.','STATE_PROOF_LIMIT');
  need(Reflect.ownKeys(value).length===value.length+1,'Proof arrays must be dense and have no extra properties.');
  for(let i=0;i<value.length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));need(d&&d.enumerable&&Object.hasOwn(d,'value'),'Proof arrays cannot contain holes or accessors.');}
  return value;
}
function data(value,size,label){need(typeof value==='string'&&value.length===2+size*2&&DATA.test(value),label+' has an invalid byte length or encoding.');return value.toLowerCase();}
function quantity(value,max=MAX){need(typeof value==='string'&&value.length<=66&&QUANTITY.test(value),'Proof quantities must be canonical hexadecimal strings.');const n=BigInt(value);need(n<=max,'Proof quantity exceeds its field range.');return n;}
function storageKey(value){
  need(typeof value==='string'&&value.length<=66,'Storage key is malformed.');
  if(WORD.test(value))return value.toLowerCase();return '0x'+quantity(value).toString(16).padStart(64,'0');
}
function proofNodes(input,budget){
  const nodes=array(input,STATE_PROOF_LIMITS.nodesPerProof),seen=new Set();
  return nodes.map(text=>{
    need(typeof text==='string'&&DATA.test(text)&&text.length>2,'A proof node must be nonempty byte data.');
    const length=(text.length-2)/2;need(length<=STATE_PROOF_LIMITS.nodeBytes,'A proof node exceeds its byte limit.','STATE_PROOF_LIMIT');
    budget.bytes+=length;need(budget.bytes<=STATE_PROOF_LIMITS.totalProofBytes,'Proofs exceed the shared byte limit.','STATE_PROOF_LIMIT');
    const encoded=bytes(text),id=hash(encoded);need(!seen.has(id),'A proof contains duplicate nodes.');seen.add(id);return encoded;
  });
}
function decode(encoded){const value=RLP.decode(encoded);need(same(RLP.encode(value),encoded),'RLP encoding is not canonical.');return value;}
function integer(encoded,max){need(encoded instanceof Uint8Array&&encoded.length<=32&&(encoded.length===0||encoded[0]!==0),'RLP integer is malformed or nonminimal.');const n=encoded.length?BigInt(hex(encoded)):0n;need(n<=max,'RLP integer exceeds its field range.');return n;}
function compact(encoded){
  need(encoded instanceof Uint8Array&&encoded.length>0&&encoded.length<=33,'Compact trie path is malformed.');
  const flag=encoded[0]>>4,odd=flag&1;need(flag<=3&&(odd||(encoded[0]&15)===0),'Compact trie path has invalid flags or padding.');
  const nibbles=[];if(odd)nibbles.push(encoded[0]&15);for(let i=1;i<encoded.length;i++)nibbles.push(encoded[i]>>4,encoded[i]&15);
  const leaf=(flag&2)!==0;need(leaf||nibbles.length>0,'Empty extension paths are not canonical.');return{leaf,nibbles};
}
function nodeShape(node,depth=0){
  need(depth<=64&&Array.isArray(node)&&(node.length===2||node.length===17),'Trie node shape is malformed.');
  const child=(ref,empty)=>{
    if(Array.isArray(ref)){need(RLP.encode(ref).length<32,'Embedded trie child must be shorter than 32 bytes.');nodeShape(ref,depth+1);}
    else need(ref instanceof Uint8Array&&(ref.length===32||(empty&&ref.length===0)),'Trie child reference is malformed.');
  };
  if(node.length===17){
    let populated=0;for(const ref of node.slice(0,16)){child(ref,true);if(Array.isArray(ref)||ref.length)populated++;}
    need(node[16] instanceof Uint8Array&&node[16].length===0,'A secure fixed-length-key trie cannot have a branch value.');
    need(populated>=2,'A branch with fewer than two children is not canonical.');
  }else{const path=compact(node[0]);if(path.leaf)need(node[1] instanceof Uint8Array&&node[1].length>0,'Trie leaf value is malformed.');else child(node[1],false);}
}
// Walk only the requested 64-nibble secure key, consuming every supplied hashed
// node exactly once and in order. Extra, reordered, embedded-duplicate or
// incomplete nodes are rejected even if a permissive DB-backed verifier could
// otherwise find the requested value. Inline children stay in the parent RLP.
function strictPath(root,key,nodes){
  if(root===EMPTY_STORAGE_ROOT){need(nodes.length===0,'An empty trie requires an empty proof.');return null;}
  need(nodes.length>0,'A nonempty trie requires a proof root.');
  let index=0,position=0,ref=bytes(root),isRoot=true,expectBranch=false;const path=[...keccak_256(key)].flatMap(v=>[v>>4,v&15]);
  const done=value=>{need(index===nodes.length,'A proof contains unused or out-of-order nodes.');return value;};
  for(let depth=0;depth<=128;depth++){
    let node;
    if(Array.isArray(ref)){node=ref;}
    else{
      need(ref instanceof Uint8Array,'Trie link is malformed.');if(ref.length===0)return done(null);
      need(ref.length===32&&index<nodes.length,'A proof is missing a referenced node.');
      const encoded=nodes[index++];need(hash(encoded)===hex(ref),'A proof node does not match its expected root or parent hash.');
      need(isRoot||encoded.length>=32,'A short child must be embedded in its parent.');node=decode(encoded);nodeShape(node);
    }
    isRoot=false;need(!expectBranch||node.length===17,'An extension must terminate in a branch.');expectBranch=false;
    if(node.length===17){need(position<64,'Trie branch extends beyond the secure key.');ref=node[path[position++]];continue;}
    const part=compact(node[0]),matches=part.nibbles.every((n,i)=>path[position+i]===n);
    need(position+part.nibbles.length<=64,'Trie path extends beyond the secure key.');
    need(!part.leaf||position+part.nibbles.length===64,'A leaf must cover the complete secure key.');
    if(!matches)return done(null);position+=part.nibbles.length;
    if(part.leaf)return done(position===64?node[1]:null);
    need(position<64,'Extension ends after the secure key.');ref=node[1];expectBranch=true;
  }
  throw new StateProofError('Trie path exceeds its traversal limit.','STATE_PROOF_LIMIT');
}
async function provenValue(root,key,nodes){
  const strict=strictPath(root,key,nodes);
  // The pinned MPT helper rejects [] even for KECCAK256(RLP(empty)). That
  // explicit known root commits to the empty trie without any path nodes.
  if(root===EMPTY_STORAGE_ROOT)return strict;
  const upstream=await verifyMerkleProof(key,nodes,{root:bytes(root),useKeyHashing:true});
  need(strict===null?upstream===null:upstream instanceof Uint8Array&&same(strict,upstream),'Trie verification implementations disagree.');return strict;
}
function frozen(value){if(value&&typeof value==='object'){for(const item of Object.values(value))frozen(item);Object.freeze(value);}return value;}

/**
 * Verify one standard eth_getProof response and optional runtime bytes.
 * storageKeys are requested 32-byte DATA; response keys may be the EIP's
 * canonical QUANTITY or a 32-byte DATA representation. Response order must
 * exactly match the requested keys; normalized duplicates are rejected.
 * No code supplied => unknown code for existing accounts (not guessed empty).
 * A valid exclusion proves account absence or a zero slot; missing proof never
 * does. Unrequested slots remain outside this returned sparse inventory.
 */
export async function verifyStateProof(input){
  try{
    fields(input,['stateRoot','address','storageKeys','proof','code'],['stateRoot','address','storageKeys','proof']);
    const stateRoot=data(input.stateRoot,32,'State root'),address=data(input.address,20,'Address');
    const requested=array(input.storageKeys,STATE_PROOF_LIMITS.storageKeys).map(key=>data(key,32,'Requested storage key'));
    need(new Set(requested).size===requested.length,'Requested storage keys contain normalized duplicates.');
    const proof=fields(input.proof,['address','accountProof','balance','nonce','codeHash','storageHash','storageProof']);
    need(data(proof.address,20,'Proof address')===address,'Proof address differs from the requested address.');
    const claimed={nonce:quantity(proof.nonce,MAX_NONCE),balance:quantity(proof.balance),codeHash:data(proof.codeHash,32,'Code hash'),storageRoot:data(proof.storageHash,32,'Storage root')};
    const budget={bytes:0},accountNodes=proofNodes(proof.accountProof,budget);
    const slots=array(proof.storageProof,STATE_PROOF_LIMITS.storageKeys).map(row=>{fields(row,['key','value','proof']);return{key:storageKey(row.key),value:quantity(row.value),nodes:proofNodes(row.proof,budget)};});
    need(slots.length===requested.length&&slots.every((row,i)=>row.key===requested[i]),'Storage proofs do not match the exact ordered requested keys.');
    let code;
    if(Object.hasOwn(input,'code')){need(typeof input.code==='string'&&DATA.test(input.code),'Code must be explicit byte data.');need(input.code.length<=2+STATE_PROOF_LIMITS.codeBytes*2,'Code exceeds its byte limit.','STATE_PROOF_LIMIT');code=input.code.toLowerCase();}
    // All caller-owned mutable structures are validated and copied before the
    // first await. Every later value comes from these local immutable scalars.
    const encodedAccount=await provenValue(stateRoot,bytes(address),accountNodes);let actual;
    if(encodedAccount===null){actual={nonce:0n,balance:0n,storageRoot:EMPTY_STORAGE_ROOT,codeHash:EMPTY_CODE_HASH};}
    else{const fields=decode(encodedAccount);need(Array.isArray(fields)&&fields.length===4&&fields.every(x=>x instanceof Uint8Array),'Account leaf must encode exactly four byte fields.');
      need(fields[2].length===32&&fields[3].length===32,'Account storage and code hashes must be 32 bytes.');actual={nonce:integer(fields[0],MAX_NONCE),balance:integer(fields[1],MAX),storageRoot:hex(fields[2]),codeHash:hex(fields[3])};}
    // Geth's GetProof returns StateDB's zero hashes for a nonexistent account
    // (core/state/statedb.go GetCodeHash/GetStorageRoot), not the empty-code /
    // empty-trie hashes. These are metadata sentinels, never trie roots. Admit
    // only that complete pair AFTER cryptographic exclusion; preserve it below
    // separately from normalized absent-account facts. No existing-account
    // mismatch or arbitrary absent metadata is normalized away.
    const absent=encodedAccount===null;
    const absentZeroHashes=absent&&claimed.codeHash===ZERO_HASH&&claimed.storageRoot===ZERO_HASH;
    need(claimed.nonce===actual.nonce&&claimed.balance===actual.balance&&
      (absentZeroHashes||(claimed.codeHash===actual.codeHash&&claimed.storageRoot===actual.storageRoot)),
      'Reported account fields differ from the proven account.');
    if(code!==undefined)need(hash(bytes(code))===actual.codeHash,'Runtime code does not match the proven code hash.');
    const storage=[];
    for(const row of slots){const encoded=await provenValue(actual.storageRoot,bytes(row.key),row.nodes);let value=0n;
      if(encoded!==null){value=integer(decode(encoded),MAX);need(value>0n,'Canonical Ethereum storage excludes explicit zero leaves.');}
      need(value===row.value,'Reported storage value differs from the proven value.');storage.push({key:row.key,exists:encoded!==null,valueRaw:value.toString(),valueWord:'0x'+value.toString(16).padStart(64,'0')});}
    return frozen({status:'verified',basis:'eip1186_merkle_patricia_proof',stateRoot,address,
      account:{exists:!absent,nonceRaw:actual.nonce.toString(),balanceRaw:actual.balance.toString(),codeHash:actual.codeHash,storageRoot:actual.storageRoot},
      reportedAccount:{nonceRaw:claimed.nonce.toString(),balanceRaw:claimed.balance.toString(),codeHash:claimed.codeHash,storageRoot:claimed.storageRoot},
      code:code!==undefined||absent?{status:'verified',bytes:code??'0x'}:{status:'unknown'},storage,
      coverage:{storage:'requested_keys_only',unrequestedStorage:'unknown',stateRootTrust:'caller_supplied'}});
  }catch(error){if(error instanceof StateProofError)throw error;throw new StateProofError('Malformed or incomplete Merkle Patricia proof.');}
}
