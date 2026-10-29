# Arbitrum USDC → HyperCore: interpretation and capture specification

The preserved transaction requests a **100 USDC CCTP burn on Arbitrum, followed by forwarding to the sender's default HyperCore perps account**. It does not prove a burn occurred, a balance changed, an attestation exists, or a destination account was credited. The candidate decoder returns intent only.

The exact original [scenario](retained/scenario.json) is 879 bytes, SHA-256 `5674c7568a54d5832ee76af440bda85c88621645637b2a24283b23843da430fa`. [retained-provenance.json](retained-provenance.json) also binds five old public/redacted response files. None was changed or refreshed through RPC. [decoded-scenario.json](decoded-scenario.json) is the reproducible output of [interpret.mjs](interpret.mjs).

## Exact decoded call

| Field | Value and meaning |
| --- | --- |
| Chain | Arbitrum One, chain ID `42161`; CCTP source domain `3` |
| Sender | `0xe721a0532a7828df67ad519aa25c602da076159a` |
| Target | `0x28b5a0e9c621a5badaa536219b3a228c8168cf5d`, documented TokenMessengerV2 |
| Native value | `0` |
| Function | `depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)`; selector `0x779b432d` |
| Amount | `100000000` raw units = `100` USDC at the documented six-decimal denomination |
| Burn token | Arbitrum native USDC, `0xaf88d065e77c8cc2239327c5edb3a432268e5831` |
| Destination domain | `19`, HyperEVM; this is a CCTP domain, not an EVM chain ID |
| Mint recipient | Zero-left-padded `bytes32` address `0xb21d281dedb17ae5b501f6aa8256fe38c4e45757`, documented CctpForwarder on HyperEVM |
| Destination caller | The same forwarder; this restricts who can call the destination message receiver |
| Maximum fee | `200000` raw units = `0.2` USDC **cap**, not an observed charge or current quote |
| Minimum finality threshold | `1000`, the requested fast-transfer threshold; no attestation/finality observation |
| Hook | Exactly 56 bytes: offsets 0–23 `cctp-forward` right-zero-padded; 24–27 version `0`; 28–31 payload length `24`; 32–51 sender address; 52–55 destination dex `0` |

The eight ABI head words are followed at offset 256 by a length word of 56, the hook, and eight zero padding bytes. There are no trailing bytes. `mintRecipient` is the forwarder, **not** the final HyperCore user. The hook's address is the requested HyperCore user; dex `0` requests default perps and `4294967295` requests spot. Other dex IDs remain unsupported by this narrow adapter.

## Source and address evidence

[deployment-metadata.json](deployment-metadata.json) binds the exact source/doc hashes, addresses, ABI signature and recognized dex labels. These are declared identities, not deployed-bytecode attestation. [source-provenance.json](source-provenance.json) retains retrieval URLs/times, SHA-256, repository commit and Git blob hashes where available; original Apache licenses are copied with the contract sources.

