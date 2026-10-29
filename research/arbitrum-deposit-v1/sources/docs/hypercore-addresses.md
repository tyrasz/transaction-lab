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

# HyperCore CCTP-enablement contract addresses

CCTP has additional contracts beyond the standard protocol to enable transfers
to HyperCore. The following sections describe the functions and addresses of
these contracts.

* **`CctpExtension`**: (Arbitrum only) Responsible for transferring USDC from
  Arbitrum to HyperCore.
* **`CctpExtensionV2`**: (Arbitrum only) Enables sponsored CCTP deposits from
  Arbitrum to HyperCore. A relayer submits `batchSponsorDepositForBurn` on
  behalf of users who signed EIP-3009 `ReceiveWithAuthorization` offchain. See
  [CctpExtensionV2 Contract Interface](https://developers.circle.com/cctp/references/cctp-extension-v2-contract-interface.md).
* **`CctpForwarder`**: (HyperEVM only) Responsible for forwarding USDC from
  HyperEVM to HyperCore in a CCTP transfer from any non-HyperEVM domain.
* **`CoreDepositWallet`**: (HyperEVM only) Responsible for
  [depositing USDC into HyperCore](https://developers.circle.com/cctp/references/coredepositwallet-contract-interface.md).

This page contains the contract addresses for the HyperCore CCTP-enablement
contracts. For the contract addresses for core CCTP contracts, see
[EVM contracts and interfaces](https://developers.circle.com/cctp/evm-smart-contracts.md),
[Solana Contracts and Interfaces](https://developers.circle.com/cctp/solana-programs.md), and
[Starknet contracts and interfaces](https://developers.circle.com/cctp/starknet-contracts.md).

## Mainnet contract addresses

### CctpExtension: Mainnet

| Chain | [Domain](https://developers.circle.com/cctp/cctp-supported-blockchains.md#cctp-supported-domains) | Address |
| - | - | - |
| **Arbitrum** | 3 | [`0xA95d9c1F655341597C94393fDdc30cf3c08E4fcE`](https://arbiscan.io/address/0xA95d9c1F655341597C94393fDdc30cf3c08E4fcE) |

### CctpExtensionV2: Mainnet

| Chain | [Domain](https://developers.circle.com/cctp/cctp-supported-blockchains.md#cctp-supported-domains) | Address |
| - | - | - |
| **Arbitrum** | 3 | [`0x3289e443a95B28Bcedacc4B33C689b0C9b84ffAB`](https://arbiscan.io/address/0x3289e443a95B28Bcedacc4B33C689b0C9b84ffAB) |

> [!NOTE]
>
> `CctpExtensionV2` is separate from `CctpExtension`. For sponsored relayer
> deposits, see [Transfer USDC from Arbitrum to HyperCore with
> CctpExtensionV2](https://developers.circle.com/cctp/howtos/transfer-usdc-from-arbitrum-to-hypercore-with-cctp-extension-v2.md).
> For self-submitted burns, see [Transfer USDC from Arbitrum to
> HyperCore](https://developers.circle.com/cctp/howtos/transfer-usdc-from-arbitrum-to-hypercore.md).

### CctpForwarder: Mainnet

| Chain | [Domain](https://developers.circle.com/cctp/cctp-supported-blockchains.md#cctp-supported-domains) | Address |
| - | - | - |
| **HyperEVM** | 19 | [`0xb21D281DEdb17AE5B501F6AA8256fe38C4e45757`](https://hyperevmscan.io/address/0xb21D281DEdb17AE5B501F6AA8256fe38C4e45757) |

### CoreDepositWallet: Mainnet

| Chain | [Domain](https://developers.circle.com/cctp/cctp-supported-blockchains.md#cctp-supported-domains) | Address |
| - | - | - |
| **HyperEVM** | 19 | [`0x6B9E773128f453f5c2C60935Ee2DE2CBc5390A24`](https://hyperevmscan.io/address/0x6B9E773128f453f5c2C60935Ee2DE2CBc5390A24) |

## Testnet contract addresses

### CctpExtension: Testnet

| Chain | [Domain](https://developers.circle.com/cctp/cctp-supported-blockchains.md#cctp-supported-domains) | Address |
| - | - | - |
| **Arbitrum Sepolia** | 3 | [`0x8E4e3d0E95C1bEC4F3eC7F69aa48473E0Ab6eB8D`](https://sepolia.arbiscan.io/address/0x8E4e3d0E95C1bEC4F3eC7F69aa48473E0Ab6eB8D) |

### CctpExtensionV2: Testnet

| Chain | [Domain](https://developers.circle.com/cctp/cctp-supported-blockchains.md#cctp-supported-domains) | Address |
| - | - | - |
| **Arbitrum Sepolia** | 3 | [`0xC1Fec4e5DAf8796A490653359536f9c2a9C158aE`](https://sepolia.arbiscan.io/address/0xC1Fec4e5DAf8796A490653359536f9c2a9C158aE) |

### CctpForwarder: Testnet

| Chain | [Domain](https://developers.circle.com/cctp/cctp-supported-blockchains.md#cctp-supported-domains) | Address |
| - | - | - |
| **HyperEVM Testnet** | 19 | `0x02e39ECb8368b41bF68FF99ff351aC9864e5E2a2` |

### CoreDepositWallet: Testnet

| Chain | [Domain](https://developers.circle.com/cctp/cctp-supported-blockchains.md#cctp-supported-domains) | Address |
| - | - | - |
| **HyperEVM Testnet** | 19 | `0x0B80659a4076E9E93C7DbE0f10675A16a3e5C206` |
