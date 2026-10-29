import { EVMError } from '@ethereumjs/evm';
import { p256 } from '@noble/curves/nist.js';

export const P256_ADDRESS = '0x0000000000000000000000000000000000000100';
export const P256_GAS = 6900n;
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const A = P - 3n, B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
const integer = bytes => { let value = 0n; for (const byte of bytes) value = (value << 8n) | BigInt(byte); return value; };

// Equivalent to Noble's lowS:false, prehash:false P-256 verification, without
// its catch-all conversion of unexpected arithmetic exceptions into false.
// All attacker-controlled encodings are checked before these fixed primitives.
function verifySignature({ h, r, s, x, y }) {
  const point = p256.Point.fromAffine({ x, y });
  const inverse = p256.Point.Fn.inv(s);
  const result = p256.Point.BASE.mulAddUnsafe((h * inverse) % N, point, (r * inverse) % N);
  return !result.is0() && result.toAffine().x % N === r;
}

// Internal construction seam for failure-injection tests only. Neither this
// factory nor its verifier is reachable through a public execution request.
export function _createP256Precompile({ verify, checkBudget, onHostFailure }) {
  if ([verify, checkBudget, onHostFailure].some(fn => typeof fn !== 'function')) throw new TypeError('P256 hooks must be functions.');
  return function p256Precompile({ data, gasLimit }) {
    try {
      checkBudget();
      if (!(data instanceof Uint8Array) || typeof gasLimit !== 'bigint' || gasLimit < 0n) throw new TypeError('Invalid P256 host invocation.');
      const finish = result => { checkBudget(); return result; };
      if (gasLimit < P256_GAS) return finish({ executionGasUsed: gasLimit, returnValue: new Uint8Array(), exceptionError: new EVMError(EVMError.errorMessages.OUT_OF_GAS) });
      const invalid = () => finish({ executionGasUsed: P256_GAS, returnValue: new Uint8Array() });
      if (data.length !== 160) return invalid();
      const [h, r, s, x, y] = Array.from({ length: 5 }, (_, i) => integer(data.subarray(i * 32, i * 32 + 32)));
      if (r === 0n || r >= N || s === 0n || s >= N || x >= P || y >= P || (x === 0n && y === 0n)) return invalid();
      if (y * y % P !== (x * x * x + A * x + B) % P) return invalid();
      const valid = verify({ h, r, s, x, y });
      if (typeof valid !== 'boolean') throw new TypeError('P256 verification returned a non-boolean result.');
      if (!valid) return invalid();
      const returnValue = new Uint8Array(32); returnValue[31] = 1;
      return finish({ executionGasUsed: P256_GAS, returnValue });
    } catch (error) {
      // Preserve even thrown null/undefined outside EVM catch/revert handling.
      onHostFailure(error);
      throw error;
    }
  };
}

// The executor supplies only budget/failure hooks. Verification is always fixed.
export function createP256Precompile(checkBudget, onHostFailure) {
  return _createP256Precompile({ verify: verifySignature, checkBudget, onHostFailure });
}