- Circle's [CCTP address table](https://developers.circle.com/cctp/references/contract-addresses) identifies the Arbitrum messenger; [domain table](https://developers.circle.com/cctp/concepts/supported-chains-and-domains) maps `3` and `19`; [USDC table](https://developers.circle.com/stablecoins/usdc-contract-addresses) identifies the token. Exact retrieved Markdown is saved under `sources/docs/`.
- Circle's [HyperCore deployment table](https://developers.circle.com/cctp/references/hypercore-contract-addresses) identifies forwarder `b21d…5757` and CoreDepositWallet `0x6b9e773128f453f5c2c60935ee2de2cbc5390a24`. Its [TokenMessenger forwarding guide](https://developers.circle.com/cctp/howtos/transfer-usdc-from-ethereum-to-hypercore) expressly applies to other CCTP source chains and documents this hook format. The current Arbitrum-specific guide uses a different CctpExtension entry point; this saved scenario is the direct TokenMessengerV2 path and must not be silently rewritten to that extension.
- `circlefin/evm-cctp-contracts` is pinned at `a92a2b4e7e6ef99bf0b05dca71780f5ec190e729`. [TokenMessengerV2](sources/evm-cctp-contracts/src/v2/TokenMessengerV2.sol) defines the exact method and DepositForBurn event; `_depositForBurn` uses `msg.sender`, transfers/burns the amount and sends a message. [BaseTokenMessenger](sources/evm-cctp-contracts/src/v2/BaseTokenMessenger.sol) calls USDC `transferFrom(sender, localMinter, amount)` from the messenger context, then calls the minter's burn. Therefore the allowance identity is **owner=sender, spender=TokenMessengerV2**, not the destination forwarder or source minter.
- `circlefin/hyperevm-circle-contracts` is pinned at `ffcc978810fa88884c150ad2d6418aa02c576670`. [CctpForwarder](sources/hyperevm-circle-contracts/src/CctpForwarder.sol) checks message versions/recipients, obtains the locally mapped token, mints through CCTP, measures its token-balance increase and deposits that amount through its configured forwarding address. [Hook parsing](sources/hyperevm-circle-contracts/src/messages/CctpForwarderHookData.sol) and [CoreDepositWallet](sources/hyperevm-circle-contracts/src/CoreDepositWallet.sol) establish recipient/dex semantics.

The on-chain hook library deliberately ignores magic and declared payload length, accepts some shorter hooks with default dex zero, and permits extra data. This candidate adapter is **stricter**: it recognizes only the complete documented version-zero 56-byte frame, including its magic and length. Rejection by the adapter is not a statement that every contract would reject the call.

Current CoreDepositWallet source sends an enabled dex request through CoreWriter only if global dex forwarding and that dex are enabled. Otherwise it deposits to the recipient's spot account. Its owner-configured account fee and account-existence check may also affect forwarded amounts. These source possibilities are not proof of the deployed configuration. Consequently `requestedBalance: "perps"` is justified here; `creditedBalance: "perps"` and a promised `99.8 USDC` credit are not. Circle also describes HyperCore balances as protocol-level credits while native USDC remains on HyperEVM. [Official workflow](https://developers.circle.com/cctp/concepts/cctp-on-hypercore).

## Existing retained evidence and its limits

The October 23 saved RPC records report `eth_call` success (`0x`) at numeric block `517417892`, a gas estimate of `121984`, and earlier balance/allowance reads. They retain no full pinned-header/proof/implementation evidence, committed logs or same-overlay after-read. These are historical provider statements; neither those balances nor that allowance is claimed current. A later saved numeric-block call also succeeded. The old sender code is a delegation designator `0xef0100e40ccb2d94975c51bff0c004efdfd9b3a5796fa4`, so any new simulator must preserve actual sender code and Arbitrum's delegation behavior instead of substituting a funded EOA.

Dynamic's saved response before a settings change contains no asset rows; later responses describe `Sending 100 USDC` and a zero-address counterparty. These are retained provider summaries, not an independently proved balance delta. The summary's generic `Benign` label is not consumed by this adapter. Empty asset rows do not prove no effect, and a zero-address counterparty does not identify the final HyperCore beneficiary. There is no retained destination attestation, transaction or HyperCore credit measurement for this hypothetical call.

## Candidate adapter contract

`decodeCctpHypercoreIntent({chainId,from,to,value,data})` is pure and has no network/state input. It accepts exactly those five plain own data fields. Results are `recognized_intent`, `unrecognized`, `unsupported`, or `malformed`; only the first contains an intent. Chain/target/selector must match before decoding. Token, domain, both destination addresses, canonical ABI widths/offset/tail, positive amount, fee less than amount, recognized finality threshold, exact hook frame and supported dex must independently match. A different valid recipient is returned explicitly with `recipientIsSender:false`; it is never replaced by the sender.

