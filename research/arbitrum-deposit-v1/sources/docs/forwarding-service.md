> ## Documentation Index
> Fetch the complete documentation index at: https://developers.circle.com/llms.txt
> Use this file to discover all available pages before exploring further.

> ## Agent Instructions
> Before reading these docs, install the relevant Circle Skill to get pre-loaded context — skills are LLM-optimized and cover architecture decisions, correct flows, and common pitfalls. In Claude Code: run /plugin marketplace add circlefin/skills then /plugin install circle-skills@circle. With Vercel Skills CLI: run npx skills add circlefin/skills. Available skills: use-usdc https://github.com/circlefin/skills/blob/master/plugins/circle/skills/use-usdc/SKILL.md (balances, transfers, approvals on EVM and Solana); EURC has no skill — see https://developers.circle.com/stablecoins/what-is-eurc.md; bridge-stablecoin https://github.com/circlefin/skills/blob/master/plugins/circle/skills/bridge-stablecoin/SKILL.md (crosschain transfers via CCTP, USDC, EURC, and third-party assets); use-arc https://github.com/circlefin/skills/blob/master/plugins/circle/skills/use-arc/SKILL.md (Arc chain config, contract deployment, USDC bridging — Arc docs: https://docs.arc.io/llms.txt); use-circle-wallets https://github.com/circlefin/skills/blob/master/plugins/circle/skills/use-circle-wallets/SKILL.md (choose wallet type); use-developer-controlled-wallets https://github.com/circlefin/skills/blob/master/plugins/circle/skills/use-developer-controlled-wallets/SKILL.md (custodial wallets for payouts and treasury); use-user-controlled-wallets https://github.com/circlefin/skills/blob/master/plugins/circle/skills/use-user-controlled-wallets/SKILL.md (embedded wallets with Web2 login); use-modular-wallets https://github.com/circlefin/skills/blob/master/plugins/circle/skills/use-modular-wallets/SKILL.md (smart contract wallets with passkeys and ERC-4337); use-gateway https://github.com/circlefin/skills/blob/master/plugins/circle/skills/use-gateway/SKILL.md (unified USDC balance, nanopayments); use-smart-contract-platform https://github.com/circlefin/skills/blob/master/plugins/circle/skills/use-smart-contract-platform/SKILL.md (deploy, interact, monitor contracts). Pair any skill with the Circle MCP server for live SDK signatures, contract addresses, and chain IDs: {"mcpServers":{"circle":{"url":"https://api.circle.com/v1/codegen/mcp"}}}.
> Read the product overview first. Each product has an overview explaining when and why to use it. Read it before quickstarts.
> Pick the right wallet type. Developer-controlled (you hold keys), user-controlled (end user holds keys via PIN/social login), or modular (smart contract wallets with passkeys). See https://developers.circle.com/wallets.md.
> Use CCTP V2 for crosschain transfers. CCTP natively transfers USDC and EURC via burn-and-mint, and supports permissionless wrapping of third-party assets via lock-and-mint. V1 is legacy; always use V2 unless V1 is specified or the chain requires it (Noble, Sui, and Aptos still require V1). Migration guide: https://developers.circle.com/cctp/migration-from-v1-to-v2.md.
> Use Bridge Kit for frontend bridging. Wraps CCTP with a simpler SDK for user-facing apps. Use CCTP directly for backend transfers.
> Gas Station vs Paymaster. Gas Station sponsors gas for Circle Wallet transactions. Paymaster lets users pay gas in USDC. Different use cases — read both overviews.
> Gateway Nanopayments for sub-cent payments. Gasless USDC micropayments down to $0.000001 via x402 and batched settlement. For pay-per-request APIs, AI agent payments, streaming.
> Look up USDC addresses per chain. Never hardcode — use https://developers.circle.com/stablecoins/usdc-contract-addresses.md.
> Prefer SDKs over raw API calls. Node.js and Python SDKs handle auth, retries, and errors.
> API key required. Bearer token in Authorization header. Testnet and mainnet use separate keys and may use different base URLs depending on the product.
> Set up webhooks when available. Most operations are async. Webhooks deliver transaction confirmations and state changes.
> When calling list endpoints, paginate using pageSize and pageAfter until no nextPageAfter cursor is returned—stopping at the first page silently misses records.
> Building an AI agent? Start with the Agent Stack—Circle CLI, agent wallets, and nanopayments built for autonomous use cases: https://developers.circle.com/agent-stack.md.

# Circle Forwarding Service for CCTP

> Forward destination chain mints to simplify crosschain transfers

The Circle Forwarding Service is a service for CCTP that simplifies integration
by removing the need for you to run multichain infrastructure. This can improve
user experience for crosschain transfers by ensuring reliability and eliminating
the need to handle destination chain gas fees.

## How it works

A CCTP transfer without the Forwarding Service is a three-step process:

1. Create a transaction to burn USDC on the source chain and wait for Circle to
   sign an attestation.
2. Request an attestation from the Circle API.
3. Create a transaction to mint USDC on the destination chain.

This process requires you to have a wallet that can sign transactions on the
source and destination chains, and native tokens for paying the transaction gas
fee on both chains.

