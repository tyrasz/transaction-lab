# Exact public CCTP scenario through viem 2.57.13

The single authorized provider-backed source-chain experiment completed on 2026-10-29. The original 100-USDC request **reverted** with `ERC20: transfer amount exceeds balance`; viem reported 58,256 gas used and no logs for the call. The fresh sender USDC balance was zero. The observed allowance to the exact TokenMessengerV2 destination was 2450409546265963 raw units. The original sender was retained, including its observed delegation code `0xef0100e40ccb2d94975c51bff0c004efdfd9b3a5796fa4`. There was no retry, wallet replacement, fabricated funding/allowance, signing or broadcast.

The base block was 519233880 (`0x1ef2e158`), hash `0x4f10e332afbb5ad2d288d2f1d1c8903d4dd51ce12afebb8b13ae49abd3be768a`. The final same-number full header matched. Eleven read-only JSON-RPC requests returned 20,124 response-body bytes in 3.259291292 seconds. Source and dependency files remained unchanged. The capture status `observed` means a retained provider observation; it does not mean transaction execution succeeded.

Viem returned one asset row: ETH before and after 2402331200585620 wei, difference zero, under the declared zero-gas-price simulation. This is **not** a complete inventory or proof of no effects. Viem derives candidates from logs plus the original destination, can omit failed/undecodable probes, and can infer a zero token pre-balance from a successful empty return. It returned no measured USDC row here. The exact raw probe results and all code-only scratch overrides remain in the capture. The declared 100-USDC amount and up-to-0.2-USDC destination fee cap are calldata intent, not measured outgoing or credited amounts. No Circle attestation, destination mint, relay completion, perps/spot credit, real transaction fee, state-proof validity or consensus finality was verified.

The artifact-only verifier passed once after capture: all 44 evidence files and 12,729 source/dependency entries matched their manifests; the actual pinned viem library consumed all 11 saved responses and reproduced the decoded result. This replay made zero network calls and did not rerun an EVM. Twelve preparation control groups passed using synthetic responses only; the retained TAP is not live deposit evidence.

Pins:

- Plan: `e59d3f3398ca7b7b71bb067d4ee1d1bcc1198483383226c30e55335bb7da33e2`.
- Source manifest: `90888b21c1fc0cd5a13761781fe1ff7422467039018cabb1a1cebf4069b08f52`.
- Capture manifest: `1c96399e142384b7e01e8a0cb60e98740f31355851df7b44da75c1b06e382c74`.
- Original scenario: `5674c7568a54d5832ee76af440bda85c88621645637b2a24283b23843da430fa`.

This post-capture directory is supplemental. It changes none of the frozen source roots or original capture files.
