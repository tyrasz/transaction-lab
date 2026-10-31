# Two public delegated-wallet calls at one new Ethereum header

October 31, 2026. This selected development comparison retains both previously unsupported calls from ordinary-local-coverage-v1, cases 002 and 015. It evaluates their unchanged projected envelopes at **block 26,312,105**, hash `0x59dcdd6b3ccf74ff760c0db757a2e29ae7c7d96aa422ee6375644b740b332138`. It does not replay their original transaction positions or alter either historical packet.

Both current sender proofs contain exact existing EIP-7702 designations. The guarded local API completed both originals. Case 002 failed with an invalid-opcode exception; case 015 successfully transferred 95 USDT. The frozen first adjudication reported **nine matched channels, zero mismatches and one unavailable exception-class comparison**. The provider spells the first exception `invalid opcode: INVALID`; the original comparator recognized `invalid opcode` but omitted that exact additional spelling.

The narrow working-comparator correction admits that spelling, based on Geth's [ErrInvalidOpCode formatting](https://raw.githubusercontent.com/ethereum/go-ethereum/v1.16.5/core/vm/errors.go) and [INVALID opcode name](https://raw.githubusercontent.com/ethereum/go-ethereum/v1.16.5/core/vm/opcodes.go). This supports the error-class interpretation, not an attestation of the public provider's client build. Unknown spellings remain unavailable. A separately retained, saved-only amended adjudication produces **10/10 matched channels for these two calls**. It verifies the original packet and original JSON result, checks 4,030 unchanged source files plus the exact comparator revision, and rejects any change to another comparison channel. It executes no targets and makes no network requests. The original 9/1 result is unchanged.

| Fixed case | Actual result on both paths | Charged gas | Original comparison | Amended comparison |
| --- | --- | ---: | --- | --- |
| delegated-usdt-002 | Failed invalid opcode; empty return and committed logs; only sender nonce 111 → 112 retained | 5,000,000 | Four matches, exception class unavailable | Five matches |
| delegated-usdt-015 | Successful 95-USDT transfer; empty return; one Transfer log; sender nonce and two USDT storage slots change | 63,209 | Five matches | Five matches |

The five channels are execution status/exception class, exact return data, committed logs, charged gas and full observed sparse net state changes. The four local balance measurements are retained as display evidence but are **not independently compared**. They report unchanged balances for the failed call, and sender/recipient deltas of −95,000,000/+95,000,000 raw USDT units for the successful call. These measurements are not four additional accuracy cases.

## Execution and retained evidence

The [frozen plan](../delegated-sender-current-v038/capture-001/runtime/research/delegated-sender-current-v038/PLAN.md) fixes the two original envelopes, one fresh header, four worker slots, the public endpoint and finite ceilings. A separate raw four-request trace/diff reference avoids the Standard API's existing code-free-sender restriction without modifying that production filter. Both local packets sealed before either reference ran. No amount, sender, state, allowance or source was changed during execution; no retry, reselection, signature or broadcast occurred.

All four workers completed and sealed within their limits. The target interval, including terminal verification, was **23.061 seconds**. Header selection took 153 ms, and the first native target child started 1.164 seconds after latest-header receipt. Total usage was **39 read-only requests and 398,047 response bytes**: three header-selection calls; 14 local calls per case; four reference calls per case. Source, native-I/O drainage, isolated-child closure, original-write ledger and terminal checks passed. The original saved adjudicator verified 4,169 manifest entries and 4,031 runtime files.

The shared process helper was extracted from the prior lending runner without changing its retained captures; its existing 93 controls passed. The new family plus shared-helper controls passed **46/46** before preparation. All four preparation-only workers passed with zero network calls and no VM execution. Initial fixture/argument failures remain in their first logs alongside corrected results. The exception amendment has **4/4 focused controls**, including one actual synthetic invalid-opcode execution and independently altered raw/gas/log/state evidence, followed by **29/29 comparator/adapter regression controls**. The saved-amendment boundary has **2/2 pure controls**. These test counts are separate from public transaction observations.

The first amended-script invocation failed before reclassification because an internal `report: undefined` field is omitted at the original JSON boundary. The second compares the exact original serialized CLI response and passes. Peer review then required a terminal whole-packet check after rereading the evidence, in addition to the initial packet validation and terminal source checks. The third invocation includes that check and passes with the same 10/10 channels. All three observations remain retained; none executed a VM or made public RPC calls.

