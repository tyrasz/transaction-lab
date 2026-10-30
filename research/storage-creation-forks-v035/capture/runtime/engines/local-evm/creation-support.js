import { Account, bytesToHex, KECCAK256_NULL, KECCAK256_RLP } from '@ethereumjs/util';

const EMPTY_CODE = bytesToHex(KECCAK256_NULL), EMPTY_STORAGE = bytesToHex(KECCAK256_RLP);

// This target passes the trusted runtime's nonce/code collision rule but needs
// an authenticated namespace clear before the constructor begins. Do not infer
// empty storage from empty code, or use this predicate for ordinary CALLs.
export function storageOnlyCreationAccount(account) {
  return account instanceof Account && account.nonce === 0n &&
    bytesToHex(account.codeHash) === EMPTY_CODE && bytesToHex(account.storageRoot) !== EMPTY_STORAGE;
}
