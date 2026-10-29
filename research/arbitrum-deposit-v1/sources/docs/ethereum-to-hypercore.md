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

# Transfer USDC from Ethereum to HyperCore

This guide shows the steps to transfer USDC from Ethereum to HyperCore using the
`TokenMessengerV2` contract with hook data to call the `CctpForwarder` contract
on HyperEVM. This CCTP flow follows the same pattern as USDC transfers from
Ethereum to any other domain, except for the inclusion of hook data to call the
`CctpForwarder` contract on HyperEVM.

While this guide uses Ethereum as an example, the same steps apply to any EVM
chain that supports CCTP via `TokenMessengerV2`. Adjust the source domain ID and
contract addresses for your chain.

This guide does not provide full example code, you can find an example of
transfers from Ethereum in the
[CCTP quickstart](https://developers.circle.com/cctp/howtos/cctp/quickstarts/transfer-usdc-ethereum-to-arc.md).

> [!NOTE]
>
> Fast Transfers from Ethereum to HyperEVM incur a protocol fee and a dynamic
> forwarding fee for the HyperEVM chain relay transaction. Fast Transfer is the
> default for transfers from Ethereum to HyperCore.

## Steps

Use the following steps to transfer USDC from Ethereum to HyperCore.

### Step 1. Get CCTP fees from the API

Query the CCTP API for the fees for transferring USDC from Ethereum to
HyperCore. This value is passed to the `maxFee` parameter in the
`depositForBurnWithHook` transaction. The following is an example request to the
CCTP using source domain 0 (Ethereum) and destination domain 19 (HyperEVM):

```shell theme={null}
curl --request GET \
  --url 'https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/0/19?forward=true&hyperCoreDeposit=true' \
  --header 'Content-Type: application/json'
```

**Response:**

```json theme={null}
[
  {
    "finalityThreshold": 1000, // fast transfer
    "minimumFee": 1, // in basis points
    "forwardFee": {
      "low": 211203,
      "med": 216109, // 0.216109 USDC
      "high": 221014
    }
  },
  {
    "finalityThreshold": 2000, // standard transfer
    "minimumFee": 0,
    "forwardFee": {
      "low": 211203,
      "med": 216109, // 0.216109 USDC
      "high": 221014
    }
  }
]
```

### Step 2. Calculate the USDC amounts minus fees

There is a protocol fee to deposit USDC from Ethereum to HyperEVM and a dynamic
forwarding fee for the HyperEVM chain relay transaction. The CCTP fast transfer
fee is 1 basis point (0.01%) of the transfer amount. The forwarding fee is 0.20
USDC (`0_200_000` subunits) plus a dynamic destination chain gas fee. For a 10
USDC transfer from Ethereum to HyperCore, the protocol fee is 0.001 USDC (10
USDC × 0.0001) and an example forwarding fee is 0.216109 USDC, for a total fee
of 0.217109 USDC.

Because the protocol fee scales with the transfer amount and the forwarding fee
is dynamic, you must recalculate `maxFee` for each transfer. For a programmatic
approach, see [`calculateMaxFee`](https://developers.circle.com/cctp/concepts/fees#maximum-fee-parameter) on
the fees page.

### Step 3. Approve the USDC transfer

To allow the `TokenMessengerV2` contract to transfer the USDC on your behalf,
you need to approve the transfer. This is done by calling the `approve` function
on the USDC contract.

You can see an example of this contract call in the
[Ethereum CCTP V2 example on GitHub](https://github.com/circlefin/solana-cctp-contracts/blob/9f8cf26d059cf8927ae0a0b351f3a7a88c7bdade/examples/v2/evm.ts#L63).

### Step 4. Sign and broadcast a `depositForBurnWithHook` transaction on the `TokenMessengerV2` contract

Create a `depositForBurnWithHook` transaction for the `TokenMessengerV2`
contract with the following parameters:

* `amount`: The amount of USDC to transfer
* `destinationDomain`: 19 (HyperEVM)
* `mintRecipient`: The address of the `CctpForwarder` contract on HyperEVM
* `burnToken`: The address of the USDC contract on the source chain
* `destinationCaller`: The address of the `CctpForwarder` contract on HyperEVM
* `maxFee`: The protocol fee + forwarding fee calculated in Step 2
* `minFinalityThreshold`: `1000` (Fast Transfer)
* `hookData`: The hook data to call the `CctpForwarder` contract on HyperEVM

> [!WARNING]
>
> Always set both `mintRecipient` and `destinationCaller` to the `CctpForwarder`
> [contract address](https://developers.circle.com/cctp/references/hypercore-contract-addresses.md) on HyperEVM
> when you transfer USDC to HyperCore.
>
> * If `destinationCaller` is wrong, the forwarder cannot complete the transfer.
> * If `mintRecipient` is wrong, the minted USDC is not sent to the forwarder.
>
> In either case, funds become permanently stuck and **cannot be recovered**.

The `hookData` is the data to execute the forwarder to HyperCore. The following
is an example of the hook data:

```ts TypeScript theme={null}
/**
 * Generate CCTP forwarder hook data for HyperCore
 *
 * Hook Data Format:
 * Field                        Bytes      Type       Index
 * magicBytes                   24         bytes24    0     ASCII prefix "cctp-forward", followed by padding
 * version                      4          uint32     24
 * dataLength                   4          uint32     28
 * hyperCoreMintRecipient       20         address    32    EVM address - optional, included if requesting a deposit to HyperCore
 * hyperCoreDestinationDex      4          uint32     52    The destinationDexId on HyperCore (0 for perp and uint32.max for spot)
 */
function encodeForwardHookData(
  hyperCoreMintRecipient?: `0x${string}`,
  hyperCoreDestinationDex: number = 0,
): `0x${string}` {
  // Validate hex prefix if recipient provided
  if (hyperCoreMintRecipient && !hyperCoreMintRecipient.startsWith("0x")) {
    throw new Error("Address must start with 0x");
  }

  // Magic bytes: "cctp-forward" (12 chars) padded to 24 bytes with zeros
  const magic = "cctp-forward";
  const magicHex = Buffer.from(magic, "utf-8").toString("hex").padEnd(48, "0");

  // Version: uint32 = 0 (4 bytes, big-endian)
  const version = "00000000";

  if (!hyperCoreMintRecipient) {
    // No recipient: dataLength = 0, return header only (32 bytes)
    const dataLength = "00000000";
    return `0x${magicHex}${version}${dataLength}`;
  }

  // With recipient: dataLength = 24 (20 bytes address + 4 bytes dex)
  const dataLength = "00000018"; // 24 in hex

  // Address: 20 bytes (remove 0x prefix)
  const address = hyperCoreMintRecipient.slice(2).toLowerCase();

  // Destination DEX: uint32 big-endian
  // 0 = perps, 4294967295 (0xFFFFFFFF) = spot
  const dex = (hyperCoreDestinationDex >>> 0).toString(16).padStart(8, "0");

  return `0x${magicHex}${version}${dataLength}${address}${dex}`;
}
```

You can see an example of this contract call in the
[Ethereum V2 example on GitHub](https://github.com/circlefin/solana-cctp-contracts/blob/9f8cf26d059cf8927ae0a0b351f3a7a88c7bdade/examples/v2/evm.ts#L105)

Once the deposit transaction is confirmed, the USDC is minted on HyperEVM and
automatically forwarded to your address on HyperCore.

By default (when `hyperCoreDestinationDex` is `0`), deposits credit the perps
balance on HyperCore. To deposit to the spot balance, set
`hyperCoreDestinationDex` to `4294967295` (uint32 max value).
