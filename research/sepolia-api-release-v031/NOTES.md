# Sepolia API and browser release checks

Candidate version 0.31.0. These are development/regression checks, not a representative transaction sample or a universal accuracy result.

The full local engine suite passed 922/922 tests in 46.763 seconds. The full application suite passed 717/717 tests in 60.166 seconds with temporary localhost listeners allowed. The suites ran against stable production sources; their raw logs are retained. Twelve new delegated-sender groups cover 26 original scenarios and four disposable query counterparts, with signed full-VM and independently applied MPT roots. Those references share EthereumJS; the separate Geth packet supplies independent-client evidence for six fixed cases.

The 41 interface controls include actual offline API/worker responses for Sepolia native transfers, explicit execution and blob fees, contract getter identity, and changed-header withholding. Review found and fixed two integration defects: the configured example uses `request`, not `input`, and contract query rows must retain the selected Sepolia chain and exact query identity. Both now have regression controls.

Two earlier UI test failures are retained separately. A blob test supplied a fee cap below the fixture header's real blob price; the API correctly withheld it. The corrected fixture uses the exact header-derived cap and sufficient synthetic balance. A missing-identity test expected literal false instead of the UI's falsy undefined; the assertion now checks withholding. Neither failure was converted into a product success by relaxing execution or display admission.

Root inspected the actual browser at http://127.0.0.1:5175/: selecting Sepolia displayed chain 11155111, disabled the provider and ordered-call controls, loaded the declared public sender and burn recipient, value 1000000000000000, latest state, gas 21000, and two native balance queries. The page explicitly labels test ETH and excludes fees in the default profile. No simulation was submitted from that browser during this check. The separate live API packet records the actual network-backed request and response.

`implementation.json` retains the exact local-loader source/runtime inventory for candidate version 0.31.0, with source hash 5527057b0dc45bf210cdfa8ca5be415b27321f9122dd92fb0ac811a32f410bef. Source bytes are tracked by the release commit; dependencies remain pinned by their lockfile and inventory. No deployment outside localhost, wallet connection, private-key use or transaction broadcast occurs.

The single live API attempt succeeded at Sepolia block 12,020,571 (hash 0x5645815f244ffdb6b25a2c2279b4bb1d68c5d852e00448767b174c3be57593a2): exact −/+1000000000000000 wei, 21,000 gas, no fees, five public proof/header reads, normal child closure and no pending reads. Root independently reran the artifact verifier with the sealed manifest and plan pins; it performed no VM or network execution. See `live-artifact-verification.json` and the sibling live packet.

The separate six-case delegated-sender Geth packet matched all nine comparison fields. Its artifact review reconstructs 24 MPT roots and reproduces those comparisons; the retained review source states its shared-parser and proof-walk limitations. The earlier internal live attempts and unavailable provider outcomes remain unchanged in their original packets.

Promotion is recorded below when complete.