The separate [independent outcome audit](OUTCOME-AUDIT.md) rehashes the header, walks 30 account/storage proofs without the product's proof verifier, joins all 39 actual responses, and independently recomputes gas, logs and sparse state changes. It agrees on the ten interpreted channels while retaining the original comparator's 9/1 classification. RLP and Keccak primitives are shared libraries; this is independent saved-evidence checking, not another bytecode execution or a new provider observation.

The [staged-packet audit](index-audit-first.json) verifies exact Git inventory membership and all staged blob bytes for 4,170 capture files (42,439,554 bytes) and 41 preparation files (3,687,819 bytes), including normally ignored dependencies. Raw first-failure logs and frozen third-party source whitespace remain unmodified.

## Pins and reproducibility

| Artifact | SHA-256 |
| --- | --- |
| Offline preparation manifest | `d7bc4c4fb3199ba1393fd2a8e3012155d1e8b8aa3f0ec84b1fe0af93f1a4ae7e` |
| Frozen intent | `f89ace8fabaea373b0226cb7cefb68ea6c4b59531cf317eae1da24a5ac8fdb54` |
| Intent manifest | `62828717c475e3636aee14f045a55800c9d2bd15cd956f3fe799723bd5372889` |
| Runtime source manifest | `c8fca41fdf87f8d367908a487955720a09d4403293e776666df2b0638d6a0469` |
| Selected input plan | `fe7c07a064761f387b6ac6fab30b3d425ce322febd56979355bfd217a75abb84` |
| Terminal capture manifest | `3c845b025d9a722e5afa00406d87763656cd38fb6c4ca2bede6ba1918d9115e9` |
| [Original saved comparison](comparison-first.json) | `17e888ea19e0d158986b5728a12e49ef4c11113257cc2e033a1505f90226edf6` |
| Original comparator | `53fe6a9a11f5144fe582ba721f99d2e91531cced0f96261d4ab24429cafe0e7c` |
| Amended comparator | `45d233829aab40b4371da7aff5d4c6ed0a7378c703e4c99d423d66f6afe54903` |
| [Saved-only amended comparison with terminal packet check](comparison-amended-third.json) | `104685c62d4c8a957136ef8665149f690e6f65882cb26c13fd17b8bd797659a1` |
| [Independent final outcome audit](outcome-audit-final.json) | `a08b85a0a41ca59fe7bcc8b6ddce42b561f7bcb6cd25af741a9499b2660b639e` |

Run the archived checker with the original pins to reproduce the original result. Run [reanalyze-exception.mjs](reanalyze-exception.mjs) for the explicitly retrospective amendment; it fails if its exact original packet, original JSON, comparator revision or other registered source bytes drift. Both are saved-evidence operations, not public simulations.

## Limits retained

The two inputs were chosen because previous evidence exposed unsupported delegated senders. They are not a representative sample. The older 14/16 cohort and the newer prospective 16/16 cohort remain separate and unchanged. No general 90%/100% accuracy claim follows from these observations.

The local engine and remote execution reference use the same public input infrastructure. Header proofs bind state to the selected supplied header, not independently verified consensus or finality. There is no comparison of full public poststate roots, signatures, actual fees, original mined positions, all economic effects or HyperCore settlement. The existing delegation is authenticated; no authorization list is processed. Parent validation and proof utilities are shared with the product. API/outer-worker inventory equality is verified, but the inner isolation explicitly reports `sourceImplementationBound:false`; this is not per-process code attestation. Process evidence establishes direct-child closure and group cleanup signalling, not independent proof of extinction of an arbitrary process tree.

All active runner, worker, guarded loader and saved-adjudicator imports are archived. The archive also retains an unused `cohort-wire.test.mjs` whose optional ancestry controls need an unarchived test fixture; those optional controls cannot run standalone from this archive. The inactive Arbitrum loader's optional engine is also omitted. Neither path is invoked by this packet or its 46 preflight controls. This is an archive reproducibility limitation, not hidden target coverage.

The installed 0.35 app and execution engine are unchanged. The only execution-related code correction in this packet is in the research exception comparator.

The [next implementation gap](NEXT-native-HYPE.md) is measured native HYPE balances for ordinary HyperEVM transfers and payable calls. It is not implemented by this packet. The current endpoint accepts positive value but its measurement context excludes it; new native measurements must preserve existing Hyperlend token semantics, full value/context binding, rollback handling and shared failure withholding.