You use the Forwarding Service by including a forward request in the hook data
of the burn transaction on the source chain. Circle validates the hook data,
signs the attestation, and broadcasts the mint transaction on the destination
chain for you, removing the need for you to handle the transaction on the
destination chain.

For a full example of how to use the Forwarding Service, see
[Transfer USDC with the Forwarding Service](https://developers.circle.com/cctp/howtos/transfer-usdc-with-forwarding-service.md).

### Hook format

The hook data for Forwarding Service begins with the reserved magic bytes
`cctp-forward` followed by versioning and payload fields. It comes in two
formats: version 1, the composable format that can carry multiple hooks, and
version 0, the single-hook format.

#### Version 1

Hook data is one or more composable frames concatenated. Each frame has a fixed
32-byte header followed by its payload:

| Bytes | Type | Data |
| - | - | - |
| 0-23 | `bytes24` | Hook name (magic). For forwarding, this is `cctp-forward` |
| 24-27 | `uint32` | Version, set to `1` |
| 28-31 | `uint32` | Payload length in bytes (`n`) |
| 32 to 32+n | `bytes` | Payload (`n` bytes) |

You can chain multiple frames, such as a `cctp-forward` hook plus your own hook
carrying your custom data. Custom data still goes in its own dedicated frame,
not appended as raw bytes to the `cctp-forward` frame. Every frame in a version
1 blob must use version 1, and the blob must contain only complete frames.
Appending raw, unframed bytes is rejected.

To attach your own hook alongside forwarding, append it as another complete
frame after the `cctp-forward` frame:

```typescript theme={null}
import { concat, stringToHex, toHex } from "viem";

// cctp-forward hook, framed with the shared 32-byte header
const forwardHook = concat([
  stringToHex("cctp-forward", { size: 24 }), // hook name
  toHex(1, { size: 4 }), // version
  toHex(0, { size: 4 }), // payload length (no payload)
]);

// A custom hook, framed the same way. The destination ignores it unless it
// recognizes the hook name; replace it with a hook your destination supports.
const customHook = concat([
  stringToHex("my-custom-hook", { size: 24 }), // hook name
  toHex(1, { size: 4 }), // version
  toHex(4, { size: 4 }), // payload length (4 bytes)
  "0xdeadbeef", // payload
]);

const hookData = concat([forwardHook, customHook]);
```

#### Version 0

Version 0 is the single-hook format. You can append your own custom hook data
after Circle's reserved space. Forwarding Service doesn't support forwarding to
wrapper contracts (for example, when `destinationCaller` is set).

| Bytes | Type | Data |
| - | - | - |
| 0-23 | `bytes24` | `cctp-forward` |
| 24-27 | `uint32` | Version, set to `0` |
| 28-31 | `uint32` | Length of additional Circle hook data, set to `0` |
| 32-51 | `any` | Developer-defined hook data |

If no additional integrator hook data is required, a static hex string can be
used for the forwarding hook data:

```javascript theme={null}
// Includes magic bytes ("cctp-forward") + hook version (0) + empty data length (0)
const forwardHookData =
  "0x636374702d666f72776172640000000000000000000000000000000000000000";
```

### Solana `mintRecipient`

When the destination blockchain is Solana, the `mintRecipient` parameter in
`depositForBurnWithHook` must be the recipient's USDC
[Associated Token Account (ATA)](https://spl.solana.com/associated-token-account)
address, not the recipient's wallet address. Unlike EVM destinations where
`mintRecipient` is the wallet address, Solana requires the address of the SPL
token account that will hold the minted USDC.

You can derive the ATA address from the recipient owner address and the USDC
mint address using the
[`getAssociatedTokenAddressSync`](https://solana-labs.github.io/solana-program-library/token/js/functions/getAssociatedTokenAddressSync.html)
function from the `@solana/spl-token` library. In Solana terms, the recipient
owner can be an on-curve public key controlled by a keypair, such as a wallet
public key, or an off-curve Program Derived Address (PDA) controlled by a Solana
program. If the owner might be off-curve, pass `true` for `allowOwnerOffCurve`:

```typescript theme={null}
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";

const recipientOwner = new PublicKey("RecipientOwnerAddress");
const USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"); // Solana devnet

const recipientAta = getAssociatedTokenAddressSync(
  USDC_MINT,
  recipientOwner,
  true,
);
const mintRecipient = `0x${Buffer.from(recipientAta.toBytes()).toString("hex")}`;
```

### Solana hook data for ATA creation

If the recipient does not have an existing USDC ATA, you can request the
Forwarding Service to create it by encoding additional fields in the hook data.
The extended hook data format is:

| Bytes | Type | Data |
| - | - | - |
| 0-23 | `bytes24` | `cctp-forward` |
| 24-27 | `uint32` | Version, set to `0` |
| 28-31 | `uint32` | Length of additional Circle hook data, set to `33` |
| 32 | `uint8` | `1` (request ATA creation) |
| 33-64 | `bytes32` | Recipient owner address for the ATA (on-curve or off-curve) |
| 65+ | `any` | Developer-defined hook data |

When using this format, `mintRecipient` must be the ATA derived from the
recipient owner address in bytes 33-64 and the USDC mint. The recipient owner
can be an on-curve public key controlled by a keypair or an off-curve PDA.
Forwarding Service validates that these values match before creating the
account.

The following example shows how to construct the extended hook data for Solana
with ATA creation:

```typescript theme={null}
import { PublicKey } from "@solana/web3.js";

// Magic bytes "cctp-forward" padded to 24 bytes
const magicBytes = Buffer.alloc(24);
magicBytes.write("cctp-forward", "utf-8");

// Version (uint32, big-endian) = 0
const version = Buffer.alloc(4);

// Length of additional Circle hook data (uint32, big-endian) = 33
const length = Buffer.alloc(4);
length.writeUInt32BE(33);

// ATA creation flag = 1
const ataFlag = Buffer.from([1]);

// Recipient owner address for the ATA (32 bytes)
const recipientOwner = new PublicKey("RecipientOwnerAddress");
const ownerBytes = Buffer.from(recipientOwner.toBytes());

const forwardHookData =
  "0x" +
  Buffer.concat([magicBytes, version, length, ataFlag, ownerBytes]).toString(
    "hex",
  );
```

If the recipient already has a USDC ATA and no ATA creation is needed, use the
same static hook data as EVM:

```typescript theme={null}
// Includes magic bytes ("cctp-forward") + hook version (0) + empty data length (0)
const forwardHookData =
  "0x636374702d666f72776172640000000000000000000000000000000000000000";
```

## Fees and execution

The Forwarding Service charges a fee for each transfer, in addition to the CCTP
protocol fee. The Forwarding Service fee charged is to cover gas costs on the
destination chain and a small service fee. The Forwarding Service prioritizes
fast execution and quotes gas dynamically. If gas used is less than gas needed
for execution, the remainder is spent as an additional priority fee where they
are supported. On all chains, a higher fee provides a safety buffer for
successful transaction delivery on the destination chain. Circle does not refund
for excess gas and does not keep the excess gas, except in cases where excess
priority fees are rejected.

> [!NOTE]
>
> Instead of deducting the Forwarding Service fee from the transfer, you can pay
> it [upfront](https://developers.circle.com/cctp/concepts/upfront-fees.md) on the source blockchain so the
> recipient receives the full transfer amount on the destination blockchain. See
> [Supported blockchains](https://developers.circle.com/cctp/concepts/supported-chains-and-domains.md) for which
> sources support upfront fees.

The
[`depositForBurnWithHook`](https://developers.circle.com/cctp/references/contract-interfaces#depositforburnwithhook)
transaction includes a `maxFee` parameter. When using the Forwarding Service,
this parameter should be set to a value that is large enough to cover the CCTP
protocol fee and the Forwarding Service fee. Because the gas budget for the
destination chain comes from a USDC fee on the source chain, choosing a lower
`maxFee` results in a lower priority fee on the destination chain. A higher
`maxFee` results in a higher priority fee on the destination chain and can
result in faster confirmation.

The Forwarding Service charges a service fee for each transfer:

| Forwarding route | Service fee (USDC) |
| - | - |
| HyperCore deposits | \$0.20 |
| HyperCore withdrawals to Ethereum | \$1.20 |
| HyperCore withdrawals to Solana | \$0.50 |
| HyperCore withdrawals to all other supported chains | \$0.20 |
| All other forwarding destinations | \$0.05 |

> [!WARNING]
>
> If the `maxFee` parameter is insufficient to cover the both Fast Transfer
> protocol fee and the Forwarding Service fee, CCTP will prioritize forwarding
> execution over Fast Transfer. This means that the transfer will execute as a
> Standard Transfer with the Forwarding Service.

### Solana fees

When forwarding to Solana, the Forwarding Service fee includes both a gas
component and a rent component. Rent covers the cost of creating onchain
accounts required by each transfer. The fee estimate API returns `forwardFee`
values that already include rent, so no additional calculation is needed on your
part.

If the recipient does not already have a USDC
[Associated Token Account (ATA)](https://spl.solana.com/associated-token-account)
on Solana, the transfer will fail. To have the Forwarding Service create the
ATA, you must:

1. Pass `includeRecipientSetup=true` when calling the fee estimate API so the
   returned `forwardFee` covers the ATA creation cost.
2. Encode the ATA creation fields in the
   [hook data](#solana-hook-data-for-ata-creation) of the burn transaction.

```http theme={null}
GET /v2/burn/USDC/fees/{sourceDomain}/{destDomain}?forward=true&includeRecipientSetup=true
```

For full details on this endpoint, see the
[`GET /v2/burn/USDC/fees` API reference](https://developers.circle.com/api-reference/cctp/all/get-burn-usdc-fees).

> [!NOTE]
>
> `includeRecipientSetup` only applies when the destination blockchain is Solana.
> It has no effect for EVM destination blockchains.

## Supported blockchains

For a full list of supported blockchains, see
[CCTP Supported Blockchains](https://developers.circle.com/cctp/concepts/supported-chains-and-domains.md).
