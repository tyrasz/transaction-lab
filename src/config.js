export const CHAIN_ID = 999;
export const VERSION = '0.22.0';
export const DEFAULT_RPC_URL = 'https://hyperliquid.drpc.org';
export const POOL = '0x00a89d7a5a02160f20150ebea7a2b5e4879a1a8b';
export const USDC = '0xb88339cb7199b77e23db6e890353e22632ba630f';
export const HUSDC = '0x744e4f26ee30213989216e1632d9be3547c4885b';
export const VUSDC = '0xd612513cb3b2c52abcd6d4b338374c09ada4657d';
export const METADATA = {
  [USDC]: { address: USDC, decimals: 6, symbol: 'USDC', name: 'USDC' },
  [HUSDC]: { address: HUSDC, decimals: 6, symbol: 'hHyperEvmUSDC', name: 'HyperLend HyperEVM USDC' },
  [VUSDC]: { address: VUSDC, decimals: 6, symbol: 'variableDebtHyperEvmUSDC', name: 'HyperLend HyperEVM Variable Debt USDC', role: 'liability', transferable: false },
};
export const EXAMPLES = [
  {
    id: 'hyperlend-usdc-supply', label: 'Hyperlend · supply 15.066115 USDC',
    transactionHash: '0x25e076fc67489775131aafd134a1c6de8f974dea434000ba7568cf400df03cd2',
    request: {
      chainId: CHAIN_ID, from: '0x9a1dbc6a6e7e59f6beb23db0d00b603fc90e94d0', to: POOL, value: '0',
      data: '0x617ba037000000000000000000000000b88339cb7199b77e23db6e890353e22632ba630f0000000000000000000000000000000000000000000000000000000000e5e4030000000000000000000000009a1dbc6a6e7e59f6beb23db0d00b603fc90e94d00000000000000000000000000000000000000000000000000000000000000000',
    },
  },
  {
    id: 'hypercore-perps-to-spot', label: 'HyperCore · Perps → Spot (partial EVM coverage)',
    transactionHash: '0xe4b9861a0fcda1cfda2414178b80e8646b2d9d24e6f01222cc8ad81b2ba65b36',
    request: {
      chainId: CHAIN_ID, from: '0x8a2e870e8283594c1bed3f50b65bf83a086a8c08',
      to: '0x73b8523109e2d570978c008916bcb1d7f752a0fe', value: '0',
      data: '0xdfccd8e50000000000000000000000000000000000000000000000000000000001aeef490000000000000000000000000000000000000000000000000000000000000000',
    },
  },
  {
    id:'usdc-max-approval',label:'USDC · unlimited approval to Hyperlend',
    description:'Preview an unsigned maximum USDC allowance request. No allowance is changed on-chain.',
    request:{chainId:CHAIN_ID,from:'0x9a1dbc6a6e7e59f6beb23db0d00b603fc90e94d0',to:USDC,value:'0',data:`0x095ea7b3${POOL.slice(2).padStart(64,'0')}${'f'.repeat(64)}`},
  },
  {
    id:'usdc-revoke-approval',label:'USDC · revoke Hyperlend approval',
    description:'Preview an unsigned zero-allowance request. No allowance is changed on-chain.',
    request:{chainId:CHAIN_ID,from:'0x9a1dbc6a6e7e59f6beb23db0d00b603fc90e94d0',to:USDC,value:'0',data:`0x095ea7b3${POOL.slice(2).padStart(64,'0')}${'0'.repeat(64)}`},
  },
  {"id":"hyperlend-usdc-withdraw","label":"Hyperlend · withdraw USDC","description":"Public historical transaction input; simulation uses the selected block state.","transactionHash":"0x94b5c4672e28cbeeab547c06f60e30afa02ac58b0cad4c7568a6ca9d8ac29ae7","request":{"chainId":999,"from":"0x9a1dbc6a6e7e59f6beb23db0d00b603fc90e94d0","to":"0x00a89d7a5a02160f20150ebea7a2b5e4879a1a8b","value":"0","data":"0x69328dec000000000000000000000000b88339cb7199b77e23db6e890353e22632ba630f000000000000000000000000000000000000000000000000000000001e08e8420000000000000000000000009a1dbc6a6e7e59f6beb23db0d00b603fc90e94d0"}},
  {"id":"hyperlend-usdc-borrow","label":"Hyperlend · borrow USDC","description":"Public historical transaction input; simulation uses the selected block state.","transactionHash":"0x0b8ad0d98c96224bdd9e1ad6623292164278340b123feb45eee9c556ec259afb","request":{"chainId":999,"from":"0x9a1dbc6a6e7e59f6beb23db0d00b603fc90e94d0","to":"0x00a89d7a5a02160f20150ebea7a2b5e4879a1a8b","value":"0","data":"0xa415bcad000000000000000000000000b88339cb7199b77e23db6e890353e22632ba630f0000000000000000000000000000000000000000000000000000000031cc53ea000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000000000000000000000000009a1dbc6a6e7e59f6beb23db0d00b603fc90e94d0"}},
  {"id":"hyperlend-usdc-repay","label":"Hyperlend · repay USDC","description":"Replay the original request or simulate it at current state; actual payment is capped by outstanding debt.","transactionHash":"0x682c1d2f131715b8d4b04c71cd8e75ef56a107f0bbd992379a44bf426f22102f","request":{"chainId":999,"from":"0x9a1dbc6a6e7e59f6beb23db0d00b603fc90e94d0","to":"0x00a89d7a5a02160f20150ebea7a2b5e4879a1a8b","value":"0","data":"0x573ade81000000000000000000000000b88339cb7199b77e23db6e890353e22632ba630f000000000000000000000000000000000000000000000000000000000be60e2800000000000000000000000000000000000000000000000000000000000000020000000000000000000000009a1dbc6a6e7e59f6beb23db0d00b603fc90e94d0"}},
  {"id":"husdc-historical-permit","label":"hUSDC · historical relayed permit","description":"Public historical permit input. Inspect its original successful execution; a current simulation may reject an expired or already-used signature.","transactionHash":"0x8793c27ee5aa623de4e2131296ad54d4e1276dd3e5d28b7b493f4d2080f4556e","request":{"chainId":999,"from":"0xe9755d57f1b933b152b5b1ef43af64a657b58ddd","to":"0x744e4f26ee30213989216e1632d9be3547c4885b","value":"0","data":"0xd505accf0000000000000000000000003e248867a2a2ddd1d901f7d595c4d02c6519b32a0000000000000000000000008a0f75a499c17632e5ee6cc4156099292f3e68f9ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff000000000000000000000000000000000000000000000000000000006ac3c161000000000000000000000000000000000000000000000000000000000000001c6ebccf5c857d6c6364f9f62a42ade3c60345dbc45e462832635866032acd99f15049b760d260964dd6a9921f729f4f6f0fd084cc03c3d3668f60e15bff3b1da3"}},
  {"id":"usdc-historical-router-permit","label":"USDC · historical router permit","description":"Public historical router call containing a permit and a separate approval. Only configured token permissions are measured; other router effects have partial coverage.","transactionHash":"0x9dba139e63627a8f3693b9a63ff556f89a5358c2603738f6d98172b7ddd3074d","request":{"chainId":999,"from":"0x0c71073344e27e33cb57fcb587fc412d689dfd1d","to":"0x693f12e9e6b35b34458793546065e8b08e0299d6","value":"0","data":"0x48519be800000000000000000000000053195a1c4e664ac09eb72892516f8f85ec80000000000000000000000000000000000000000000000000000000000000017d7840000000000000000000000000000000000000000000001c0df636224734347c2e0000000000000000000000000000000000000000000000000000000000000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff000000000000000000000000000000000000000000000000000000006a079d9a000000000000000000000000000000000000000000000000000000000000001bc7b60c1bd267ac7348356cdefb7f3478399bfefe8e52c4a1226b4985d5e5c00a3616b0b1956e4b2ce3026d7048b93d73fbdf55c568b3eefdfc104dd44ae93bca"}},
];

