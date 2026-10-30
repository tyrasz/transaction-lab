// Synthetic cryptographically valid MPT inputs, never public-chain evidence.
import { createMPT, createMerkleProof } from '@ethereumjs/mpt';
import { RLP } from '@ethereumjs/rlp';
import { keccak_256 } from '@noble/hashes/sha3.js';
export const hex=x=>'0x'+Buffer.from(x).toString('hex');
export const bytes=x=>Uint8Array.from(Buffer.from(x.slice(2),'hex'));
export const integer=n=>n===0n?new Uint8Array():bytes('0x'+n.toString(16).padStart(Math.ceil(n.toString(16).length/2)*2,'0'));
export const word=n=>'0x'+BigInt(n).toString(16).padStart(64,'0');
export const A='0x1111111111111111111111111111111111111111',B='0x2222222222222222222222222222222222222222',C='0x3333333333333333333333333333333333333333';
export const minimalProof=async(trie,key)=>(await createMerkleProof(trie,bytes(key))).filter((node,i)=>i===0||node.length>=32).map(hex);
export async function proofFixture({emptyStorage=false,address=A,requested=[word(0),word(1),word(2)],code='0x600100'}={}){
  const storage=await createMPT({useKeyHashing:true}),state=await createMPT({useKeyHashing:true});
  const values=emptyStorage?new Map():new Map([[word(0),7n],[word(1),(1n<<255n)+1n]]);
  for(const[key,value]of values)await storage.put(bytes(key),RLP.encode(integer(value)));
  const emptyStorageRoot=hex((await createMPT({useKeyHashing:true})).root());
  await state.put(bytes(A),RLP.encode([integer(3n),integer(123456789n),storage.root(),keccak_256(bytes(code))]));
  await state.put(bytes(B),RLP.encode([integer(1n),integer(20n),bytes(emptyStorageRoot),keccak_256(new Uint8Array())]));
  const absent=address===C,selectedCode=address===A?code:'0x',storageHash=address===A?hex(storage.root()):emptyStorageRoot;
  const accountProof=await minimalProof(state,address),storageProof=[];
  for(const key of requested){const value=address===A?(values.get(key)??0n):0n;storageProof.push({key,value:'0x'+value.toString(16),proof:address===A?await minimalProof(storage,key):[]});}
  const proof={address,accountProof,balance:address===A?'0x75bcd15':absent?'0x0':'0x14',nonce:address===A?'0x3':absent?'0x0':'0x1',codeHash:hex(keccak_256(bytes(selectedCode))),storageHash,storageProof};
  return{input:{stateRoot:hex(state.root()),address,storageKeys:requested,proof,code:selectedCode},state,storage,values};
}
