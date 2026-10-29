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

# Transfer USDC from Arbitrum to HyperCore

This guide shows how to transfer USDC from Arbitrum to HyperCore using the
`CctpExtension` contract.

> [!NOTE]
>
> Fast Transfers from Arbitrum to HyperEVM have no fees, however there is a flat
> forwarding fee for Arbitrum transfers to HyperCore. Fast Transfer is the default
> for transfers from Arbitrum to HyperEVM.

## Prerequisites

Before you begin, ensure that you've:

* Installed [Node.js v22.18+](https://nodejs.org/)

* Prepared an EVM testnet wallet with the private key available
  * Added Arbitrum Sepolia network to your wallet
    ([network details](https://docs.arbitrum.io/build-decentralized-apps/reference/node-providers))

* Funded your wallet with the following testnet tokens:
  * Arbitrum Sepolia ETH (native token) from a
    [public faucet](https://faucet.quicknode.com/arbitrum/sepolia)
  * Arbitrum Sepolia USDC from the [Circle Faucet](https://faucet.circle.com)

* Created a new Node project and installed dependencies:

  ```bash theme={null}
  npm install viem
  npm install -D typescript @types/node
  ```

* Created a `.env` file with required environment variables:

  ```text theme={null}
  PRIVATE_KEY=0x...
  FORWARD_RECIPIENT=0x...  # Your HyperCore address to receive the USDC
  ```

## Steps

Use the following steps to transfer USDC from Arbitrum to HyperCore.

### Step 1. Get CCTP fees from the API

Query the CCTP API for the fees for transferring USDC from Arbitrum to
HyperCore. This value is passed to the `maxFee` parameter in the
`batchDepositForBurnWithAuth` transaction. The following is an example request
to the CCTP using source domain 3 (Arbitrum) and destination domain 19
(HyperEVM):

```shell theme={null}
curl --request GET \
  --url 'https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/3/19?forward=true&hyperCoreDeposit=true' \
  --header 'Content-Type: application/json'
```

**Response:**

```json theme={null}
[
  {
    "finalityThreshold": 1000, // fast transfer
    "minimumFee": 0, // no protocol fee
    "forwardFee": {
      "low": 200000, // 0.20 USDC
      "med": 200000, // low, med, high will be the same static fee
      "high": 200000
    }
  },
  {
    "finalityThreshold": 2000, // standard transfer
    "minimumFee": 0,
    "forwardFee": {
      "low": 200000,
      "med": 200000,
      "high": 200000
    }
  }
]
```

### Step 2. Calculate the USDC amounts minus fees

There is no fee to deposit USDC from Arbitrum to HyperEVM, but there is a flat
forwarding fee for the transfer to HyperCore. The forwarding fee is 0.20 USDC
(`0_200_000` subunits). For a 10 USDC transfer from Arbitrum to HyperCore, the
total fee is 0.20 USDC.

> [!NOTE]
>
> The forwarding fee is deducted from your transfer amount. For a 10 USDC
> transfer, you will receive 9.80 USDC on HyperCore.

### Step 3. Sign a `ReceiveWithAuthorization` transaction on the USDC contract

Create a `ReceiveWithAuthorization` transaction for the USDC contract with the
following parameters:

* `from`: Your wallet address
* `to`: The `CctpExtension` contract address
* `value`: The amount of USDC to transfer
* `validAfter`: The timestamp after which the transaction is valid
* `validBefore`: The timestamp before which the transaction is valid
* `nonce`: A random nonce

Sign the hash of the transaction with your private key, and derive the `v`, `r`,
`s` values. Broadcast the transaction to the blockchain.

### Step 4. Sign and broadcast a `batchDepositForBurnWithAuth` transaction on the `CctpExtension` contract

Create a `batchDepositForBurnWithAuth` transaction for the `CctpExtension`
contract with the following parameters:

* `destinationDomain`: 19 (HyperEVM)
* `mintRecipient`: The `CctpForwarder` contract address on HyperEVM
* `destinationCaller`: The `CctpForwarder` contract address on HyperEVM
* `maxFee`: `0_200_000` (0.20 USDC, from step 2)
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

Once the deposit transaction is confirmed, the USDC is minted on HyperEVM and
automatically forwarded to your address on HyperCore.

By default (when `hyperCoreDestinationDex` is `0`), deposits credit the perps
balance on HyperCore. To deposit to the spot balance, set
`hyperCoreDestinationDex` to `4294967295` (uint32 max value).

## Full example code

The following is a complete example of how to transfer USDC from Arbitrum to
HyperCore.

```ts script.ts expandable theme={null}
/**
 * Script: Call CctpExtension.batchDepositForBurnWithAuth
 * - Generates EIP-3009 receiveWithAuthorization signature
 * - Executes a CCTP burn via the extension
 * - Supports Forwarder hook data to auto-forward to HyperCore
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  parseUnits,
  formatUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";

// -------- Contract ABIs --------
const CCTP_EXTENSION_ABI = [
  {
    name: "batchDepositForBurnWithAuth",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "_receiveWithAuthorizationData",
        type: "tuple",
        components: [
          { name: "amount", type: "uint256" },
          { name: "authValidAfter", type: "uint256" },
          { name: "authValidBefore", type: "uint256" },
          { name: "authNonce", type: "bytes32" },
          { name: "v", type: "uint8" },
          { name: "r", type: "bytes32" },
          { name: "s", type: "bytes32" },
        ],
      },
      {
        name: "_depositForBurnData",
        type: "tuple",
        components: [
          { name: "amount", type: "uint256" },
          { name: "destinationDomain", type: "uint32" },
          { name: "mintRecipient", type: "bytes32" },
          { name: "destinationCaller", type: "bytes32" },
          { name: "maxFee", type: "uint256" },
          { name: "minFinalityThreshold", type: "uint32" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

// -------- Configuration --------
const config = {
  privateKey: (process.env.PRIVATE_KEY || "0x") as Hex,

  // Contract addresses (Arbitrum Sepolia Testnet)
  cctpExtension: "0x8E4e3d0E95C1bEC4F3eC7F69aa48473E0Ab6eB8D" as Address,
  usdcToken: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" as Address,

  // Transfer parameters
  amount: "2", // USDC amount to transfer
  maxFee: "0.2", // Max fee in USDC

  // CCTP parameters
  destinationDomain: 19, // HyperEVM domain
  cctpForwarder: "0x02e39ECb8368b41bF68FF99ff351aC9864e5E2a2" as Address, // HyperEVM testnet

  // HyperCore recipient
  forwardRecipient: process.env.FORWARD_RECIPIENT as Address,
  destinationDex: 0, // 0 = perps, 4294967295 = spot

  // EIP-3009 validity window (seconds)
  validAfter: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
  validBefore: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
};

// -------- Generate Hook Data --------
function encodeForwardHookData(
  hyperCoreMintRecipient?: `0x${string}`,
  hyperCoreDestinationDex: number = 0,
): `0x${string}` {
  if (hyperCoreMintRecipient && !hyperCoreMintRecipient.startsWith("0x")) {
    throw new Error("Address must start with 0x");
  }

  const magic = "cctp-forward";
  const magicHex = Buffer.from(magic, "utf-8").toString("hex").padEnd(48, "0");
  const version = "00000000";

  if (!hyperCoreMintRecipient) {
    const dataLength = "00000000";
    return `0x${magicHex}${version}${dataLength}`;
  }

  const dataLength = "00000018";
  const address = hyperCoreMintRecipient.slice(2).toLowerCase();
  const dex = (hyperCoreDestinationDex >>> 0).toString(16).padStart(8, "0");

  return `0x${magicHex}${version}${dataLength}${address}${dex}`;
}

// -------- Generate Random Nonce --------
function generateNonce(): Hex {
  const randomBytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(randomBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}

// -------- Main Function --------
async function main() {
  // Validate private key and recipient
  if (!config.privateKey || config.privateKey === "0x") {
    throw new Error("Set PRIVATE_KEY");
  }
  if (!config.forwardRecipient) {
    throw new Error("Set FORWARD_RECIPIENT");
  }

  // Setup account and clients
  const account = privateKeyToAccount(config.privateKey);
  const publicClient = createPublicClient({
    chain: arbitrumSepolia,
    transport: http(),
  });
  const walletClient = createWalletClient({
    chain: arbitrumSepolia,
    transport: http(),
    account,
  });

  const amount = parseUnits(config.amount, 6);
  const maxFee = parseUnits(config.maxFee, 6);

  console.log("User:", account.address);
  console.log("Extension:", config.cctpExtension);
  console.log("USDC:", config.usdcToken);
  console.log("Total (USDC):", config.amount);
  console.log(
    "Dest Domain:",
    config.destinationDomain,
    "\nMint Recipient:",
    config.cctpForwarder,
  );
  console.log("Max Fee (USDC):", config.maxFee, "\nMin Finality:", 1000);

  // Check USDC balance
  const balance = await publicClient.readContract({
    address: config.usdcToken,
    abi: [
      {
        name: "balanceOf",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
      },
    ],
    functionName: "balanceOf",
    args: [account.address],
  });

  if (balance < amount) {
    throw new Error(
      `Insufficient USDC: have ${formatUnits(balance, 6)}, need ${config.amount}`,
    );
  }

  // Generate hook data
  const hookData = encodeForwardHookData(
    config.forwardRecipient,
    config.destinationDex,
  );
  console.log(
    "Forwarder hook enabled -> Final recipient:",
    config.forwardRecipient,
  );
  console.log("Hook Data:", hookData);

  // Convert addresses to bytes32
  const mintRecipientBytes32 =
    `0x${config.cctpForwarder.slice(2).padStart(64, "0")}` as Hex;
  const destinationCallerBytes32 =
    `0x${config.cctpForwarder.slice(2).padStart(64, "0")}` as Hex;
  console.log("Destination Caller (bytes32):", destinationCallerBytes32);

  // Generate nonce for EIP-3009
  const nonce = generateNonce();

  // Sign EIP-3009 ReceiveWithAuthorization
  const signature = await walletClient.signTypedData({
    domain: {
      name: "USD Coin",
      version: "2",
      chainId: arbitrumSepolia.id,
      verifyingContract: config.usdcToken,
    },
    types: {
      ReceiveWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "ReceiveWithAuthorization",
    message: {
      from: account.address,
      to: config.cctpExtension,
      value: amount,
      validAfter: BigInt(config.validAfter),
      validBefore: BigInt(config.validBefore),
      nonce,
    },
  });

  // Parse signature into v, r, s
  const r = signature.slice(0, 66) as Hex;
  const s = `0x${signature.slice(66, 130)}` as Hex;
  const v = parseInt(signature.slice(130, 132), 16);

  // Estimate gas
  const gasEstimate = await publicClient.estimateContractGas({
    address: config.cctpExtension,
    abi: CCTP_EXTENSION_ABI,
    functionName: "batchDepositForBurnWithAuth",
    args: [
      {
        amount,
        authValidAfter: BigInt(config.validAfter),
        authValidBefore: BigInt(config.validBefore),
        authNonce: nonce,
        v,
        r,
        s,
      },
      {
        amount,
        destinationDomain: config.destinationDomain,
        mintRecipient: mintRecipientBytes32,
        destinationCaller: destinationCallerBytes32,
        maxFee,
        minFinalityThreshold: 1000,
        hookData,
      },
    ],
    account,
  });

  console.log("Estimated gas:", gasEstimate.toString());

  // Execute batchDepositForBurnWithAuth
  const hash = await walletClient.writeContract({
    address: config.cctpExtension,
    abi: CCTP_EXTENSION_ABI,
    functionName: "batchDepositForBurnWithAuth",
    args: [
      {
        amount,
        authValidAfter: BigInt(config.validAfter),
        authValidBefore: BigInt(config.validBefore),
        authNonce: nonce,
        v,
        r,
        s,
      },
      {
        amount,
        destinationDomain: config.destinationDomain,
        mintRecipient: mintRecipientBytes32,
        destinationCaller: destinationCallerBytes32,
        maxFee,
        minFinalityThreshold: 1000,
        hookData,
      },
    ],
    gas: (gasEstimate * 120n) / 100n, // +20%
  });

  console.log("Tx hash:", hash);

  // Wait for transaction receipt
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  console.log("Status:", receipt.status === "success" ? "SUCCESS" : "FAILED");
  console.log(
    "Block:",
    receipt.blockNumber,
    "\nGas Used:",
    receipt.gasUsed.toString(),
  );
}

// Run
main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
```

Run the script:

```bash theme={null}
node --env-file=.env script.ts
```
