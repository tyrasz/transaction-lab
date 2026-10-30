# Version 0.35 installation checks

`check-installed.mjs` is a GET-only checker. It does not start a server, execute
a simulation, request public RPC data, sign or broadcast. It has not been run
as part of its implementation.

Before invoking it, retain a new expectation JSON file with these fields:

```json
{
  "version": "0.35.0",
  "roots": {
    "candidate": "/absolute/development/worktree",
    "installed": "/absolute/main/worktree"
  },
  "implementation": "replace this string with the complete fresh local-loader implementation object",
  "uiBaseline": {
    "app.js": {"path": "/absolute/saved/baseline/app.js", "sha256": "exact SHA256"},
    "index.html": {"path": "/absolute/saved/baseline/index.html", "sha256": "exact SHA256"},
    "style.css": {"path": "/absolute/saved/baseline/style.css", "sha256": "exact SHA256"}
  }
}
```

The implementation must be captured after the final version/source changes. It
includes the full inventory and Node runtime identity, and must disclose
`local-evm-runtime-fixes-v2`, both rule identifiers and the three pinned corrected
file hashes. Old 0.34 identities cannot be reused. The UI baselines are explicit
saved bytes, not downloaded content or a hash calculated from the candidate
afterward.

Run `node check-installed.mjs candidate EXPECTATIONS_JSON` for port 5175 and
`node check-installed.mjs installed EXPECTATIONS_JSON` for port 5174. The selected
root is explicit; the script loads its API in-process to check complete identity
before and after five bounded localhost GETs: health, config and all three UI
files. It also verifies version, read-only status, optional-engine availability,
the exact local capabilities/examples and the new creation-storage capability.

Each mode reserves an exclusive `*-http.STARTED.json` and writes an exclusive
`*-http.json` report in this directory. Failures retain their observations as
unavailable. Existing reports or start records are never overwritten or retried.
The expectation bytes and their hash are bound to the report. Earlier release
packets remain untouched.

These checks bind the selected checkout's complete local identity and the
running service's health/config/static responses. The HTTP API does not expose
its full implementation identity on a GET, so service process ownership and
launch directory still need to be established by the release operator. No
transaction result or general accuracy claim follows from an installation check.
