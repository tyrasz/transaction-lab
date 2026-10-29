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

# Supported blockchains and domains

> Blockchains and domain identifiers supported by CCTP

CCTP is available on multiple blockchains where USDC is natively issued. Each
blockchain is assigned a unique domain identifier used in
[CCTP contracts](https://developers.circle.com/cctp/references/contract-addresses.md) and API calls.

## Supported blockchains

CCTP provides
[Standard Transfer](https://developers.circle.com/cctp/concepts/finality-and-block-confirmations.md#standard-transfer-attestation-times),
[Fast Transfer](https://developers.circle.com/cctp/concepts/finality-and-block-confirmations.md#fast-transfer-attestation-times),
Hooks, [Forwarding Service](https://developers.circle.com/cctp/concepts/forwarding-service.md), and
[upfront fees](https://developers.circle.com/cctp/concepts/upfront-fees.md) capabilities on the following
blockchains. All blockchains listed below are supported as destinations.

> [!NOTE]
>
> **Fast Transfer availability:**
>
> [Fast Transfer](https://developers.circle.com/cctp/concepts/fast-transfer-allowance.md) is available for source
> chains only when it provides a meaningful speed improvement over standard burn
> attestation times. For blockchains where standard attestation is already fast,
> Fast Transfer is not necessary. These chains are marked **N/A** in the Source
> (Fast transfer) column in the following table.

| Blockchain | Source (Standard transfer) | Source (Fast transfer) | Source (Upfront fees) | Forwarding Service |
| - | - | - | - | - |
| Aptos | ✅ | N/A | ❌ | ❌ |
| Arbitrum | ✅ | ✅ | ✅ | ✅ |
| Arc | ✅ | N/A | ✅ | ✅ |
| Avalanche | ✅ | N/A | ✅ | ✅ |
| Base | ✅ | ✅ | ✅ | ✅ |
| BNB Smart Chain (USYC only) | ✅ | N/A | ❌ | ❌ |
| Codex | ✅ | ✅ | ✅ | ✅ |
| Cronos | ✅ | N/A | ❌ | ❌ |
| EDGE | ✅ | ✅ | ❌ | ✅ |
| Ethereum | ✅ | ✅ | ✅ | ✅ |
| HyperEVM | ✅ | N/A | ✅ | ✅ |
| Injective | ✅ | N/A | ❌ | ❌ |
| Ink | ✅ | ✅ | ✅ | ✅ |
| Linea | ✅ | ✅ | ✅ | ✅ |
| Monad | ✅ | N/A | ✅ | ✅ |
| Morph | ✅ | ✅ | ❌ | ❌ |
| OP Mainnet | ✅ | ✅ | ✅ | ✅ |
| Pharos | ✅ | N/A | ❌ | ❌ |
| Plasma | ✅ | N/A | ❌ | ❌ |
| Plume | ✅ | ✅ | ✅ | ✅ |
| Polygon PoS | ✅ | N/A | ✅ | ✅ |
| Sei | ✅ | N/A | ✅ | ✅ |
| Solana | ✅ | ✅ | ❌ | ✅ |
| Sonic | ✅ | N/A | ✅ | ✅ |
| Starknet | ✅ | ✅ | ❌ | ❌ |
| Stellar | ✅ | N/A | ❌ | ❌ |
| Sui | ✅ | N/A | ❌ | ❌ |
| Unichain | ✅ | ✅ | ✅ | ✅ |
| World Chain | ✅ | ✅ | ✅ | ✅ |
| X Layer | ✅ | ✅ | ❌ | ❌ |
| XDC | ✅ | N/A | ✅ | ✅ |

> [!NOTE]
>
> On Stellar, USDC precision and address encoding differ from other CCTP-supported
> blockchains. For inbound transfers, use
> [`CctpForwarder`](https://developers.circle.com/cctp/references/stellar#use-cctpforwarder-for-stellar-recipients)
> so funds reach the correct recipient. See
> [CCTP on Stellar](https://developers.circle.com/cctp/references/stellar.md).

> [!NOTE]
>
> **Testnet support:**
>
> If a mainnet is listed, its official testnet is also supported. For example,
> Ethereum includes both Ethereum Mainnet and Ethereum Sepolia. Monad is the
> exception: upfront fees aren't supported on Monad Testnet.

### Upfront fees

The column labeled "Source (Upfront fees)" indicates whether you can pay fees
for Forwarding Service and Fast Transfer services
[upfront](https://developers.circle.com/cctp/concepts/upfront-fees.md) on the source blockchain. The services
you pay for must also be supported on your route: Fast Transfer on the source
blockchain, and the Forwarding Service on the destination. Upfront fees apply to
USDC transfers only; they aren't supported for USYC.

### Forwarding Service

The column labeled "Forwarding Service" indicates whether the blockchain is
available as a destination for the
[Circle Forwarding Service](https://developers.circle.com/cctp/concepts/forwarding-service.md).

## Domain identifiers

A domain is a Circle-issued identifier for a blockchain where CCTP contracts are
deployed. Domain identifiers don't map to existing public chain IDs.

Use domain identifiers when calling CCTP contracts and API endpoints:

| Domain | Blockchain |
| :- | :- |
| 0 | Ethereum |
| 1 | Avalanche |
| 2 | OP Mainnet |
| 3 | Arbitrum |
| 5 | Solana |
| 6 | Base |
| 7 | Polygon PoS |
| 8 | Sui |
| 9 | Aptos |
| 10 | Unichain |
| 11 | Linea |
| 12 | Codex |
| 13 | Sonic |
| 14 | World Chain |
| 15 | Monad |
| 16 | Sei |
| 17 | BNB Smart Chain |
| 18 | XDC |
| 19 | HyperEVM |
| 21 | Ink |
| 22 | Plume |
| 25 | Starknet |
| 26 | Arc |
| 27 | Stellar |
| 28 | EDGE |
| 29 | Injective |
| 30 | Morph |
| 31 | Pharos |
| 32 | Cronos |
| 33 | Plasma |
| 37 | X Layer |

## Supported tokens

Not all domains support the same tokens:

* [USDC](https://developers.circle.com/stablecoins/what-is-usdc.md): Supported on all CCTP domains except BNB
  Smart Chain
* [USYC](https://developers.circle.com/tokenized/usyc/overview.md): Supported only on Ethereum and BNB Smart
  Chain

## CCTP V1 (Legacy) only

The following blockchains are supported only by CCTP V1 (Legacy). If you are
building on these chains, refer to the [V1 documentation](https://developers.circle.com/cctp/v1.md) for
integration guides and contract references.

| Blockchain | Domain | Documentation |
| - | - | - |
| Noble | 4 | [Noble Cosmos module](https://developers.circle.com/cctp/v1/noble-cosmos-module.md) |
