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

# CCTP-enabled HyperCore transfers

CCTP lets you transfer USDC from all supported CCTP domains to HyperCore using a
`CoreDepositWallet` contract deployed on HyperEVM. The `CoreDepositWallet`
handles depositing and withdrawing USDC between HyperEVM and HyperCore. This
topic explains how the HyperCore workflow works and covers HyperCore-specific
considerations.

> [!NOTE]
>
> **Note:** HyperCore balances reflect protocol-level credits, not Circle-issued
> USDC. Native USDC remains in the `CoreDepositWallet` contract on HyperEVM and
> withdrawals are required to [redeem native USDC from
> HyperEVM](https://developers.circle.com/cctp/howtos/withdraw-usdc-from-hypercore-to-evm.md).

## How it works

The HyperCore workflow from source chains that are not HyperEVM is a two-step
process: funds are transferred in the standard CCTP workflow to HyperEVM, then
forwarded to HyperCore by depositing them into the `CoreDepositWallet` contract.

The burn transaction uses one of three contracts depending on the source chain
and integration pattern:

* `TokenMessengerV2` contract
* `CctpExtension` contract
* `CctpExtensionV2` contract (Arbitrum only; sponsored / relayer-submitted
  deposits)

The burn transaction includes a hook that calls the `CctpForwarder` contract on
HyperEVM to forward the USDC to the recipient address on HyperCore.

Here's how the HyperCore deposit workflow works:

1. Check the CCTP API for fees. Fast transfers from Arbitrum with a HyperCore
   destination have no fast transfer fee. Using Circle's Forwarder Service to
   forward to HyperCore is optional and has a dynamic destination chain gas fee.
2. Calculate the USDC amounts minus fees.
3. Approve the contract to spend the amount of USDC you want to burn. If you are
   interacting with the `TokenMessengerV2` contract, you can do this with a call
   to the `approve` function on the USDC contract. If you are interacting with
   the `CctpExtension` contract on Arbitrum, you sign a
   `ReceiveWithAuthorization` message.
4. Sign and broadcast a burn transaction. The type depends on the source domain:
   * **CctpExtension contract on Arbitrum**: Sign and broadcast a
     `batchDepositForBurnWithAuth` transaction. Set HyperEVM as the destination.
     Include hook data to call the `CctpForwarder` contract on HyperEVM.
   * **TokenMessengerV2 contract**: Sign and broadcast a `depositForBurn`
     transaction. Set HyperEVM as the destination. Include hook data to call the
     `CctpForwarder` contract on HyperEVM.

### Sponsored deposits on Arbitrum

`CctpExtensionV2` is a separate Arbitrum contract from `CctpExtension`. It
enables gas-sponsored CCTP burns: the end user signs a single EIP-3009
`ReceiveWithAuthorization` offchain, and a relayer submits the Arbitrum
transaction via `batchSponsorDepositForBurn`, paying ETH gas on the user's
behalf.

Use this path when your users hold USDC on Arbitrum but not native gas (for
example, email-login or CEX-funded wallets). Most integrators who control their
own wallet and gas should continue using `CctpExtension` or `TokenMessengerV2`
as documented in
[Transfer USDC from Arbitrum to HyperCore](https://developers.circle.com/cctp/howtos/transfer-usdc-from-arbitrum-to-hypercore.md).

Key differences from `CctpExtension`:

1. The relayer, not the depositor, broadcasts the burn transaction.
2. The EIP-3009 authorization nonce is deterministically derived from the
   deposit parameters (destination, recipient, fees, hook data), which binds the
   user's signature to the intended CCTP transfer.
3. The relayer may batch multiple user deposits in one transaction.

After the burn, the crosschain path is the same as other Arbitrum → HyperCore
transfers: CCTP attestation, mint on HyperEVM, optional `CctpForwarder` hook to
HyperCore.

For contract addresses, see
[HyperCore CCTP-Enablement Contract Addresses](https://developers.circle.com/cctp/references/hypercore-contract-addresses.md).
For the contract interface, see
[CctpExtensionV2 Contract Interface](https://developers.circle.com/cctp/references/cctp-extension-v2-contract-interface.md).
For integration steps, see
[Transfer USDC from Arbitrum to HyperCore with CctpExtensionV2](https://developers.circle.com/cctp/howtos/transfer-usdc-from-arbitrum-to-hypercore-with-cctp-extension-v2.md).

HyperCore deposits and withdrawals are supported to/from any CCTP-supported
blockchain. Forwarding for these transfers is optional and is supported for all
[Forwarder-supported blockchains](https://developers.circle.com/cctp/concepts/supported-chains-and-domains.md#supported-blockchains)
except for withdrawals to Solana.

## Important considerations

Keep these things in mind when using CCTP with HyperCore.

### Testnet recipient address limitations

When you test USDC transfers to HyperCore on testnet, the recipient address has
limits:

* The recipient address must already exist on HyperCore mainnet.
* Addresses that already exist on mainnet can only receive up to \$1000 testnet
  USDC.
* Transfers to addresses without mainnet state fail silently.

To check if an address exists on mainnet, use Hyperliquid's info API:

```shell theme={null}
curl -X POST https://api.hyperliquid.xyz/info \
  -H "Content-Type: application/json" \
  -d '
{
    "type": "userRole",
    "user": "${USER_ADDRESS}"
}
'
```

### Account activation fee on HyperCore

New HyperCore accounts are subject to a one-time 1 USDC activation fee, managed
entirely by the Hyperliquid protocol. Circle's `CoreDepositWallet` contract does
not collect or enforce this fee.

When a new user first deposits USDC to HyperCore, the full deposit amount is
credited to their tradable balance. The 1 USDC activation fee is earmarked at
the account level and charged on the user's first outbound action, such as a
withdrawal or `SendAsset` transfer. Until that first outbound action, the
account is considered unactivated and cannot perform
[CoreWriter actions](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/activation-gas-fee).

This means:

* There is no minimum deposit amount. Deposits of any size, including less than
  1 USDC, will succeed.
* The user's first outbound action (withdrawal, transfer, etc.) requires a
  balance of at least 1 USDC. If the balance is below 1 USDC at that time, the
  action will fail.
* After the activation fee is paid, subsequent outbound actions are not subject
  to it.

> [!NOTE]
>
> The activation fee is separate from CCTP forwarding fees. When calculating
> total costs for a new user's first withdrawal, account for both the 1 USDC
> activation fee (charged by Hyperliquid) and any applicable CCTP forwarding
> fee.

### Best practices for new account deposits

When your integration deposits USDC to a new HyperCore account:

* Ensure the deposit is large enough that the recipient will have at least 1
  USDC available for their first outbound action.
* Inform end users that their first withdrawal or transfer from HyperCore
  includes a one-time 1 USDC activation fee deducted by the Hyperliquid
  protocol.
* If your integration creates accounts programmatically (for example, contract
  addresses), you can pre-activate the account by sending an activation
  transaction to the EVM contract address on HyperCore, as described in
  [Hyperliquid's documentation](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/activation-gas-fee).
