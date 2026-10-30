# Delegation runtime: exact parsing and execution boundaries

Source review at repository `f00b685a773d8508fd1164b2d42edfce4ff3a20b`,
2026-10-30. This memo executes no EVM, client, RPC, or wallet operation. Exact
local source hashes, package provenance, and unsuccessful pinned-EELS retrievals
are recorded in `source-notes.json`. The sibling `probe/` is separate execution
evidence; no result from it is needed to derive the source findings below.

## Required behavior

A delegation indicator is exactly 23 bytes: `ef0100` followed by a 20-byte
address. Code with that prefix and any other length is ordinary bytecode. The
normal leading `0xef` invalid opcode must cause an EVM exceptional halt, not a
host address-construction failure. Such code must not authorize an originating
sender or an authorization overwrite, and must not trigger delegation-target
access, warming, or a delegation surcharge. Pinned Geth enforces this through
one parser reused for execution, gas, sender admission, and authorization
eligibility: [ParseDelegation, lines 37–42](https://github.com/ethereum/go-ethereum/blob/1df30b18d9ed35ee9d28ffd4648442c2204554ad/core/types/tx_setcode.go#L37),
[resolveCode, lines 722–734](https://github.com/ethereum/go-ethereum/blob/1df30b18d9ed35ee9d28ffd4648442c2204554ad/core/vm/evm.go#L722),
[sender admission, lines 599–606](https://github.com/ethereum/go-ethereum/blob/1df30b18d9ed35ee9d28ffd4648442c2204554ad/core/state_transition.go#L599),
and [authorization admission, lines 1126–1140](https://github.com/ethereum/go-ethereum/blob/1df30b18d9ed35ee9d28ffd4648442c2204554ad/core/state_transition.go#L1126).

The final EIP-7702 specification defines one-hop execution for transaction
destinations and all four CALL variants. Following A's valid indicator to B
loads B's code once; if B is itself delegated, its indicator is executed as
bytecode rather than resolving C. Delegating to an active precompile does not
invoke its native function: it executes empty code with sufficient initiation
gas. `EXTCODE*` still observes the account's stored indicator; `CODESIZE` and
`CODECOPY` observe the selected execution code. Sender and authority eligibility
must stay strict even while malformed destination bytecode becomes executable
as an invalid-opcode failure. [EIP-7702, delegation indicator, precompiles, loops,
and transaction origination](https://eips.ethereum.org/EIPS/eip-7702#delegation-indicator).

For a malformed root destination, ordinary transaction preparation and the
outer nonce/fees remain applicable; the entered message fails, undoing its
value transfer and message writes. Applied authorizations remain after this
message failure. This is different from Amsterdam recipient-preparation OOG,
which rolls back preparation. A nested invalid-code call returns failure and
can be caught by its parent; an arbitrary host error must never be converted
into that EVM outcome. See the pinned [call revert and exceptional-gas handling](https://github.com/ethereum/go-ethereum/blob/1df30b18d9ed35ee9d28ffd4648442c2204554ad/core/vm/evm.go#L332)
and [Amsterdam preparation and call execution](https://github.com/ethereum/go-ethereum/blob/1df30b18d9ed35ee9d28ffd4648442c2204554ad/core/state_transition.go#L887).

## Concrete pinned EthereumJS discrepancy

Installed `@ethereumjs/evm` is 10.1.3. These are the exact production dependency
files, also byte-identical in the separate fixture dependency tree:

| Site | Local source lines | Source behavior |
| --- | --- | --- |
| Code dispatch | `engines/local-evm/node_modules/@ethereumjs/evm/dist/esm/evm.js:1303–1328` | Prefix-only test, then `new Address(code.slice(3,24))` |
| Amsterdam top recipient charge | same file, `388–409` | Prefix-only test; charges cold/warm access based on `slice(3,23)` |
| CALL-family dynamic gas | `.../evm/dist/esm/opcodes/gas.js:22–40`, callers `495/515/544/722` | Prefix-only test, with `slice(3,24)` passed to address-access logic |
| Address validation | `.../util/dist/esm/address.js:8–12` | Throws a host error unless the byte array is exactly 20 bytes |
| Signed full-VM admission | `engines/fixture-evm/node_modules/@ethereumjs/vm/dist/esm/runTx.js:119–126,591–604` | Authority and sender eligibility are also prefix-only |

For full prefix lengths 3 through 22, `_loadCode` supplies fewer than 20 bytes
to `Address`; for length 24 or greater it supplies 21. This is a source-derived
host-failure path, not an observed successful delegation. Amsterdam may instead
halt earlier on its erroneous delegation charge when gas is short. The affected
gas helper is shared by CALL, CALLCODE, DELEGATECALL, and STATICCALL; correcting
only `_loadCode` does not correct charging or warming.

Nested exact indicators already stop after one hop in `_loadCode`, matching
Geth's one-hop resolver. The loaded second indicator then reaches the normal
invalid-opcode handler (`interpreter.js:254–256`). The product's owned
`sender-delegation.js`, `authorization-list.js`, and `amsterdam-authorization.js`
already require the exact shape; their eligibility rules should not be relaxed.

## Fork and gas distinctions

Prague and the admitted later pre-Amsterdam forks activate EIP-7702. Geth's
pre-Amsterdam root path warms the final recipient's valid delegation target
before entering the call (`state_transition.go:904–914`). Internal calls pay
2600 cold or 100 warm target access in addition to the ordinary account/call
costs (`operations_acl.go:371–425`). Malformed indicators get neither action.

The pinned Amsterdam schedule changes cold access to 3000 and charges root
delegation resolution at runtime, warm access remaining 100
(`state_transition.go:1009–1038`, `operations_acl.go:354–358,500–514`). The
current EIP-2780 text independently describes this root charge and distinguishes
runtime OOG from transaction invalidity. It is presently **Last Call**, not
Final; this memo does not infer network activation from that document status.
Use the product's trusted chain/header schedule and pinned implementation for
actual admission. [EIP-2780 runtime charges and interactions](https://eips.ethereum.org/EIPS/eip-2780#account-creation-and-access-charges).

Before EIP-7702 activation, even an exact 23-byte indicator is ordinary code.
No delegation resolution should be introduced for Shanghai/Cancun. Mainnet
versus Sepolia fork admission remains a separate, trusted configuration decision.

## EELS corroboration and provenance limitation

Current official Amsterdam EELS documentation requires exact length 23 at
`eoa_delegation.py:58–61`; its resolver and gas predicate return the original
address/no delegation charge for non-indicators (`98–109`, `174–188`). Its
authority check uses the same strict predicate (`218–226`). The interpreter
selects code once and disables precompile dispatch on delegated destinations
(`194–217`, `437–447`). These support the parsing and one-hop conclusions, but
the rendered pages are **unpinned current documentation**.
[EELS delegation module](https://steel.ethereum.foundation/docs/execution-specs/specs/reference/src/ethereum/forks/amsterdam/vm/eoa_delegation.py.html),
[EELS interpreter](https://steel.ethereum.foundation/docs/execution-specs/specs/reference/src/ethereum/forks/amsterdam/vm/interpreter.py.html).

The prior research commit `e27f097ec7b3e6e8ee9c2c1873c183e8f7da7a6e`
could not be retrieved for the Prague or Amsterdam delegation module through
raw, GitHub blob, or API URLs. No local source bytes or SHA-256 are claimed for
those files. The available current docs must not be represented as that pin.

One narrower arbitrary-prestate caveat remains: if an active precompile address
itself has nonempty stored code, EJS `_loadCode` and Geth `resolveCode` fetch that
code through a delegation, whereas current EELS skips both native and bytecode
dispatch at that delegated precompile. This is a source-derived edge, not a
demonstrated reachable-chain discrepancy. Ordinary empty-code precompile
accounts behave as specified; do not broaden this malformed-length fix based
on the hypothetical state.

## Smallest maintainable correction

Prefer an explicitly pinned, reproducible dependency patch for the three EVM
predicates above: require length 23 in addition to the existing prefix test.
Keep the surrounding loading, access pricing, and error handling intact. Bind
old/new file hashes and exact replacement counts; fail closed on unexpected
dependency bytes. Apply only to the current runtime trees, never archived
evidence. Preserve the patch and resulting identities in future source closure.

An owned adapter is acceptable only if it covers all three sites. The public
`customOpcodes` option can replace CALL-family gas handlers, but cannot by itself
repair `_loadCode` or root recipient preparation. Reimplementing those large
handlers is more maintenance than three strict predicates. Blanket `getCode`
masking is unsuitable: it alters EXTCODE observations and destroys the actual
invalid bytecode. No private global monkey patch or swallowed host exception
should substitute for explicit ownership of the correction.

Owned parent follow-through is required: the current recipient-only rejection
in `amsterdam-authorization-validation.js:114` rejects malformed prefixed code
before deriving `delegatedTo`. Replace that rejection with ordinary nondelegated
recipient handling when integrating corrected execution. Keep exact sender and
authority eligibility. Otherwise a genuine invalid-opcode message after valid
authorizations will still be rejected by parent consistency validation.

Later bounded validation should distinguish lengths 3/22/23/24, root and four
CALL modes, cold/warm and low-gas paths, one-hop chains/loops, direct versus
delegated precompiles, EXTCODE versus execution-code observations, and entered
message failure retaining authorization preparation. Compare against pinned
Geth, not unpatched same-library behavior, and retain any unavailable result.
This is a proposed matrix, not execution evidence or a request to broaden scope.
