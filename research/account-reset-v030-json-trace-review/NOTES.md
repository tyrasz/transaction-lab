# Independent review of the separate JSONL correction

The corrected capture verifies **15 matched, 0 mismatched, 0 unavailable, 0 unattempted** across the same five fixed Shanghai sequences. The original capture remains **5 matched / 10 unavailable**. This review executed no product, VM, Geth, or network requests.

The original product outputs and expectations were not recomputed by the correction driver. All 53 inherited input/product/expectation/seal/manifest files match the externally pinned first capture. The correction made 15 additional Geth prefix executions (33 signed transaction occurrences), changing only tracing flags. Signed transaction bytes, initial allocations, environments, order, binary and expected values remained fixed. This is an explicitly retained correction, not a replacement of the first results.

The artifact-only verifier checks 4,205 captured entries and 4,025 runtime entries, including one symlink; the original runtime is preserved and exactly four reviewed protocol files are added. All additional Geth interpretation sources match the pinned source inventory. It checks all raw process streams, exact arguments, signed prefix bodies, process bounds, complete expected output inventories, byte totals and saved comparison rows. It never uses recorded absolute command paths for dispatch.

A separate recursive parser independently decodes all 33 JSONL trace files: 551 records, 65 balanced call-frame occurrences and 421 opcode records. Every root entry binds sender, destination, calldata, value and Shanghai message gas. Nested exits, caught constructor/helper reverts and SELFDESTRUCT pseudo-frames cannot impersonate the final root exit. All final root outputs and raw message-gas amounts agree with the original product. Receipt charged gas is compared separately, with signature/hash/index/type/status and cumulative gas bindings. All 15 full-state roots, internal committed-log hashes, gas, root execution statuses and return-data channels agree. There are no empty or missing traces in this correction.

The original artifact audit is rerun using only signatures, cryptographic proofs and fresh MPT construction: 27 raw proof calls, 53 proof/code joins, five initial roots and 15 cumulative product/reset roots. Each of the 15 new Geth allocation dumps is independently reconstructed into a fresh trie and matches the corresponding product root. This preserves cleared storage namespaces and old-equal code/nonce/storage semantics without relying on the producer's delta application function.

Observed returns include balance7/empty-code information after funding a deleted account, getter42 after both recreation cycles, zero address after the caught constructor revert, and getter43 after reverted helper recreation. These are saved outputs from the fixed synthetic declarations. All transaction roots succeeded; failures exercised here are caught nested failures. All committed logs are empty, so this packet adds no nonempty-log comparison.

The product path is the proof-backed core with a retained manager, not a public sequence API or isolated parent validation. Geth provides independent opcode/state-finalization evidence; audit proof/signature/MPT primitives come from the archived EthereumJS packages and do not execute opcodes. The synthetic headers are self-consistent hashes, not consensus-verified mainnet blocks. Saved timing diagnostics and inventories are checked, not independently attested. This fixed development corpus implies no population accuracy or universal EVM coverage.

## Pins

- Correction manifest: `d30cb0b469207d79262b52060cad882d850a3999c41b1203d300a7000115152a`
- Correction plan: `d2a71df7063345a1d8fff2631eff95b09af53d2fb72ce58e6219be8f3cb00101`
- Correction runtime source: `69270fe90db8480493c675ae6265124ef6f034ecd2088c13df2d964aa720a14a`
- Original manifest: `df41304fda31c7fe06112352efb79b0734dc00c4fd9c09c08072f6985746cdd1`
- Original independent review manifest: `486e8d682331e16491777ae6b96ac9284937e64739555b6baf840b351e6ed3f9`
- Unchanged Geth binary: `10385eddbfd76c3d05b9853f30f4372f2468f6a8c1ac64c445a7490694fc3521`

## Reproduce the artifact-only audit

From the repository root:

```sh
node research/account-reset-v030-json-trace-review/verify.mjs
node --test research/account-reset-v030-json-trace-review/verify.test.mjs
```

The verifier optionally accepts correction-capture and original-capture directory arguments. Keep the original independent review beside this directory because its pinned verifier and reset/proof controls are dependencies. Eight controls cover the full saved packet, actual nested revert and SELFDESTRUCT framing, truncation/nested-only exits/trailing records, malformed UTF-8/schema/depth, wrong root input/gas, valid channel mismatches, and substituted receipt/body identities. `report.json` and `controls.tap` retain the results. The review manifest binds these supplemental files; neither sealed capture is modified.
