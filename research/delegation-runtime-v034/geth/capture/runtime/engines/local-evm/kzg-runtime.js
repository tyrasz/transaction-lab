import { KzgInputError } from './kzg-point-evaluation.js';

// EthereumJS catches verifier exceptions inside the precompile. Preserve host
// failures outside that catch boundary so an enclosing CALL cannot hide them.
// The executor supplies the fixed verifier; no request can choose an adapter.
export function guardKzgVerifier(verifyProof, checkBudget, onHostFailure) {
  return Object.freeze({
    verifyProof(...args) {
      try {
        checkBudget();
        const valid = verifyProof(...args);
        if (typeof valid !== 'boolean') throw new Error('KZG verification returned a non-boolean result.');
        checkBudget();
        return valid;
      } catch (error) {
        if (!(error instanceof KzgInputError)) onHostFailure(error);
        throw error;
      }
    },
  });
}
