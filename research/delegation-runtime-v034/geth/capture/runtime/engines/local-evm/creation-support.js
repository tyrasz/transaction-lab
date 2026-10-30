import { Account, bytesToHex, KECCAK256_NULL, KECCAK256_RLP } from '@ethereumjs/util';

const EMPTY_CODE = bytesToHex(KECCAK256_NULL), EMPTY_STORAGE = bytesToHex(KECCAK256_RLP);

// The pinned library treats this as a collision; pinned Geth and the execution
// specification instead enter creation, and disagree about old storage. Until
// a fork-specific execution rule is established and implemented, this outcome
// must not become a completed EVM result, even if an ancestor would revert it.
export function storageOnlyCreationAccount(account) {
  return account instanceof Account && account.nonce === 0n &&
    bytesToHex(account.codeHash) === EMPTY_CODE && bytesToHex(account.storageRoot) !== EMPTY_STORAGE;
}

export function unsupportedStorageCreation() {
  const error = new Error('Creation at an account with empty code, zero nonce and nonempty storage is not supported by the verified execution profile.');
  error.code = 'LOCAL_CREATION_STORAGE_UNSUPPORTED';
  return error;
}
