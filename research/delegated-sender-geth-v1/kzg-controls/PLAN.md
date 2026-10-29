# Fixed KZG point-evaluation development controls — preparation only

This document declares sixteen cases before execution. The product baseline is `ae2438742f9b5429f83e266196cb037f4e131795`. No case has been frozen or executed by this harness. Preparation controls may construct initial tries, headers and signatures, check fixed declarations, and exercise synthetic process/parser/seal controls; they must not run any selected product, full-VM or Geth target. Freeze and dispatch require separate review and authorization. There is no public RPC, broadcast, retry, replacement case or population-accuracy claim.

The source-copy, durable product seal, artifact ledger, raw process, dual-clock and terminal withholding protocol is adapted from committed `research/delegated-sender-geth-v1/blob-controls` at `28f08f282c4c1c9e0b046cbb5f1b1c0b825db93e`. The existing pinned Geth classifier remains `../run.mjs`, included in the source archive. This extension is within that existing development-comparison family; it does not alter prior captures.

## Exact common declaration

Every case is a signed type-2 counterpart of the same declared unsigned priced product call. The execution profile is `unsigned_eip1559_block_end`, base fee 7 wei, maximum execution fee 13 wei/gas, maximum priority fee 3 wei/gas, sender nonce 1, sender balance 1,000,000,000,000 wei and outer value 19 wei. The sender is the synthetic fixture key's address. TARGET has nonce 1, balance 100 wei, empty initial storage, and the declared code (STOP for direct cases). It remains a separate initial account even when the transaction directly targets `0x000000000000000000000000000000000000000a`. Coinbase has nonce 1, balance 1 wei, empty code and empty storage. Default gas is 200,000. There is no access list, authorization list or blob-hash list.

All initial accounts—including the inherited lifecycle fixture's separate FACTORY and SENDER accounts—are retained identically in the product proof source, full VM and Geth prestate. All three receive the complete frozen allocation; only the product demands sparse proof/code inputs from it. No output-derived state supplies an execution input.

Headers are **synthetic authenticated headers**, with production mainnet fork selection and field encoding. They are not public-chain observations. The fixtures use mainnet activation timestamps for Cancun, Prague, Osaka, BPO1 and BPO2, rehash every header after installing the initial MPT root and exact fee fields, and independently verify that hash and fork. Current `excessBlobGas` and `blobGasUsed` are explicitly zero in every case. Other header fields come from the existing pinned fixture; all bytes will be frozen. These type-2 calls pay no blob fee. The BPO headers use the existing `blobFeeFixture` with the explicit type-2 profile, rather than extending or modifying a production fork helper.

## Fixed order and bytecode

`KZG_INPUT` is the single exact official Geth `pointEvaluation1` vector retained in `engines/local-evm/test/fixtures/kzg-point-evaluation/upstream/pointEvaluation.json`, SHA-256 `e831a6e4b7c848ae012e75adfe7724caeb95e2ecb79af7e853e26ccdbe5cdc9d`. Its 192 input bytes and original expected bytes are retained, but expected bytes are not passed to product execution. The full original file/provenance/setup/structural vectors/licenses are included in the future source inventory.

| ID | Name | Fixed execution input |
| --- | --- | --- |
| 001 | cancun_direct_official_point | Cancun, direct 0x0a, original official input |
| 002 | prague_direct_official_point | Prague, direct 0x0a, original official input |
| 003 | osaka_direct_official_point | Osaka, direct 0x0a, original official input |
| 004 | bpo1_direct_official_point | BPO1, direct 0x0a, original official input |
| 005 | bpo2_direct_official_point | BPO2, direct 0x0a, original official input |
| 006 | nested_call_value | Osaka TARGET CALL to 0x0a, value 5, requested child gas 50,000 |
| 007 | nested_callcode_value | Osaka TARGET CALLCODE to 0x0a, value 5, requested child gas 50,000 |
| 008 | nested_delegatecall_value | Osaka TARGET DELEGATECALL to 0x0a, inherited outer value 19, child gas 50,000 |
| 009 | nested_staticcall | Osaka TARGET STATICCALL to 0x0a, child gas 50,000 |
| 010 | nested_staticcall_caught_oog | Osaka TARGET STATICCALL to 0x0a, child gas 49,999; parent persists its observations |
| 011 | nested_call_enclosing_revert | Same CALL/value/gas setup as 006, followed by enclosing REVERT |
| 012 | direct_incorrect_proof | Osaka direct 0x0a; change only the original input's 32-byte y to y+1 |
| 013 | direct_malformed_proof | Osaka direct 0x0a; replace only the last 48 proof bytes with zero bytes |
| 014 | direct_zero_polynomial_infinity | Osaka direct 0x0a; commitment and proof `0xc0 || zero[47]`, z=0, y=0, matching versioned commitment hash |
| 015 | direct_exact_precompile_gas | Cancun direct official input; total gas = exact calldata intrinsic + 50,000 |
| 016 | direct_below_precompile_gas | Cancun direct official input; total gas = exact calldata intrinsic + 49,999 |

Cases 006–011 copy the original root calldata to memory and use the fixed helper to invoke 0x0a. Prefix `602a600355` writes 42 to slot 3. The exact normal tail is:

```text
60405260005160005560205160015560405160025560a160606000a160606000f3
```