EXAMPLES.push({
  id: 'usdc-historical-transfer-from', label: 'USDC · historical allowance spending',
  description: 'A public account spends another owner’s existing USDC allowance. Inspect both accounts, requested transfer amount, emitted events and the available final allowance measurement. Original signing intent is not assessed.',
  transactionHash: '0xe2f9761a3fac3ba83ee15fc5e6f12b55d15cd804b321a2cffd9d2c16d6c38dfe',
  request: { chainId: CHAIN_ID, from: '0x2908da1b63c4f7ce001bf5d875d179930a79eed4', to: USDC, value: '0', data: '0x23b872dd000000000000000000000000fc1bdd1ff58200761d56ccbce73f6f42ebe563790000000000000000000000002908da1b63c4f7ce001bf5d875d179930a79eed40000000000000000000000000000000000000000000000000000000000137c8b' },
});

export const CAPABILITIES = {
  simulation: true, historicalTrace: true, chainIds: [CHAIN_ID],
  assetBasis: 'Successful ERC-20 Transfer events; not portfolio balance deltas',
  accountEffects: {supported:true,scope:'All bounded observed transfer participants and configured permission roles; separately measured balances and allowances are referenced without inferring missing state',basis:'observed_accounts_with_separate_state_measurements',additionalBalanceQueries:'historical_and_validated_current'},
  affectedBalanceMeasurement: {supported:true,modes:['historical_trace','simulation'],bases:{historical:'historical_transaction_position_balanceOf',current:'current_pinned_state_validated_query'},maxCandidatePairs:8,scope:'Observed configured USDC/hUSDC/variable-debt Transfer participants and verified transferFrom owners/recipients; unknown, silent and native changes remain outside scope',currentStateStatus:'validated_unpriced_synthetic_basefee_profile'},
  balanceMeasurement: {supported:true,method:'current_pinned_state_validated_query',scope:'Current-state Hyperlend USDC supply, withdrawal, variable-rate borrow and repay; involved user USDC, receipt-token and debt balances; configured query paths and mutation behavior validated before and after the call'},
  currentCallEnvironment: {gasPrice:'omitted',baseFee:'synthetic_zero',signedTransactionValidation:false,scope:'Unsigned zero-native-value contract calls from code-free senders; token queries use isolated complete poststate overrides, with header, nonce and mutation checks'},
  historicalBalanceMeasurement: {supported:true,method:'debug_traceCallMany',basis:'historical_transaction_position_balanceOf',scope:'Reconciled Hyperlend USDC operations plus bounded observed configured-token participants; original block and transaction position, separate token reads and isolated original-call validation'},
  securityAssessment: false, transactionBroadcast: false,
  permissionObservations: {supported:true,scope:'ERC20 approve, implementation-verified ERC-2612 permit and ERC20 transferFrom calls, and Approval events for configured USDC/hUSDC',allowanceStateVerified:true,signatureIndependentlyVerified:false,scopeLimit:'Only verified USDC/hUSDC permission pairs observed in a successful execution; owner, transaction submitter, immediate caller and recipient remain distinct. Transfer amounts are not requested allowances.'},
  historicalAllowanceMeasurement: {supported:true,method:'debug_traceCallMany',basis:'historical_transaction_position_allowance',scope:'Configured USDC/hUSDC permission pairs at the original transaction position; unsupported state changes and inconsistent provider indexes are unavailable'},
  supportedProtocols: ['Hyperlend USDC supply', 'Hyperlend USDC withdrawal', 'Hyperlend USDC variable-rate borrowing', 'Hyperlend USDC variable-rate repayment'],
  limitations: [
    'Unknown protocols have partial coverage even when token events can be decoded.',
    'HyperCore actions are not executed by the EVM tracing backend.',
    'Receipt-token events can include accrued interest already reflected in token balances.',
    'Token metadata is verified only for configured assets. Pricing is not provided.',
    'Trace execution does not validate a real transaction signature or guarantee future inclusion.',
  ],
};
