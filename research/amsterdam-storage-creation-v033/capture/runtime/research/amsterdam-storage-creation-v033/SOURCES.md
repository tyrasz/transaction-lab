# Storage-only creation: source investigation

This is a source-only investigation made before the diagnostic executions. It
does not report a public transaction, client run, consensus result, or activated
EIP-7610 rule. The synthetic parent tests use declared frame records and genuine
MPT proofs; their records are fabricated regression inputs, not retained worker
observations.

## Protocol inclusion

Official pages read on 2026-10-30:

- [EIP-684](https://eips.ethereum.org/EIPS/eip-684), Final: creation collision is
  specified for nonzero nonce or nonempty code.
- [EIP-7610](https://eips.ethereum.org/EIPS/eip-7610), Last Call: proposes adding
  nonempty storage, retroactively, and expressly requires a hard fork. Its
  rationale explains historical pre-Spurious-Dragon storage-only accounts;
  the current numerical population claim was not independently verified.
- Inclusion lists [Pectra/EIP-7600](https://eips.ethereum.org/EIPS/eip-7600),
  [Fusaka/EIP-7607](https://eips.ethereum.org/EIPS/eip-7607), and
  [Glamsterdam/EIP-7773](https://eips.ethereum.org/EIPS/eip-7773) do not list
  EIP-7610. The latter lists Sepolia activation timestamp 1791294816 and no
  mainnet activation timestamp. Status alone is not used as activation proof.
- Pinned EthereumJS Common's `dist/esm/hardforks.js:201` Amsterdam EIP list and
  `eips.js` contain no EIP-7610 entry, despite the EVM's unconditional root
  storage-collision condition.

## Pinned Geth source

Geth 1.17.10 commit `1df30b18d9ed35ee9d28ffd4648442c2204554ad`, retained under
`outputs/evm-toolchains/geth-v1.17.10/source`:

- `core/vm/evm.go:506–548`: preflight checks precede Amsterdam account-creation
  state charging. A zero-balance storage-only account is EIP-161 empty and can
  incur that charge; the funded balance-17 diagnostic target does not.
- `core/vm/evm.go:550–645`: creator nonce increments; target is warmed; the
  actual collision predicate at 584–599 tests nonce and code only. The nearby
  storage-only-collision comment does not add a storage-root test. The shared
  creation path creates an account only when absent and has no storage clear.
- `core/state/statedb.go:673–683`: `CreateContract` sets `newContract` and
  journals that flag; it does not replace the account or clear its storage.
- `core/state/state_object.go:164–218`: `GetState`/`GetCommittedState` still read
  original storage unless the account was actually destructed. The new-contract
  flag is not a storage namespace reset. This preservation path applies across
  forks, not only Amsterdam.
- `core/vm/instructions.go:635–734` and `core/state_transition.go:835–883` bind
  the internal and root creation gas paths. Internal creation forwards 63/64
  execution gas; failed creation refills any account state charge. Root
  exceptional failure drains remaining execution gas while preserving the
  restored state reservoir.

The source predicts deployment with preserved old storage. The separate packet
must establish actual pinned-tool behavior; this memo does not substitute for it.

## EthereumJS and EELS distinction

Installed EthereumJS EVM 10.1.3 source:

- `dist/esm/interpreter.js:995–1021`: after the real creator nonce increment,
  Amsterdam checks nonce/code/storageRoot. Collision returns zero without a
  child message, consumes the forwarded regular gas, adds target BAL access,
  and refunds an account state precharge if one occurred. Parent rollback
  discards the creator increment; caught failure retains it.
- `dist/esm/evm.js:657–678`: root and historical entered creation also reject
  nonempty storage. This happens before `clearStorage` and `newContract`, so a
  guard attached only to successful deployment misses it.

Official EELS sources read through the web tool, not copied as raw source bytes:

- Pinned commit `e27f097ec7b3e6e8ee9c2c1873c183e8f7da7a6e`,
  [Amsterdam interpreter](https://raw.githubusercontent.com/ethereum/execution-specs/e27f097ec7b3e6e8ee9c2c1873c183e8f7da7a6e/src/ethereum/forks/amsterdam/vm/interpreter.py):
  lines 305–369 explicitly clear old storage at 329 before running the
  constructor, mark the created account, and restore state on failure.
- Same pinned commit,
  [system instructions](https://raw.githubusercontent.com/ethereum/execution-specs/e27f097ec7b3e6e8ee9c2c1873c183e8f7da7a6e/src/ethereum/forks/amsterdam/vm/instructions/system.py):
  `generic_create` lines 96–120 use `account_deployable`; the collision comment
  identifies nonce/code targets and the no-child outcome consumes its grant.
- [Current Amsterdam state tracker](https://raw.githubusercontent.com/ethereum/execution-specs/master/src/ethereum/forks/amsterdam/state_tracker.py)
  lines 338–346 defines deployability by nonce/code only. The pinned version of
  this particular file could not be fetched by the web tool (cache miss).
  Consequently this current predicate is not claimed as a retained byte-level
  observation of that pinned commit. `source-notes.json` separately records
  acquisition limitations; no installed EELS execution was available.

Thus the source comparison distinguishes EthereumJS collision, Geth deployment
with preserved storage, and EELS deployment with cleared storage. It does not
promote whichever implementation happens to match a test into a consensus rule.

## Product boundary and diagnostic discriminator

Until the fork-specific discrepancy is resolved, the product should return
unsupported for actual storage-only creation attempts and roll back the whole
attempt. Ordinary account reads and pre-target-access CREATE failures remain
eligible. Authenticated deletion/reset overlays must use their current empty
namespace, rather than the immutable old storage root. A target with a genuine
current nonce or code still has an ordinary collision.

A useful declared constructor is `606354600155600060005360016000f3`: copy slot
99 into slot 1, then deploy one STOP byte. With initial slots 99=9 and 991=11,
the three interpretations yield distinguishable status and postallocation:
collision; successful deployment with slots retained/copied; or successful
deployment with old storage cleared. These are source-derived hypotheses, not
expected outputs fed into a target execution.
