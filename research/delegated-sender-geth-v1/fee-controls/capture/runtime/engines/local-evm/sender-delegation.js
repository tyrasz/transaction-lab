// Existing delegation only. This does not apply EIP-7702 authorization lists.
// The fork must come from the trusted execution header, not worker metadata.
export function existingDelegationTarget(code, common) {
  if (typeof code !== 'string' || !common.isActivatedEIP(7702)) return null;
  const match = /^0xef0100([0-9a-f]{40})$/i.exec(code);
  return match ? '0x' + match[1].toLowerCase() : null;
}
