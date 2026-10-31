# Next public validation gap: existing delegated senders

Prioritize the two fixed USDT calls that were excluded from the original local-engine cohort because their senders had existing EIP-7702 delegations. The current engine implements that admission rule, but the later exact-header recheck obtained no historical proofs and executed neither call. This is an unresolved real-workload validation/availability gap, not a newly demonstrated current engine defect. The latest 16/16 public sample had only initially empty-code senders, so it does not cover these inputs.

Both calls use Ethereum chain **1**, the unsigned/unpriced five-million-gas profile, and no authorization list. The JSON below is the exact saved `projection.request`; the original parent header remains available in its source file. These are projected calls at parent-block end, not signed original-position replay.

**Case 002** — historical transaction `0x31cac6ebe975a4ca6666adf9b107fdb291af2cbeecbcf838397034e60daa03b8`.

Source: `reports/ordinary-local-coverage-v1/cases/002/request.json`, SHA-256 `66b4909067567609c99d0efb587eab287457d2322a1fabf0a16f2c7668c771a9`. Original parent: **26289507** (`0x1912563`), hash `0x49b97e395a7e594a00de1f8fc289717527962d2f3a0e6666966fa0d1398b2ce4`, state root `0xf67ebff446c1ef9ef541dc3db46baa3f4d6516a42d351a4f0d4f3d2049f0f15b`, timestamp `0x6ae199a3`.

```json
{
  "from": "0x08bb7baf5d5621dace37db11d81e4516c6697493",
  "to": "0xdac17f958d2ee523a2206206994597c13d831ec7",
  "data": "0xa9059cbb000000000000000000000000c24526704a5a88f2dac16b35af15bc37a0809c7b00000000000000000000000000000000000000000000000000000000e5004480",
  "value": "0",
  "gas": "5000000",
  "accessList": []
}
```

**Case 015** — historical transaction `0xcb13cd67f13e57c3cd944c4ede2d9368a7e48c3a6a4aae8179f730c3a2c40314`.

Source: `reports/ordinary-local-coverage-v1/cases/015/request.json`, SHA-256 `91fc4f5e9617921b062a01d16166a877425bd06d265a5a061f25ef34073f2287`. Original parent: **26289508** (`0x1912564`), hash `0x8bb96024a59944582f335fd5577abd5234fecf7c579ddaafff622f6d0b6033e4`, state root `0xf7b4f7066665c9a720fed69f02ad2b812bf3f5a98c77d3b179d1ab164bd0b74e`, timestamp `0x6ae199af`.

```json
{
  "from": "0x3068aaa8e7e07693cf3066dd15f174f7afc30c40",
  "to": "0xdac17f958d2ee523a2206206994597c13d831ec7",
  "data": "0xa9059cbb000000000000000000000000fbea74cd7e84295846bdd47bf248c004187182800000000000000000000000000000000000000000000000000000000005a995c0",
  "value": "0",
  "gas": "5000000",
  "accessList": []
}
```

Each original `cases/{002,015}/local.json` reports `unsupported / LOCAL_SENDER_CODE_UNSUPPORTED`; each saved input witness contains only that sender’s account and code (two input-evidence records), insufficient to reconstruct the full USDT execution. Their original `oracle.json`, `outcome.json` and `LOCAL_SEALED.json` remain beside the requests. Original evidence-manifest SHA-256: `d1c82c2237351ce871ab7a789d72aee264a5006b51c6f42c1207a9cf144ecd40`.

The later packet `reports/delegated-sender-development-v1/` retains both outcomes as `provider_unavailable / not_comparable`: its two first `eth_getProof` requests returned historical-state-unavailable errors, with zero verified proofs and zero EVM execution. Its pins are:

| Artifact within that packet | SHA-256 |
| --- | --- |
| `plan.json` | `01ac7e8b3de835dfccc7bf77da32aa46d8df9dabee1333103a5363c35902d72b` |
| `source-manifest.json` | `68a5ce101d4efd222a7ff1466b6fb6c4c2fc9d8b3f292f1cc0a164356d5a42c2` |
| `evidence-manifest.json` | `ffcca1c7ef3acee2440019b77d9b9c375d36e8eb9bce85f39824d8d55d4310ed` |
| `results.json` | `0b1b22e5e7ac6ac54147b3188d2c85aa9f7000f107d2ce2c1fa7a30ee3dfbdf7` |
| `cases/002/local.json` | `0b476a01147cdcde0278e193dd7464e2ed62c2f866262ecebd3ca9908468877a` |
| `cases/015/local.json` | `6610f2f507f3ddd3b5588f35d7050e4d129dbd16b989993f4b0d3ed807d5f8c5` |

Current admission is `engines/local-evm/execute.js:358–365`: read authenticated sender code, accept an exact existing delegation on an activated fork, otherwise return unsupported. Its SHA-256 is `5ecba77f45a4872f534ed476a5b3038e78118b41558390c88808b520f9739354`. The exact 23-byte `ef0100 || address` and trusted EIP-7702 activation checks are `engines/local-evm/sender-delegation.js:3–6`, SHA-256 `60c354715581a3fd343ae0de84d948f251e62cc830dba297ef04d0775eab70dd`.

Next comparison: retain both original call envelopes and use one newly selected, shared header for local execution and the execution reference. Prove each sender still has an exact delegation there; preserve missing code/proofs, a cleared or unsupported delegation, insufficient balance, execution failures and unavailable comparisons without replacing the wallet, reducing the amount, inserting state or selecting another header. Seal the local result before requesting the reference, then compare status, exact return bytes, charged gas, committed logs and observed net state changes. The standard provider API cannot supply that reference unchanged: `engines/standard-evm/unsigned-call.js:247` rejects all coded senders (source SHA-256 `d481d3f77c80e7d040638228f0ced48227efc270dfbd3ab8a00c5551a93b0857`). Use a separately bound raw trace/diff reference path that admits the declared delegated sender; do not bypass or silently relax the standard API filter. Provider execution is a separate reference, not proof of independent infrastructure or consensus.

A new-header result evaluates these fixed calls against new authenticated state. It cannot repair the historical packet, prove the old outcome, or turn the original 14/16 cohort into 16/16. Historical proof availability, old sender balances and old delegation persistence remain separate facts. Keep this as a selected development comparison with both positions retained, rather than another success-selected accuracy claim.

Prepared by read-only source/artifact inspection. No RPC, VM, benchmark or preparation was run, and no source or capture was changed.
