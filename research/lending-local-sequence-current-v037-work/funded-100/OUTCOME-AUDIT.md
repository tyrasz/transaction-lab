# Independent saved-outcome audit

The first audit passed, using only saved bytes at block **26,311,894**, hash `0x2ffbb9cac864cffa0b2236ef9ef1d571f755377c877f8523a97d447fff9e20d0`. Both sequences start independently at that block. No target, RPC, API or VM ran during this audit; the Python checker imports only its standard library and writes its report outside the capture.

The [checker](audit-outcomes.py) verifies the external intent/plan/manifest pins, exact capture membership, all 4,665 manifest entries (92,955,486 regular-file bytes rehashed), and ledger rows against the manifest. It verifies all 537 target native wires and performs 607 execution/input/getter evidence-to-wire joins, including repeated references. The three selection wires are included in the file hashes; their semantic validation remains with the saved adjudicator.

The [first report](outcome-audit-first.json) independently confirms **18/18 original status/return/gas channels** and **117/117 query channels**, with zero mismatches or unavailable channels. All 39 query pairs were decoded from local raw return bytes and provider saved callTracer bytes, with exact request/subject/header and trace/diff context joins, projected-value arithmetic, and inter-step continuity. The archived adjudicator separately reports **30/30 original channels** and **117/117 query channels**; its additional original channels are ordered logs and observed cumulative net state. This audit does not independently re-prove their semantics, proof cryptography, overlay composition or process-control logic.

## Observed amounts

Each cell below is a raw integer. USDC has the declared six-decimal display scale. Share amounts are kept separate from underlying assets.

| Measurement | Before approval | After approval | After deposit | After withdrawal |
| --- | ---: | ---: | ---: | ---: |
| Sender USDC, each independent sequence | 112952478562 | 112952478562 | 112852478562 | 112902478562 |
| Aave sender aEthUSDC | 0 | 0 | 99999999 | 49999998 |
| Aave allowance to Pool | 0 | 100000000 | 0 | 0 |
| Kiln sender wrapper shares | 0 | 0 | 94368282 | 47184140 |
| Kiln allowance to wrapper | 0 | 100000000 | 0 | 0 |

Thus both sequences observe a 100-USDC outflow on deposit and a 50-USDC inflow on withdrawal. Aave reserve USDC and Morpho Blue custody USDC respectively show the opposite asset movements and finish 50,000,000 raw units higher. Kiln wrapper custody remains 20,083,625 raw USDC and inner-vault custody remains 6,011. These selected observations are not a complete economic accounting.

The Aave receipt-token increase is 99,999,999 raw units and its withdrawal decrease is 50,000,001. Those differences are retained; no exact 1:1 receipt/asset conversion or unverified cause is substituted. Throughout all snapshots, Aave `totalCollateralBase`, `totalDebtBase`, `availableBorrowsBase`, `currentLiquidationThreshold` and `ltv` return zero, while `healthFactor` returns `2^256-1`. Both clients return the same raw bytes. The receipt balance establishes an observed receipt-token balance; the account-data zeros do not independently establish its collateral eligibility/configuration or explain the protocol's treatment. No reserve/user collateral-configuration query was declared.

Kiln's wrapper-owned inner-vault shares rise by 87,239,519,638,861,820,964 on deposit and fall by 43,619,759,819,430,910,483 on withdrawal. The declared Blue position is owned by the **inner vault**, not this sender: its supply shares change by +91,060,719,533,206 then −45,530,359,766,604; borrow shares and collateral remain zero. These are distinct share namespaces, not interchangeable USDC amounts.

## Charged gas and classification

| Sequence | Approve | Supply/deposit | Withdraw |
| --- | ---: | ---: | ---: |
| Aave, both paths | 55,558 | 178,305 | 160,035 |
| Kiln, both paths | 55,558 | 1,430,190 | 1,678,187 |

All six executed originals report success. The fixed denominator remains six original positions and 39 query pairs. No missing measurement was converted to zero, and no earlier failed case was replaced. There was no first-audit failure; the first stderr file is retained and empty.

This is deliberately selected successful-path evidence. Local getters use 1M gas after all originals; provider getters use 300k between originals. Both execution paths share public-provider infrastructure. The result is neither representative accuracy nor independent consensus, signed replay, full poststate-root coverage, current funding assurance, or HTTP/frontend evidence. Approval necessity and exclusive attribution of withdrawn shares to this deposit are not established.

## Pins

| Artifact | SHA-256 |
| --- | --- |
| External intent | `764b3bc67d9f27693513294bc7721345685d9fc067f9b915c63020013917b7c9` |
| Final plan | `67fee713c49a295074152edf4aab9fd7150e3d6edd40b452f2f64c377e1e9985` |
| Capture manifest | `02802ff6b0fae693fc405ef39fbaa366f3f1af658b1aa6c3d19032671f3eda2a` |
| Audit checker | `e860d6c54ba219c24dff14bd01c4872b8da02602ba8d267e12c4365bb2bfb049` |
| First audit report | `4d755eeaee8052428744d99738e2533fbaf67ac4669ae34fe746b1d21aa3eaaa` |
| Archived adjudicator output | `c267d54ce748beb25c1be1e47bab262c217383a798c4d31d963e48f416d6e1e5` |
