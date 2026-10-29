import { bls12_381 as bls } from '@noble/curves/bls12-381.js';

// Single-point verification only: no blob, sidecar, batch or setup-loading API.
// Equation: consensus-specs 017a8495f7671f5fff2075a9bfc9238c1a0982f8,
// specs/deneb/polynomial-commitments.md#verify_kzg_proof_impl.
// This exact setup is embedded by Geth 1df30b18d9ed35ee9d28ffd4648442c2204554ad.
// Its original bytes, licenses and all vector identities are retained in
// test/fixtures/kzg-point-evaluation/provenance.json. No caller supplies setup.
export const KZG_POINT_EVALUATION_SETUP = Object.freeze({
  sourceCommit: '1df30b18d9ed35ee9d28ffd4648442c2204554ad',
  sourcePath: 'crypto/kzg4844/trusted_setup.json',
  sourceSha256: 'f8e44a31ebf0a6d0734dcb301b0716e2c77f3ae18ed0cab0870fbcc2ca55616f',
  g2MonomialIndex: 1,
  g2Monomial: '0xb5bfd7dd8cdeb128843bc287230af38926187075cbfbefa81009a2ce615ac53d2914e5870cb452d2afaaab24f3499f72185cbfee53492714734429b7b38608e23926c911cceceac9a36851477ba4c60b087041de621000edc98edada20c1def2',
});

export class KzgInputError extends Error {
  constructor() {
    super('C_KZG_BADARGS: malformed point-evaluation input.');
    this.name = 'KzgInputError';
    this.code = 'C_KZG_BADARGS';
  }
}

const { Fp, Fr, Fp12 } = bls.fields;
const G1 = bls.G1.Point, G2 = bls.G2.Point;
const setupPoint = G2.fromHex(KZG_POINT_EVALUATION_SETUP.g2Monomial.slice(2));
const negativeGenerator = G2.BASE.negate();
const need = condition => { if (!condition) throw new KzgInputError(); };

function decodeHex(value, length) {
  need(typeof value === 'string' && value.length === 2 + length * 2 && /^0x[0-9a-f]+$/i.test(value)
    && value.startsWith('0x'));
  return Uint8Array.from(Buffer.from(value.slice(2), 'hex'));
}
const integer = value => BigInt('0x' + Buffer.from(value).toString('hex'));
function scalar(value) {
  const n = integer(decodeHex(value, 32));
  // Noble's Fr.fromBytes reduces modulo r, which EIP-4844 expressly forbids.
  need(n < Fr.ORDER);
  return n;
}

function point(value) {
  const encoded = decodeHex(value, 48), bytes = encoded.slice();
  const compressed = (bytes[0] & 0x80) !== 0, infinity = (bytes[0] & 0x40) !== 0;
  const sort = (bytes[0] & 0x20) !== 0;
  bytes[0] &= 0x1f;
  const x = integer(bytes);
  need(compressed);
  if (infinity) {
    need(!sort && x === 0n);
    return G1.ZERO;
  }
  need(x < Fp.ORDER);
  // p = 3 mod 4. An explicit square check separates malformed encodings from
  // unexpected library/host exceptions without catching arbitrary Error text.
  const rhs = Fp.add(Fp.mul(Fp.sqr(x), x), 4n);
  let y = Fp.pow(rhs, (Fp.ORDER + 1n) / 4n);
  need(Fp.eql(Fp.sqr(y), rhs));
  if ((y > Fp.ORDER / 2n) !== sort) y = Fp.neg(y);
  const decoded = G1.fromAffine({ x, y });
  need(decoded.isTorsionFree());
  decoded.assertValidity();
  const canonical = decoded.toBytes(true);
  need(canonical.length === encoded.length && canonical.every((b, i) => b === encoded[i]));
  return decoded;
}

/** Verify p(z)=y for a compressed mainnet KZG commitment and proof.
 * Exact hexadecimal byte widths are required. Malformed inputs throw only
 * KzgInputError; well-formed incorrect proofs return false. Unexpected host
 * exceptions propagate for the executor's independent rollback latch. All
 * scalars/points are public; multiplyUnsafe permits zero without randomness. */
export function verifyKzgProof(commitment, z, y, proof) {
  const evaluationPoint = scalar(z), claimedValue = scalar(y);
  const polynomial = point(commitment), quotient = point(proof);
  const difference = polynomial.subtract(G1.BASE.multiplyUnsafe(claimedValue));
  const divisor = setupPoint.subtract(G2.BASE.multiplyUnsafe(evaluationPoint));
  // Noble rejects ZERO pairing arguments, while KZG permits the identity.
  // Validate encodings first, then omit only mathematically neutral terms.
  const pairs = [{ g1: difference, g2: negativeGenerator }, { g1: quotient, g2: divisor }]
    .filter(({ g1, g2 }) => !g1.is0() && !g2.is0());
  return Fp12.eql(bls.pairingBatch(pairs), Fp12.ONE);
}
