import { EVMError } from '@ethereumjs/evm';
import { bls12_381 as bls } from '@noble/curves/bls12-381.js';

// EIP-2537's uncompressed field/point format. Explicit mathematical checks
// distinguish invalid public input from host failures without matching library
// exception text. Gas and activation remain in the pinned EVM precompiles.
// No key generation, signature creation or caller-selected crypto backend.
const { Fp, Fp2, Fr, Fp12 } = bls.fields;
const G1 = bls.G1.Point, G2 = bls.G2.Point;
const LENGTH = EVMError.errorMessages.BLS_12_381_INVALID_INPUT_LENGTH;
const FIELD = EVMError.errorMessages.BLS_12_381_FP_NOT_IN_FIELD;
const POINT = EVMError.errorMessages.BLS_12_381_POINT_NOT_ON_CURVE;

export class BlsInputError extends EVMError {
  constructor(error) { super(error); }
}
const need = (condition, error) => { if (!condition) throw new BlsInputError(error); };
const integer = bytes => BigInt('0x' + Buffer.from(bytes).toString('hex'));
const encoded = value => Uint8Array.from(Buffer.from(value.toString(16).padStart(128, '0'), 'hex'));
function bytes(input, size, multiple = false) {
  need(input instanceof Uint8Array && (multiple ? input.length > 0 && input.length % size === 0 : input.length === size), LENGTH);
}
function field(input) {
  bytes(input, 64);
  const value = integer(input); need(value < Fp.ORDER, FIELD); return value;
}
function extension(input) {
  bytes(input, 128);
  return { c0: field(input.subarray(0, 64)), c1: field(input.subarray(64)) };
}
function point(input, group, subgroup) {
  const second = group === G2, fieldType = second ? Fp2 : Fp, width = second ? 128 : 64;
  bytes(input, width * 2);
  const decode = second ? extension : field;
  const x = decode(input.subarray(0, width)), y = decode(input.subarray(width));
  if (fieldType.is0(x) && fieldType.is0(y)) return group.ZERO;
  const b = second ? { c0: 4n, c1: 4n } : 4n;
  need(fieldType.eql(fieldType.sqr(y), fieldType.add(fieldType.mul(fieldType.sqr(x), x), b)), POINT);
  const value = group.fromAffine({ x, y });
  // Addition deliberately accepts on-curve non-subgroup points. MSM and
  // pairing require subgroup membership even when the scalar/other point is 0.
  if (subgroup) {
    const member = value.isTorsionFree();
    if (typeof member !== 'boolean') throw new Error('BLS subgroup check returned a non-boolean value.');
    need(member, POINT);
  }
  return value;
}
function serialize(value, second) {
  const { x, y } = value.toAffine();
  return second ? Uint8Array.from([...encoded(x.c0), ...encoded(x.c1), ...encoded(y.c0), ...encoded(y.c1)])
    : Uint8Array.from([...encoded(x), ...encoded(y)]);
}
function add(input, group) {
  const width = group === G2 ? 256 : 128; bytes(input, width * 2);
  return serialize(point(input.subarray(0, width), group, false).add(point(input.subarray(width), group, false)), group === G2);
}
function msm(input, group) {
  const width = group === G2 ? 256 : 128, stride = width + 32; bytes(input, stride, true);
  let result = group.ZERO;
  for (let offset = 0; offset < input.length; offset += stride) {
    const value = point(input.subarray(offset, offset + width), group, true);
    const scalar = integer(input.subarray(offset + width, offset + stride)) % Fr.ORDER;
    result = result.add(value.multiplyUnsafe(scalar));
  }
  return serialize(result, group === G2);
}
const OPERATIONS = Object.freeze({
  addG1: input => add(input, G1),
  addG2: input => add(input, G2),
  msmG1: input => msm(input, G1),
  msmG2: input => msm(input, G2),
  mapFPtoG1: input => serialize(bls.G1.mapToCurve(field(input)), false),
  mapFP2toG2(input) {
    const value = extension(input);
    return serialize(bls.G2.mapToCurve([value.c0, value.c1]), true);
  },
  pairingCheck(input) {
    bytes(input, 384, true); const pairs = [];
    for (let offset = 0; offset < input.length; offset += 384) {
      const g1 = point(input.subarray(offset, offset + 128), G1, true);
      const g2 = point(input.subarray(offset + 128, offset + 384), G2, true);
      if (!g1.is0() && !g2.is0()) pairs.push({ g1, g2 });
    }
    const value = Fp12.eql(bls.pairingBatch(pairs), Fp12.ONE);
    if (typeof value !== 'boolean') throw new Error('BLS pairing comparison returned a non-boolean value.');
    const result = new Uint8Array(32); result[31] = value ? 1 : 0; return result;
  },
});
const WIDTHS = Object.freeze({ addG1: 128, addG2: 256, msmG1: 128, msmG2: 256, mapFPtoG1: 128, mapFP2toG2: 256, pairingCheck: 32 });

// Internal seam for fault-injection controls, never a transaction API option.
export function guardBlsOperations(operations, checkBudget, onHostFailure) {
  return Object.freeze(Object.fromEntries(Object.entries(WIDTHS).map(([name, width]) => [name, input => {
    // Budget failures are host failures even if a test hook throws an EVMError.
    try { checkBudget(); } catch (error) { onHostFailure(error); throw error; }
    let result, invalid;
    try {
      result = operations[name](input);
      if (!(result instanceof Uint8Array) || result.length !== width) throw new Error('BLS operation returned an invalid byte result.');
    } catch (error) {
      if (error instanceof BlsInputError) invalid = error;
      else { onHostFailure(error); throw error; }
    }
    try { checkBudget(); } catch (error) { onHostFailure(error); throw error; }
    if (invalid) throw invalid;
    return result;
  }])));
}

export const createGuardedBls = (checkBudget, onHostFailure) => guardBlsOperations(OPERATIONS, checkBudget, onHostFailure);
