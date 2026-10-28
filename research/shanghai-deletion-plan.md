# Shanghai SELFDESTRUCT: bounded local preview support

This design applies to the authenticated Ethereum Shanghai header profile in
0.20. It does not add earlier forks, signed transaction validation, fee
settlement, a recomputed post-state root, or general reliability claims.

## Semantics and implementation boundary

Before Cancun, a committed SELFDESTRUCT schedules its execution account for
whole-account deletion regardless of when the account was created. Its current
balance transfers immediately to a different beneficiary; a self-beneficiary
burns that balance immediately. Code and storage remain accessible during the
invocation, so a scheduled account may receive funds, execute again, and
transfer funds again. Final deletion also removes any remaining refill. The
Cancun rule remains the created-in-this-invocation intersection described by
[EIP-6780](https://eips.ethereum.org/EIPS/eip-6780).

Final SELFDESTRUCT deletion precedes transaction-end empty-account cleanup.
An EIP-161 empty account has zero nonce and balance and empty code; its storage
root need not be empty. Whole-account deletion therefore covers undemanded
storage without inventing individual slot deltas. Ordinary reverted child
touches/deletions do not commit; the pinned RIPEMD160 sticky-touch exception
remains confined to the separately validated EIP-161 cleanup path.
[EIP-161](https://eips.ethereum.org/EIPS/eip-161),
[EIP-158](https://eips.ethereum.org/EIPS/eip-158).

The pinned EthereumJS 10.1.3 implementation was inspected in
`@ethereumjs/evm/dist/esm/interpreter.js` (`_selfDestruct`), `evm.js` (message
checkpoints and creation), and `journal.js` (touch rollback and cleanup), plus
`@ethereumjs/vm/dist/esm/runTx.js` (`processSelfdestructs`). `runCall` alone
does not perform the full transaction-end deletion and cleanup phases. Our
explicit finalization runs inside the wrapper's outer rollback checkpoint;
host/resource failures must roll it back, including the unsigned sender nonce.
An EVM revert instead retains the expected nonce and any justified sticky
RIPEMD160 cleanup, with no committed SELFDESTRUCT deletion.

## Output and parent validation

`output.lifecycle.finalizedDeletions` retains the existing optional shape:

```json
{
  "address": "0x…",
  "scope": "entire_account_including_code_and_storage",
  "initialStorageRoot": "0x…"
}
```

Rows are unique, sorted, bounded, and emitted only for actual finalizations.
The initial root comes from the immutable, independently reverified account
proof. Shanghai permits nonempty initial code, nonce and storage. A committed
own-frame `selfdestruct: { beneficiary }` identifies the execution address;
it is not a deletion of a DELEGATECALL's code address.

The parent derives `selfdestructOnlyCreated` from
`ethereumCommon(trustedHeader).isActivatedEIP(6780)`, independently of the
child's claimed environment. Direct validator callers default to `true` for
backward compatibility. The Shanghai required set is all committed
SELFDESTRUCT execution addresses; Cancun requires committed creation as well.
Every ancestor's `from`, `caller`, `to` and `executionAddress` context remains
bound, and reverted ancestors exclude descendant deletions.

An initially existing Shanghai account has exactly this base-relative net row:

```json
{
  "address": "0x…",
  "existence": {
    "before": true,
    "after": false,
    "basis": "shanghai_selfdestruct_deletion"
  }
}
```

If its original balance was positive, an exact original-balance-to-zero field
is also required. No nonce, code or per-slot fields accompany whole-account
deletion. This basis also applies to an initially existing prefunded creation
target. An initially absent account created and deleted in the invocation has
no net account row. Cancun's existing
`same_invocation_created_contract_deletion` basis is unchanged.

The bounded native ledger follows committed call-entry transfers, ordered
children and each frame's terminal SELFDESTRUCT. Shanghai self-beneficiaries
are zeroed immediately, before later refills. Finalization zeroes each deleted
account again. This remains trace/output consistency checking, not a second
EVM or a cryptographic post-state proof.

## Disposable query overlays

Queries inherit the original overlay on a copy. A carried deletion must remain
unchanged, and absent code or undemanded storage must never be resurrected from
the immutable prestate. A query may encounter a contract created by the original
invocation even though its immutable account proof establishes absence. Its
carried creation row and proven deployable base permit lifecycle validation;
destroying it still changes the query's before/after overlay and makes that
measurement unavailable. Merely claiming a carried deletion never establishes
that code exists to execute SELFDESTRUCT again.

The state manager's reset marker covers the complete account namespace and is
preserved by checkpoints and copies. Positive rematerialization after deleting
an account with original nonempty code, nonempty storage root, or nonzero nonce
remains unsupported until an explicit account-reset provenance schema exists.
This avoids presenting a balance-only row while silently resetting original
nonce/code/storage. Existing initially deployable empty-root recreation remains
within the earlier supported boundary.

## Focused verification

`test/shanghai-parent.test.js` uses actual isolated workers and synthetic MPT
proof/code inputs, never provider trace/poststate inputs. It covers unknown
initial storage deletion, zero/positive original balances, immediate self-burn
and refills, delegate context, root revert, absent/prefunded constructor
deletion, omitted/duplicate/wrong-root/wrong-basis/partial deletion rows, trusted
fork selection, carried deletion, original-created then query-destroyed state,
and hostile getter/proxy output shapes. Existing Cancun and EIP-161 parent
controls remain in their own suites. These are deterministic development
controls, not live-provider comparisons or a measured coverage rate.
