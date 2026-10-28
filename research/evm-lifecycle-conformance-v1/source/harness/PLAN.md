# Official lifecycle dependency conformance

This is a new 16-case packet, separate from the earlier 32-case packet. Selection
was fixed in `proposal.json` before opening the selected fixture bodies or running
an EVM. `prepare.py` copies ten original JSON members from the publisher-digest-
bound tests@v21.0.2 archive. No unsupported or failing case may be replaced.

The fixed cases cover root creation followed by deletion (with and without
prefunding), CREATE and CREATE2, nonce/storage clearing, reverted inner execution,
CALLCODE and DELEGATECALL execution context, CREATE2 collision, reinvocation,
two root constructor reverts, and two nonempty LOG cases. Exact file, fixture ID,
fixture hash and post index are in the proposal and final selection.

The signed adapter and worker remain byte-identical to the previous reviewed
packet. They reconstruct each original signed transaction, check its exact bytes
and sender, execute the unmodified Osaka fixture with full VM transaction
finalization and full Merkle state, then compare the official poststate root,
logs hash, receipt status, gas, transaction hash and receipt bloom. Expected
poststate is loaded into a separate state manager only to verify its published
root; it never supplies execution inputs.

All sixteen static shapes fit the existing adapter. Fourteen retain their
original 16,777,216 gas limit; the two log cases retain 210,000. The bounded child
gets 512 MiB V8 old-space, 1 MiB combined output and 10 seconds. The run gets
six minutes, retains every outcome, and makes no public request. Process
separation is not an operating-system sandbox or a hard total-RSS bound.

The source archive includes the full installed fixture dependency scope, exact
fixtures, selection/acquisition evidence and runner. Node executable/version and
every archived byte are bound before the first vector. Before/after verification
detects source drift. An exclusive start marker prevents accidental reruns.

This establishes dependency conformance for these fixed cases only. It does not
exercise our proof-backed sparse state manager or the 0.18 deletion finalizer,
and is not an ordinary-transaction coverage denominator or accuracy percentage.
