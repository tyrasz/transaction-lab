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

# Contract addresses

> CCTP smart contract addresses for EVM-compatible blockchains

This page lists the deployed contract addresses for CCTP on all
[supported EVM-compatible blockchains](https://developers.circle.com/cctp/concepts/supported-chains-and-domains.md).
For contract interfaces and method signatures, see
[Contract interfaces](https://developers.circle.com/cctp/references/contract-interfaces.md).

Full contract source code is
[available on GitHub](https://github.com/circlefin/evm-cctp-contracts).

For non-EVM blockchain contract addresses, see:

* [Solana Programs](https://developers.circle.com/cctp/references/solana-programs.md)
* [Stellar Contracts](https://developers.circle.com/cctp/references/stellar-contracts.md)
* [Starknet Contracts](https://developers.circle.com/cctp/references/starknet-contracts.md)

## Mainnet contract addresses

### TokenMessengerV2

| Blockchain | [Domain](https://developers.circle.com/cctp/concepts/supported-chains-and-domains.md#domain-identifiers) | Address |
| - | - | - |
| **Ethereum** | 0 | [`0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`](https://etherscan.io/address/0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d) |
| **Avalanche** | 1 | [`0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`](https://snowtrace.io/address/0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d) |
| **OP Mainnet** | 2 | [`0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`](https://optimistic.etherscan.io/address/0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d) |
| **Arbitrum** | 3 | [`0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`](https://arbiscan.io/address/0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d) |
| **Base** | 6 | [`0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`](https://basescan.org/address/0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d) |
| **Polygon PoS** | 7 | [`0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`](https://polygonscan.com/address/0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d) |
| **Unichain** | 10 | [`0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`](https://uniscan.xyz/address/0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d) |
| **Linea** | 11 | [`0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`](https://lineascan.build/address/0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d) |
| **Codex** | 12 | [`0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`](https://explorer.codex.xyz/address/0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d) |
| **Sonic** | 13 | [`0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`](https://sonicscan.org/address/0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d) |
| **World Chain** | 14 | [`0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`](https://worldscan.org/address/0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d) |
| **Monad** | 15 | [`0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`](https://monadvision.com/address/0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d) |
| **Sei** | 16 | [`0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`](https://seiscan.io/address/0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d) |
| **XDC** | 18 | [`0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`](https://xdcscan.com/address/0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d) |
| **HyperEVM** | 19 | [`0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`](https://hyperscan.com/address/0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d) |
| **Ink** | 21 | [`0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`](https://explorer.inkonchain.com/address/0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d) |
| **Plume** | 22 | [`0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`](https://explorer.plume.org/address/0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d) |
| **Arc** | 26 | [`0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`](https://explorer.arc.io/address/0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d) |
| **EDGE** | 28 | [`0x98706A006bc632Df31CAdFCBD43F38887ce2ca5c`](https://pro.edgex.exchange/en-US/explorer/address/0x98706A006bc632Df31CAdFCBD43F38887ce2ca5c) |
| **Injective** | 29 | [`0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`](https://blockscout.injective.network/address/0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d) |
| **Morph** | 30 | [`0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`](https://explorer.morph.network/address/0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d) |
| **Pharos** | 31 | [`0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`](https://pharos.socialscan.io/address/0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d) |
| **Cronos** | 32 | [`0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`](https://explorer.cronos.org/address/0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d) |
| **Plasma** | 33 | [`0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`](https://plasmascan.to/address/0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d) |
| **X Layer** | 37 | [`0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`](https://www.okx.com/web3/explorer/xlayer/address/0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d) |

### TokenMessengerWithFees

| Blockchain | [Domain](https://developers.circle.com/cctp/concepts/supported-chains-and-domains.md#domain-identifiers) | Address |
| - | - | - |
| **Ethereum** | 0 | [`0x71f54F818671cD0D7ea140Da213e5C8b5C92a408`](https://etherscan.io/address/0x71f54F818671cD0D7ea140Da213e5C8b5C92a408) |
| **Avalanche** | 1 | [`0x71f54F818671cD0D7ea140Da213e5C8b5C92a408`](https://snowtrace.io/address/0x71f54F818671cD0D7ea140Da213e5C8b5C92a408) |
| **OP Mainnet** | 2 | [`0x71f54F818671cD0D7ea140Da213e5C8b5C92a408`](https://optimistic.etherscan.io/address/0x71f54F818671cD0D7ea140Da213e5C8b5C92a408) |
| **Arbitrum** | 3 | [`0x71f54F818671cD0D7ea140Da213e5C8b5C92a408`](https://arbiscan.io/address/0x71f54F818671cD0D7ea140Da213e5C8b5C92a408) |
| **Base** | 6 | [`0x71f54F818671cD0D7ea140Da213e5C8b5C92a408`](https://basescan.org/address/0x71f54F818671cD0D7ea140Da213e5C8b5C92a408) |
| **Polygon PoS** | 7 | [`0x71f54F818671cD0D7ea140Da213e5C8b5C92a408`](https://polygonscan.com/address/0x71f54F818671cD0D7ea140Da213e5C8b5C92a408) |
| **Unichain** | 10 | [`0x71f54F818671cD0D7ea140Da213e5C8b5C92a408`](https://uniscan.xyz/address/0x71f54F818671cD0D7ea140Da213e5C8b5C92a408) |
| **Linea** | 11 | [`0x71f54F818671cD0D7ea140Da213e5C8b5C92a408`](https://lineascan.build/address/0x71f54F818671cD0D7ea140Da213e5C8b5C92a408) |
| **Codex** | 12 | [`0x71f54F818671cD0D7ea140Da213e5C8b5C92a408`](https://explorer.codex.xyz/address/0x71f54F818671cD0D7ea140Da213e5C8b5C92a408) |
| **Sonic** | 13 | [`0x71f54F818671cD0D7ea140Da213e5C8b5C92a408`](https://sonicscan.org/address/0x71f54F818671cD0D7ea140Da213e5C8b5C92a408) |
| **World Chain** | 14 | [`0x71f54F818671cD0D7ea140Da213e5C8b5C92a408`](https://worldscan.org/address/0x71f54F818671cD0D7ea140Da213e5C8b5C92a408) |
| **Monad** | 15 | [`0x71f54F818671cD0D7ea140Da213e5C8b5C92a408`](https://monadvision.com/address/0x71f54F818671cD0D7ea140Da213e5C8b5C92a408) |
| **Sei** | 16 | [`0x71f54F818671cD0D7ea140Da213e5C8b5C92a408`](https://seiscan.io/address/0x71f54F818671cD0D7ea140Da213e5C8b5C92a408) |
| **XDC** | 18 | [`0x71f54F818671cD0D7ea140Da213e5C8b5C92a408`](https://xdcscan.com/address/0x71f54F818671cD0D7ea140Da213e5C8b5C92a408) |
| **HyperEVM** | 19 | [`0x71f54F818671cD0D7ea140Da213e5C8b5C92a408`](https://hyperscan.com/address/0x71f54F818671cD0D7ea140Da213e5C8b5C92a408) |
| **Ink** | 21 | [`0x71f54F818671cD0D7ea140Da213e5C8b5C92a408`](https://explorer.inkonchain.com/address/0x71f54F818671cD0D7ea140Da213e5C8b5C92a408) |
| **Plume** | 22 | [`0x71f54F818671cD0D7ea140Da213e5C8b5C92a408`](https://explorer.plume.org/address/0x71f54F818671cD0D7ea140Da213e5C8b5C92a408) |
| **Arc** | 26 | [`0x71f54F818671cD0D7ea140Da213e5C8b5C92a408`](https://explorer.arc.io/address/0x71f54F818671cD0D7ea140Da213e5C8b5C92a408) |

### MessageTransmitterV2

| Blockchain | [Domain](https://developers.circle.com/cctp/concepts/supported-chains-and-domains.md#domain-identifiers) | Address |
| - | - | - |
| **Ethereum** | 0 | [`0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`](https://etherscan.io/address/0x81D40F21F12A8F0E3252Bccb954D722d4c464B64) |
| **Avalanche** | 1 | [`0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`](https://snowtrace.io/address/0x81D40F21F12A8F0E3252Bccb954D722d4c464B64) |
| **OP Mainnet** | 2 | [`0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`](https://optimistic.etherscan.io/address/0x81D40F21F12A8F0E3252Bccb954D722d4c464B64) |
| **Arbitrum** | 3 | [`0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`](https://arbiscan.io/address/0x81D40F21F12A8F0E3252Bccb954D722d4c464B64) |
| **Base** | 6 | [`0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`](https://basescan.org/address/0x81D40F21F12A8F0E3252Bccb954D722d4c464B64) |
| **Polygon PoS** | 7 | [`0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`](https://polygonscan.com/address/0x81D40F21F12A8F0E3252Bccb954D722d4c464B64) |
| **Unichain** | 10 | [`0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`](https://uniscan.xyz/address/0x81D40F21F12A8F0E3252Bccb954D722d4c464B64) |
| **Linea** | 11 | [`0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`](https://lineascan.build/address/0x81D40F21F12A8F0E3252Bccb954D722d4c464B64) |
| **Codex** | 12 | [`0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`](https://explorer.codex.xyz/address/0x81D40F21F12A8F0E3252Bccb954D722d4c464B64) |
| **Sonic** | 13 | [`0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`](https://sonicscan.org/address/0x81D40F21F12A8F0E3252Bccb954D722d4c464B64) |
| **World Chain** | 14 | [`0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`](https://worldscan.org/address/0x81D40F21F12A8F0E3252Bccb954D722d4c464B64) |
| **Monad** | 15 | [`0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`](https://monadvision.com/address/0x81D40F21F12A8F0E3252Bccb954D722d4c464B64) |
| **Sei** | 16 | [`0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`](https://seiscan.io/address/0x81D40F21F12A8F0E3252Bccb954D722d4c464B64) |
| **XDC** | 18 | [`0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`](https://xdcscan.com/address/0x81D40F21F12A8F0E3252Bccb954D722d4c464B64) |
| **HyperEVM** | 19 | [`0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`](https://hyperscan.com/address/0x81D40F21F12A8F0E3252Bccb954D722d4c464B64) |
| **Ink** | 21 | [`0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`](https://explorer.inkonchain.com/address/0x81D40F21F12A8F0E3252Bccb954D722d4c464B64) |
| **Plume** | 22 | [`0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`](https://explorer.plume.org/address/0x81D40F21F12A8F0E3252Bccb954D722d4c464B64) |
| **Arc** | 26 | [`0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`](https://explorer.arc.io/address/0x81D40F21F12A8F0E3252Bccb954D722d4c464B64) |
| **EDGE** | 28 | [`0x5b61381Fc9e58E70EfC13a4A97516997019198ee`](https://pro.edgex.exchange/en-US/explorer/address/0x5b61381Fc9e58E70EfC13a4A97516997019198ee) |
| **Injective** | 29 | [`0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`](https://blockscout.injective.network/address/0x81D40F21F12A8F0E3252Bccb954D722d4c464B64) |
| **Morph** | 30 | [`0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`](https://explorer.morph.network/address/0x81D40F21F12A8F0E3252Bccb954D722d4c464B64) |
| **Pharos** | 31 | [`0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`](https://pharos.socialscan.io/address/0x81D40F21F12A8F0E3252Bccb954D722d4c464B64) |
| **Cronos** | 32 | [`0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`](https://explorer.cronos.org/address/0x81D40F21F12A8F0E3252Bccb954D722d4c464B64) |
| **Plasma** | 33 | [`0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`](https://plasmascan.to/address/0x81D40F21F12A8F0E3252Bccb954D722d4c464B64) |
| **X Layer** | 37 | [`0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`](https://www.okx.com/web3/explorer/xlayer/address/0x81D40F21F12A8F0E3252Bccb954D722d4c464B64) |

### TokenMinterV2

| Blockchain | [Domain](https://developers.circle.com/cctp/concepts/supported-chains-and-domains.md#domain-identifiers) | Address |
| - | - | - |
| **Ethereum** | 0 | [`0xfd78EE919681417d192449715b2594ab58f5D002`](https://etherscan.io/address/0xfd78EE919681417d192449715b2594ab58f5D002) |
| **Avalanche** | 1 | [`0xfd78EE919681417d192449715b2594ab58f5D002`](https://snowtrace.io/address/0xfd78EE919681417d192449715b2594ab58f5D002) |
| **OP Mainnet** | 2 | [`0xfd78EE919681417d192449715b2594ab58f5D002`](https://optimistic.etherscan.io/address/0xfd78EE919681417d192449715b2594ab58f5D002) |
| **Arbitrum** | 3 | [`0xfd78EE919681417d192449715b2594ab58f5D002`](https://arbiscan.io/address/0xfd78EE919681417d192449715b2594ab58f5D002) |
| **Base** | 6 | [`0xfd78EE919681417d192449715b2594ab58f5D002`](https://basescan.org/address/0xfd78EE919681417d192449715b2594ab58f5D002) |
| **Polygon PoS** | 7 | [`0xfd78EE919681417d192449715b2594ab58f5D002`](https://polygonscan.com/address/0xfd78EE919681417d192449715b2594ab58f5D002) |
| **Unichain** | 10 | [`0xfd78EE919681417d192449715b2594ab58f5D002`](https://uniscan.xyz/address/0xfd78EE919681417d192449715b2594ab58f5D002) |
| **Linea** | 11 | [`0xfd78EE919681417d192449715b2594ab58f5D002`](https://lineascan.build/address/0xfd78EE919681417d192449715b2594ab58f5D002) |
| **Codex** | 12 | [`0xfd78EE919681417d192449715b2594ab58f5D002`](https://explorer.codex.xyz/address/0xfd78EE919681417d192449715b2594ab58f5D002) |
| **Sonic** | 13 | [`0xfd78EE919681417d192449715b2594ab58f5D002`](https://sonicscan.org/address/0xfd78EE919681417d192449715b2594ab58f5D002) |
| **World Chain** | 14 | [`0xfd78EE919681417d192449715b2594ab58f5D002`](https://worldscan.org/address/0xfd78EE919681417d192449715b2594ab58f5D002) |
| **Monad** | 15 | [`0xfd78EE919681417d192449715b2594ab58f5D002`](https://monadvision.com/address/0xfd78EE919681417d192449715b2594ab58f5D002) |
| **Sei** | 16 | [`0xfd78EE919681417d192449715b2594ab58f5D002`](https://seiscan.io/address/0xfd78EE919681417d192449715b2594ab58f5D002) |
| **XDC** | 18 | [`0xfd78EE919681417d192449715b2594ab58f5D002`](https://xdcscan.com/address/0xfd78EE919681417d192449715b2594ab58f5D002) |
| **HyperEVM** | 19 | [`0xfd78EE919681417d192449715b2594ab58f5D002`](https://hyperscan.com/address/0xfd78EE919681417d192449715b2594ab58f5D002) |
| **Ink** | 21 | [`0xfd78EE919681417d192449715b2594ab58f5D002`](https://explorer.inkonchain.com/address/0xfd78EE919681417d192449715b2594ab58f5D002) |
| **Plume** | 22 | [`0xfd78EE919681417d192449715b2594ab58f5D002`](https://explorer.plume.org/address/0xfd78EE919681417d192449715b2594ab58f5D002) |
| **Arc** | 26 | [`0xfd78EE919681417d192449715b2594ab58f5D002`](https://explorer.arc.io/address/0xfd78EE919681417d192449715b2594ab58f5D002) |
| **EDGE** | 28 | [`0x338Dfd607855BeEc17f33e539Ac2479853cC8384`](https://pro.edgex.exchange/en-US/explorer/address/0x338Dfd607855BeEc17f33e539Ac2479853cC8384) |
| **Injective** | 29 | [`0xfd78EE919681417d192449715b2594ab58f5D002`](https://blockscout.injective.network/address/0xfd78EE919681417d192449715b2594ab58f5D002) |
| **Morph** | 30 | [`0xfd78EE919681417d192449715b2594ab58f5D002`](https://explorer.morph.network/address/0xfd78EE919681417d192449715b2594ab58f5D002) |
| **Pharos** | 31 | [`0xfd78EE919681417d192449715b2594ab58f5D002`](https://pharos.socialscan.io/address/0xfd78EE919681417d192449715b2594ab58f5D002) |
| **Cronos** | 32 | [`0xfd78EE919681417d192449715b2594ab58f5D002`](https://explorer.cronos.org/address/0xfd78EE919681417d192449715b2594ab58f5D002) |
| **Plasma** | 33 | [`0xfd78EE919681417d192449715b2594ab58f5D002`](https://plasmascan.to/address/0xfd78EE919681417d192449715b2594ab58f5D002) |
| **X Layer** | 37 | [`0xfd78EE919681417d192449715b2594ab58f5D002`](https://www.okx.com/web3/explorer/xlayer/address/0xfd78EE919681417d192449715b2594ab58f5D002) |

### MessageV2

| Blockchain | [Domain](https://developers.circle.com/cctp/concepts/supported-chains-and-domains.md#domain-identifiers) | Address |
| - | - | - |
| **Ethereum** | 0 | [`0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78`](https://etherscan.io/address/0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78) |
| **Avalanche** | 1 | [`0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78`](https://snowtrace.io/address/0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78) |
| **OP Mainnet** | 2 | [`0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78`](https://optimistic.etherscan.io/address/0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78) |
| **Arbitrum** | 3 | [`0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78`](https://arbiscan.io/address/0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78) |
| **Base** | 6 | [`0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78`](https://basescan.org/address/0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78) |
| **Polygon PoS** | 7 | [`0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78`](https://polygonscan.com/address/0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78) |
| **Unichain** | 10 | [`0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78`](https://uniscan.xyz/address/0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78) |
| **Linea** | 11 | [`0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78`](https://lineascan.build/address/0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78) |
| **Codex** | 12 | [`0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78`](https://explorer.codex.xyz/address/0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78) |
| **Sonic** | 13 | [`0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78`](https://sonicscan.org/address/0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78) |
| **World Chain** | 14 | [`0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78`](https://worldscan.org/address/0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78) |
| **Monad** | 15 | [`0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78`](https://monadvision.com/address/0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78) |
| **Sei** | 16 | [`0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78`](https://seiscan.io/address/0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78) |
| **XDC** | 18 | [`0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78`](https://xdcscan.com/address/0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78) |
| **HyperEVM** | 19 | [`0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78`](https://hyperscan.com/address/0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78) |
| **Ink** | 21 | [`0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78`](https://explorer.inkonchain.com/address/0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78) |
| **Plume** | 22 | [`0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78`](https://explorer.plume.org/address/0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78) |
| **Arc** | 26 | [`0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78`](https://explorer.arc.io/address/0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78) |
| **EDGE** | 28 | [`0x88ba38dbB2117879E500c11A0772e2B84Be000B3`](https://pro.edgex.exchange/en-US/explorer/address/0x88ba38dbB2117879E500c11A0772e2B84Be000B3) |
| **Injective** | 29 | [`0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78`](https://blockscout.injective.network/address/0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78) |
| **Morph** | 30 | [`0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78`](https://explorer.morph.network/address/0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78) |
| **Pharos** | 31 | [`0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78`](https://pharos.socialscan.io/address/0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78) |
| **Cronos** | 32 | [`0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78`](https://explorer.cronos.org/address/0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78) |
| **Plasma** | 33 | [`0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78`](https://plasmascan.to/address/0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78) |
| **X Layer** | 37 | [`0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78`](https://www.okx.com/web3/explorer/xlayer/address/0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78) |

## Testnet contract addresses

### TokenMessengerV2

| Blockchain | [Domain](https://developers.circle.com/cctp/concepts/supported-chains-and-domains.md#domain-identifiers) | Address |
| - | - | - |
| **Ethereum Sepolia** | 0 | [`0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`](https://sepolia.etherscan.io/address/0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA) |
| **Avalanche Fuji** | 1 | [`0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`](https://testnet.snowtrace.io/address/0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA) |
| **OP Sepolia** | 2 | [`0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`](https://sepolia-optimism.etherscan.io/address/0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA) |
| **Arbitrum Sepolia** | 3 | [`0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`](https://sepolia.arbiscan.io/address/0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA) |
| **Base Sepolia** | 6 | [`0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`](https://base-sepolia.blockscout.com/address/0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA) |
| **Polygon PoS Amoy** | 7 | [`0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`](https://amoy.polygonscan.com/address/0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA) |
| **Unichain Sepolia** | 10 | [`0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`](https://unichain-sepolia.blockscout.com/address/0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA) |
| **Linea Sepolia** | 11 | [`0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`](https://sepolia.lineascan.build/address/0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA) |
| **Codex Testnet** | 12 | [`0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`](https://explorer.codex-stg.xyz/address/0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA) |
| **Sonic Testnet** | 13 | [`0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`](https://testnet.sonicscan.org/address/0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA) |
| **World Chain Sepolia** | 14 | [`0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`](https://sepolia.worldscan.org/address/0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA) |
| **Monad Testnet** | 15 | [`0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`](https://testnet.monadexplorer.com/address/0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA) |
| **Sei Testnet** | 16 | [`0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`](https://testnet.seiscan.io/address/0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA) |
| **XDC Apothem** | 18 | [`0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`](https://testnet.xdcscan.com/address/0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA) |
| **HyperEVM Testnet** | 19 | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` |
| **Ink Testnet** | 21 | [`0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`](https://explorer-sepolia.inkonchain.com/address/0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA) |
| **Plume Testnet** | 22 | [`0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`](https://testnet-explorer.plume.org/address/0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA) |
| **Arc Testnet** | 26 | [`0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`](https://explorer.testnet.arc.io/address/0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA) |
| **EDGE Testnet** | 28 | [`0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`](https://edge-testnet.explorer.alchemy.com/address/0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA) |
| **Injective Testnet** | 29 | [`0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`](https://testnet.blockscout.injective.network/address/0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA) |
| **Morph Hoodi Testnet** | 30 | [`0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`](https://explorer-hoodi.morph.network/address/0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA) |
| **Pharos Testnet** | 31 | [`0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`](https://pharos-testnet.socialscan.io/address/0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA) |
| **Cronos Testnet** | 32 | [`0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`](https://explorer.cronos.org/testnet/address/0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA) |
| **Plasma Testnet** | 33 | [`0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`](https://testnet.plasmascan.to/address/0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA) |
| **X Layer Testnet** | 37 | [`0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`](https://www.okx.com/web3/explorer/xlayer-test/address/0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA) |

### TokenMessengerWithFees

| Blockchain | [Domain](https://developers.circle.com/cctp/concepts/supported-chains-and-domains.md#domain-identifiers) | Address |
| - | - | - |
| **Ethereum Sepolia** | 0 | [`0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A`](https://sepolia.etherscan.io/address/0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A) |
| **Avalanche Fuji** | 1 | [`0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A`](https://testnet.snowtrace.io/address/0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A) |
| **OP Sepolia** | 2 | [`0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A`](https://sepolia-optimism.etherscan.io/address/0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A) |
| **Arbitrum Sepolia** | 3 | [`0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A`](https://sepolia.arbiscan.io/address/0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A) |
| **Base Sepolia** | 6 | [`0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A`](https://base-sepolia.blockscout.com/address/0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A) |
| **Polygon PoS Amoy** | 7 | [`0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A`](https://amoy.polygonscan.com/address/0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A) |
| **Unichain Sepolia** | 10 | [`0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A`](https://unichain-sepolia.blockscout.com/address/0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A) |
| **Linea Sepolia** | 11 | [`0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A`](https://sepolia.lineascan.build/address/0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A) |
| **Codex Testnet** | 12 | [`0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A`](https://explorer.codex-stg.xyz/address/0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A) |
| **Sonic Testnet** | 13 | [`0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A`](https://testnet.sonicscan.org/address/0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A) |
| **World Chain Sepolia** | 14 | [`0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A`](https://sepolia.worldscan.org/address/0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A) |
| **Sei Testnet** | 16 | [`0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A`](https://testnet.seiscan.io/address/0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A) |
| **XDC Apothem** | 18 | [`0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A`](https://testnet.xdcscan.com/address/0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A) |
| **HyperEVM Testnet** | 19 | [`0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A`](https://explore-testnet.hyperpc.app/address/0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A) |
| **Ink Testnet** | 21 | [`0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A`](https://explorer-sepolia.inkonchain.com/address/0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A) |
| **Plume Testnet** | 22 | [`0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A`](https://testnet-explorer.plume.org/address/0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A) |
| **Arc Testnet** | 26 | [`0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A`](https://explorer.testnet.arc.io/address/0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A) |

> [!NOTE]
>
> Upfront fees aren't available on Monad Testnet.

### MessageTransmitterV2

| Blockchain | [Domain](https://developers.circle.com/cctp/concepts/supported-chains-and-domains.md#domain-identifiers) | Address |
| - | - | - |
| **Ethereum Sepolia** | 0 | [`0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`](https://sepolia.etherscan.io/address/0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275) |
| **Avalanche Fuji** | 1 | [`0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`](https://testnet.snowtrace.io/address/0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275) |
| **OP Sepolia** | 2 | [`0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`](https://sepolia-optimism.etherscan.io/address/0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275) |
| **Arbitrum Sepolia** | 3 | [`0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`](https://sepolia.arbiscan.io/address/0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275) |
| **Base Sepolia** | 6 | [`0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`](https://base-sepolia.blockscout.com/address/0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275) |
| **Polygon PoS Amoy** | 7 | [`0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`](https://amoy.polygonscan.com/address/0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275) |
| **Unichain Sepolia** | 10 | [`0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`](https://unichain-sepolia.blockscout.com/address/0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275) |
| **Linea Sepolia** | 11 | [`0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`](https://sepolia.lineascan.build/address/0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275) |
| **Codex Testnet** | 12 | [`0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`](https://explorer.codex-stg.xyz/address/0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275) |
| **Sonic Testnet** | 13 | [`0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`](https://testnet.sonicscan.org/address/0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275) |
| **World Chain Sepolia** | 14 | [`0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`](https://sepolia.worldscan.org/address/0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275) |
| **Monad Testnet** | 15 | [`0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`](https://testnet.monadexplorer.com/address/0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275) |
| **Sei Testnet** | 16 | [`0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`](https://testnet.seiscan.io/address/0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275) |
| **XDC Apothem** | 18 | [`0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`](https://testnet.xdcscan.com/address/0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275) |
| **HyperEVM Testnet** | 19 | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` |
| **Ink Testnet** | 21 | [`0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`](https://explorer-sepolia.inkonchain.com/address/0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275) |
| **Plume Testnet** | 22 | [`0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`](https://testnet-explorer.plume.org/address/0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275) |
| **Arc Testnet** | 26 | [`0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`](https://explorer.testnet.arc.io/address/0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275) |
| **EDGE Testnet** | 28 | [`0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`](https://edge-testnet.explorer.alchemy.com/address/0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275) |
| **Injective Testnet** | 29 | [`0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`](https://testnet.blockscout.injective.network/address/0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275) |
| **Morph Hoodi Testnet** | 30 | [`0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`](https://explorer-hoodi.morph.network/address/0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275) |
| **Pharos Testnet** | 31 | [`0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`](https://pharos-testnet.socialscan.io/address/0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275) |
| **Cronos Testnet** | 32 | [`0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`](https://explorer.cronos.org/testnet/address/0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275) |
| **Plasma Testnet** | 33 | [`0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`](https://testnet.plasmascan.to/address/0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275) |
| **X Layer Testnet** | 37 | [`0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`](https://www.okx.com/web3/explorer/xlayer-test/address/0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275) |

### TokenMinterV2

| Blockchain | [Domain](https://developers.circle.com/cctp/concepts/supported-chains-and-domains.md#domain-identifiers) | Address |
| - | - | - |
| **Ethereum Sepolia** | 0 | [`0xb43db544E2c27092c107639Ad201b3dEfAbcF192`](https://sepolia.etherscan.io/address/0xb43db544E2c27092c107639Ad201b3dEfAbcF192) |
| **Avalanche Fuji** | 1 | [`0xb43db544E2c27092c107639Ad201b3dEfAbcF192`](https://testnet.snowtrace.io/address/0xb43db544E2c27092c107639Ad201b3dEfAbcF192) |
| **OP Sepolia** | 2 | [`0xb43db544E2c27092c107639Ad201b3dEfAbcF192`](https://sepolia-optimism.etherscan.io/address/0xb43db544E2c27092c107639Ad201b3dEfAbcF192) |
| **Arbitrum Sepolia** | 3 | [`0xb43db544E2c27092c107639Ad201b3dEfAbcF192`](https://sepolia.arbiscan.io/address/0xb43db544E2c27092c107639Ad201b3dEfAbcF192) |
| **Base Sepolia** | 6 | [`0xb43db544E2c27092c107639Ad201b3dEfAbcF192`](https://base-sepolia.blockscout.com/address/0xb43db544E2c27092c107639Ad201b3dEfAbcF192) |
| **Polygon PoS Amoy** | 7 | [`0xb43db544E2c27092c107639Ad201b3dEfAbcF192`](https://amoy.polygonscan.com/address/0xb43db544E2c27092c107639Ad201b3dEfAbcF192) |
| **Unichain Sepolia** | 10 | [`0xb43db544E2c27092c107639Ad201b3dEfAbcF192`](https://unichain-sepolia.blockscout.com/address/0xb43db544E2c27092c107639Ad201b3dEfAbcF192) |
| **Linea Sepolia** | 11 | [`0xb43db544E2c27092c107639Ad201b3dEfAbcF192`](https://sepolia.lineascan.build/address/0xb43db544E2c27092c107639Ad201b3dEfAbcF192) |
| **Codex Testnet** | 12 | [`0xb43db544E2c27092c107639Ad201b3dEfAbcF192`](https://explorer.codex-stg.xyz/address/0xb43db544E2c27092c107639Ad201b3dEfAbcF192) |
| **Sonic Testnet** | 13 | [`0xb43db544E2c27092c107639Ad201b3dEfAbcF192`](https://testnet.sonicscan.org/address/0xb43db544E2c27092c107639Ad201b3dEfAbcF192) |
| **World Chain Sepolia** | 14 | [`0xb43db544E2c27092c107639Ad201b3dEfAbcF192`](https://sepolia.worldscan.org/address/0xb43db544E2c27092c107639Ad201b3dEfAbcF192) |
| **Monad Testnet** | 15 | [`0xb43db544E2c27092c107639Ad201b3dEfAbcF192`](https://testnet.monadexplorer.com/address/0xb43db544E2c27092c107639Ad201b3dEfAbcF192) |
| **Sei Testnet** | 16 | [`0xb43db544E2c27092c107639Ad201b3dEfAbcF192`](https://testnet.seiscan.io/address/0xb43db544E2c27092c107639Ad201b3dEfAbcF192) |
| **XDC Apothem** | 18 | [`0xb43db544E2c27092c107639Ad201b3dEfAbcF192`](https://testnet.xdcscan.com/address/0xb43db544E2c27092c107639Ad201b3dEfAbcF192) |
| **HyperEVM Testnet** | 19 | `0xb43db544E2c27092c107639Ad201b3dEfAbcF192` |
| **Ink Testnet** | 21 | [`0xb43db544E2c27092c107639Ad201b3dEfAbcF192`](https://explorer-sepolia.inkonchain.com/address/0xb43db544E2c27092c107639Ad201b3dEfAbcF192) |
| **Plume Testnet** | 22 | [`0xb43db544E2c27092c107639Ad201b3dEfAbcF192`](https://testnet-explorer.plume.org/address/0xb43db544E2c27092c107639Ad201b3dEfAbcF192) |
| **Arc Testnet** | 26 | [`0xb43db544E2c27092c107639Ad201b3dEfAbcF192`](https://explorer.testnet.arc.io/address/0xb43db544E2c27092c107639Ad201b3dEfAbcF192) |
| **EDGE Testnet** | 28 | [`0xb43db544E2c27092c107639Ad201b3dEfAbcF192`](https://edge-testnet.explorer.alchemy.com/address/0xb43db544E2c27092c107639Ad201b3dEfAbcF192) |
| **Injective Testnet** | 29 | [`0xb43db544E2c27092c107639Ad201b3dEfAbcF192`](https://testnet.blockscout.injective.network/address/0xb43db544E2c27092c107639Ad201b3dEfAbcF192) |
| **Morph Hoodi Testnet** | 30 | [`0xb43db544E2c27092c107639Ad201b3dEfAbcF192`](https://explorer-hoodi.morph.network/address/0xb43db544E2c27092c107639Ad201b3dEfAbcF192) |
| **Pharos Testnet** | 31 | [`0xb43db544E2c27092c107639Ad201b3dEfAbcF192`](https://pharos-testnet.socialscan.io/address/0xb43db544E2c27092c107639Ad201b3dEfAbcF192) |
| **Cronos Testnet** | 32 | [`0xb43db544E2c27092c107639Ad201b3dEfAbcF192`](https://explorer.cronos.org/testnet/address/0xb43db544E2c27092c107639Ad201b3dEfAbcF192) |
| **Plasma Testnet** | 33 | [`0xb43db544E2c27092c107639Ad201b3dEfAbcF192`](https://testnet.plasmascan.to/address/0xb43db544E2c27092c107639Ad201b3dEfAbcF192) |
| **X Layer Testnet** | 37 | [`0xb43db544E2c27092c107639Ad201b3dEfAbcF192`](https://www.okx.com/web3/explorer/xlayer-test/address/0xb43db544E2c27092c107639Ad201b3dEfAbcF192) |

### MessageV2

| Blockchain | [Domain](https://developers.circle.com/cctp/concepts/supported-chains-and-domains.md#domain-identifiers) | Address |
| - | - | - |
| **Ethereum Sepolia** | 0 | [`0xbaC0179bB358A8936169a63408C8481D582390C4`](https://sepolia.etherscan.io/address/0xbaC0179bB358A8936169a63408C8481D582390C4) |
| **Avalanche Fuji** | 1 | [`0xbaC0179bB358A8936169a63408C8481D582390C4`](https://testnet.snowtrace.io/address/0xbaC0179bB358A8936169a63408C8481D582390C4) |
| **OP Sepolia** | 2 | [`0xbaC0179bB358A8936169a63408C8481D582390C4`](https://sepolia-optimism.etherscan.io/address/0xbaC0179bB358A8936169a63408C8481D582390C4) |
| **Arbitrum Sepolia** | 3 | [`0xbaC0179bB358A8936169a63408C8481D582390C4`](https://sepolia.arbiscan.io/address/0xbaC0179bB358A8936169a63408C8481D582390C4) |
| **Base Sepolia** | 6 | [`0xbaC0179bB358A8936169a63408C8481D582390C4`](https://base-sepolia.blockscout.com/address/0xbaC0179bB358A8936169a63408C8481D582390C4) |
| **Polygon PoS Amoy** | 7 | [`0xbaC0179bB358A8936169a63408C8481D582390C4`](https://amoy.polygonscan.com/address/0xbaC0179bB358A8936169a63408C8481D582390C4) |
| **Unichain Sepolia** | 10 | [`0xbaC0179bB358A8936169a63408C8481D582390C4`](https://unichain-sepolia.blockscout.com/address/0xbaC0179bB358A8936169a63408C8481D582390C4) |
| **Linea Sepolia** | 11 | [`0xbaC0179bB358A8936169a63408C8481D582390C4`](https://sepolia.lineascan.build/address/0xbaC0179bB358A8936169a63408C8481D582390C4) |
| **Codex Testnet** | 12 | [`0xbaC0179bB358A8936169a63408C8481D582390C4`](https://explorer.codex-stg.xyz/address/0xbaC0179bB358A8936169a63408C8481D582390C4) |
| **Sonic Testnet** | 13 | [`0xbaC0179bB358A8936169a63408C8481D582390C4`](https://testnet.sonicscan.org/address/0xbaC0179bB358A8936169a63408C8481D582390C4) |
| **World Chain Sepolia** | 14 | [`0xbaC0179bB358A8936169a63408C8481D582390C4`](https://sepolia.worldscan.org/address/0xbaC0179bB358A8936169a63408C8481D582390C4) |
| **Monad Testnet** | 15 | [`0xbaC0179bB358A8936169a63408C8481D582390C4`](https://testnet.monadexplorer.com/address/0xbaC0179bB358A8936169a63408C8481D582390C4) |
| **Sei Testnet** | 16 | [`0xbaC0179bB358A8936169a63408C8481D582390C4`](https://testnet.seiscan.io/address/0xbaC0179bB358A8936169a63408C8481D582390C4) |
| **XDC Apothem** | 18 | [`0xbaC0179bB358A8936169a63408C8481D582390C4`](https://testnet.xdcscan.com/address/0xbaC0179bB358A8936169a63408C8481D582390C4) |
| **HyperEVM Testnet** | 19 | `0xbaC0179bB358A8936169a63408C8481D582390C4` |
| **Ink Testnet** | 21 | [`0xbaC0179bB358A8936169a63408C8481D582390C4`](https://explorer-sepolia.inkonchain.com/address/0xbaC0179bB358A8936169a63408C8481D582390C4) |
| **Plume Testnet** | 22 | [`0xbaC0179bB358A8936169a63408C8481D582390C4`](https://testnet-explorer.plume.org/address/0xbaC0179bB358A8936169a63408C8481D582390C4) |
| **Arc Testnet** | 26 | [`0xbaC0179bB358A8936169a63408C8481D582390C4`](https://explorer.testnet.arc.io/address/0xbaC0179bB358A8936169a63408C8481D582390C4) |
| **EDGE Testnet** | 28 | [`0xbaC0179bB358A8936169a63408C8481D582390C4`](https://edge-testnet.explorer.alchemy.com/address/0xbaC0179bB358A8936169a63408C8481D582390C4) |
| **Injective Testnet** | 29 | [`0xbaC0179bB358A8936169a63408C8481D582390C4`](https://testnet.blockscout.injective.network/address/0xbaC0179bB358A8936169a63408C8481D582390C4) |
| **Morph Hoodi Testnet** | 30 | [`0xbaC0179bB358A8936169a63408C8481D582390C4`](https://explorer-hoodi.morph.network/address/0xbaC0179bB358A8936169a63408C8481D582390C4) |
| **Pharos Testnet** | 31 | [`0xbaC0179bB358A8936169a63408C8481D582390C4`](https://pharos-testnet.socialscan.io/address/0xbaC0179bB358A8936169a63408C8481D582390C4) |
| **Cronos Testnet** | 32 | [`0xbaC0179bB358A8936169a63408C8481D582390C4`](https://explorer.cronos.org/testnet/address/0xbaC0179bB358A8936169a63408C8481D582390C4) |
| **Plasma Testnet** | 33 | [`0xbaC0179bB358A8936169a63408C8481D582390C4`](https://testnet.plasmascan.to/address/0xbaC0179bB358A8936169a63408C8481D582390C4) |
| **X Layer Testnet** | 37 | [`0xbaC0179bB358A8936169a63408C8481D582390C4`](https://www.okx.com/web3/explorer/xlayer-test/address/0xbaC0179bB358A8936169a63408C8481D582390C4) |