Recipient recognition does not establish destination eligibility. Pinned `CoreDepositWallet.depositFor` (lines 373–376) excludes zero, its configured `tokenSystemAddress`, the wallet itself, and blacklisted recipients. The managed USDC token and `tokenSystemAddress` are distinct constructor fields. This decoder excludes zero and the documented wallet address using declared deployment metadata; its deployed identity remains unverified. It does not know the configured system address or blacklist state, and therefore does not reject the managed-token address as forbidden. Every recognized intent explicitly sets `destinationRecipientValidationVerified:false`.

Pre-release review corrected an erroneous managed-token recipient exclusion and added a regression for that distinction. The prior preparation manifest was `a4f4118047aab277e9f3e497cd3879f91ba69ab83907d9c1cfb3ad4961dba0e0`; preserved scenario and upstream source bytes are unchanged.

Every recognized result sets `sourceExecution`, `measuredOutgoingAmount`, `destinationSettlement` and `destinationCreditAmount` to `null`; code identity, balance, allowance and execution observations are all false. These values cannot be supplied by the caller. Amounts remain decimal raw strings; formatting uses integer arithmetic. Unknown routes do not receive a generic deposit interpretation. [Focused tests](interpret.test.mjs) cover the original bytes and altered target/token/domain/recipient/amount/dex, uint widths, fee/finality boundaries, aliased offsets, padding, extra bytes, malformed hooks, getters and output immutability. Run `node --test research/arbitrum-deposit-v1/interpret.test.mjs` (13 groups passed).

## Narrow source-chain capture proposal

This is a proposed next capture, not permission to dispatch it. Freeze the exact scenario, decoder metadata, selected provider and installed client versions plus explicit request/body/time limits. Keep failures; do not replace the sender, top up balances, add approval, change the amount/hook or retry until success.

1. Establish Arbitrum chain ID and one explicit block header/hash. Retain all raw requests/responses and final matching header. Use a supported hash selector; if only numeric selection works, disclose its non-atomic nature. A pin is not an independently verified Arbitrum consensus proof.
2. At that context read sender ETH balance/code, USDC `balanceOf(sender)`, `allowance(sender, TokenMessengerV2)` and optionally `totalSupply()`. Preserve the token proxy/implementation code identity and delegation target if the method supports it. Current native balance, allowance, pauses, denylisting, fee floor, remote messenger mapping and burn limits are execution inputs, not conclusions from old records.
3. Simulate exactly the saved source-chain call, with any added gas ceiling explicitly declared in the plan. Preserve its caller and zero value; make no persistent changes and do not sign/broadcast. Capability support, Nitro-specific gas/fees/precompiles and delegation semantics must be established first. The current Ethereum-only local kernel must not be relabeled as an Arbitrum executor; viem is an RPC client, not independent EVM execution or consensus validation.
4. Only claim a measured USDC change when before/after values have the same owner/token/query identity and the **after** value comes from the simulation's resulting overlay. Independent `eth_call` reads at the original block are both pre-state reads. If the provider supports only an outcome/trace, retain `after:null`. Do not convert an expected burn or a Transfer event into a measured balance. A full sequential simulation can collect after balance/allowance/supply reads, but must expose its exact query execution/context and any simulated nonce/fee behavior.
5. Preserve complete committed source logs and distinguish them from failed subcalls. Decode USDC Transfer/Approval, messenger DepositForBurn and transmitter MessageSent using the pinned [ABI entries](abi-selection.json), correct emitter, strict topic/data shape, and an exact message/calldata join. The likely source pattern includes sender→minter followed by minter→zero, not necessarily a direct sender→zero Transfer. On root revert, no tentative event or amount is presented as committed.

Report four independent evidence levels: **calldata intent**, **simulated committed source events**, **measured same-overlay source balance/allowance deltas**, and **destination settlement**. The first can exist when the other three are unavailable. For this no-broadcast simulation, destination settlement remains not attempted. A future real-transfer tracker would require a real source receipt/message, Circle attestation, destination message acceptance/forwarding/configuration and relevant HyperCore outcome; it cannot infer settlement from a source simulation or the hook alone. No generic safety score or security verdict is part of this specification.