It stores the returned 64 bytes and CALL success flag into slots 0, 1 and 2, emits LOG1 topic `0xa1` with those 96 bytes and returns them. Case 011 changes only the final RETURN (`f3`) to REVERT (`fd`); its parent writes and log should roll back if execution follows that path. CALL/CALLCODE value transfer grants the ordinary 2,300-gas stipend in addition to the requested child gas; the declarations do not disguise this as an exact 50,000 entered gas limit. A failed precompile returns no bytes, so the overlapping output memory retains the first 64 input bytes; the success flag is zero. These are input/bytecode semantics declared before execution, not replacements selected from observed results.

The infinity input's versioned hash is `0x01 || SHA256(commitment)[1:]`; no proof generation or trusted-setup change is allowed. Cases 015/016 use the exact zero/nonzero calldata intrinsic cost under Cancun. They do not subtract an invented root CALL surcharge. Preparation tests independently count calldata bytes and compare the selected total gas.

All sixteen transaction envelopes are structurally valid. Invalid precompile inputs and ordinary execution failures remain in the denominator. The selection avoids the previously identified empty-account/nonempty-storage Geth commit-path limitation; no result may be removed after execution.

## Input and reference separation

The product is the archived production `executeIsolatedEthereumCall`, with fixed proof-only inputs from the immutable synthetic prestate. Its output is durably saved and hash-sealed before the separate reference process starts. The reference executes a signed type-2 transaction from the same allocation/header/request through full EthereumJS VM admission, settlement and finalization. It installs the exact same fixed KZG verifier as the product and shares the pinned opcode library. It is explicitly a **shared-crypto/shared-opcode diagnostic**, not an independent implementation of KZG.

Only after the full VM completes does a third fresh MPT receive the product's validated deltas. Reference output never supplies product inputs. Product deltas that cannot be applied yield no invented state root. The full-VM comparison records state, logs, return, execution status and charged gas, retaining disagreements or exceptions. No full-VM disagreement substitutes its root for the product-derived expectation.

The signed body is canonical type-2 RLP. The adapter independently binds chain ID, recovered sender, initial nonce, destination, value, calldata, gas, fee caps and ordered access list against the frozen declaration; unknown fields and blob/authorization contexts reject. Geth JSON is derived from that bound body. Each state test has exactly one data/gas/value choice and index 0. All storage words are canonical 32-byte values with unchanged integers.

All available product-derived state-root and log-hash expectations are sealed before any Geth invocation. The pinned Geth v1.17.10 binary performs its own point-evaluation implementation and transaction/state path. Compared channels are **full poststate root and Geth's internal product-log-hash assertion**. No separate Geth return, receipt or gas channel is claimed. The nested persisted words/logs make their precompile outputs sensitive to those channels; direct calls' returned bytes are separately checked only by the shared-library diagnostic. Nonzero fees make charged gas state-root-sensitive without creating a separate gas-output channel.

This checks executed single-point proof calls. It does not validate blob sidecars, a whole blob, block-body capacity, transaction inclusion, consensus, public-chain prevalence, or arbitrary Ethereum execution. No BLOCKHASH, authorization processing, root creation or block system call is declared.

## Frozen provenance and resource bounds

Freeze must copy/read back the actual local/fixture runtime, complete installed dependency trees, package metadata, all required helpers and KZG fixture provenance, this six-file harness, baseline header evidence and exact Node identity. Every non-dependency product/helper file must be tracked and byte-equal to baseline `ae2438742f9b5429f83e266196cb037f4e131795`; the repository protocol commit is recorded separately. The external Geth binary is hash-bound to `10385eddbfd76c3d05b9853f30f4372f2468f6a8c1ac64c445a7490694fc3521`, source commit `1df30b18d9ed35ee9d28ffd4648442c2204554ad`, with the existing toolchain/source/dependency inventories retained. No installation or download occurs in this harness.

Limits: 16 cases; 20 seconds and 16 MiB output per product/reference worker; 360 seconds preparation; 5 seconds and 1 MiB output per Geth invocation; 120 seconds Geth phase. Both phases use wall and monotonic clocks, reject clock reversal, and check terminal elapsed time. Product child limit is 10 seconds plus a 1-second drain, within its worker cap. The parent host's synchronous declaration/integrity work is included in the phase deadline; it is not claimed to be independently killable while a synchronous filesystem operation is in progress.

Every dispatched raw process result and stream is retained. Exact artifacts are checked against the durable hash ledger before expectation sealing and terminal success. All sixteen positions remain, including unavailable or unattempted positions. Save errors, source drift, malformed output, killed/nonzero processes and terminal timing failures cannot become a successful comparison. A fatal or terminal integrity/timing failure marks the packet unusable even if individual observed rows matched. No capture file is overwritten and no target is retried.

Original absolute source/capture/process paths remain provenance. Later relocation must compare recorded arguments to the original declaration while reading files in their new location; it must not rewrite sealed paths. Exact Node and external Geth identities remain replay requirements.

Preparation command only:

```sh
node --test research/delegated-sender-geth-v1/kzg-controls/run.test.mjs
```

After separate review and authorization, the reviewed `freeze DIR`, `check DIR PLAN_SHA`, and `run DIR PLAN_SHA` protocol can be used once. This plan does not authorize that dispatch and records no target outcomes.
