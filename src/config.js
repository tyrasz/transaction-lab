export const CHAIN_ID = 999;
export const VERSION = '0.2.0';
export const DEFAULT_RPC_URL = 'https://hyperliquid.drpc.org';
export const POOL = '0x00a89d7a5a02160f20150ebea7a2b5e4879a1a8b';
export const USDC = '0xb88339cb7199b77e23db6e890353e22632ba630f';
export const HUSDC = '0x744e4f26ee30213989216e1632d9be3547c4885b';
export const METADATA = {
  [USDC]: { address: USDC, decimals: 6, symbol: 'USDC', name: 'USDC' },
  [HUSDC]: { address: HUSDC, decimals: 6, symbol: 'hHyperEvmUSDC', name: 'HyperLend HyperEVM USDC' },
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
];

export const CAPABILITIES = {
  simulation: true, historicalTrace: true, chainIds: [CHAIN_ID],
  assetBasis: 'Successful ERC-20 Transfer events; not portfolio balance deltas',
  balanceMeasurement: {supported:true,method:'prestate_diff_balanceOf',scope:'Current-state Hyperlend USDC supply; sender and beneficiary USDC/hUSDC balances only'},
  securityAssessment: false, transactionBroadcast: false,
  permissionObservations: {supported:true,scope:'ERC20 approve calls and Approval events for configured USDC/hUSDC',allowanceStateVerified:false},
  supportedProtocols: ['Hyperlend USDC supply'],
  limitations: [
    'Unknown protocols have partial coverage even when token events can be decoded.',
    'HyperCore actions are not executed by the EVM tracing backend.',
    'Receipt-token events can include accrued interest already reflected in token balances.',
    'Token metadata is verified only for configured assets. Pricing is not provided.',
    'Trace execution does not validate a real transaction signature or guarantee future inclusion.',
  ],
};
