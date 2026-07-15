# trace-claude-code

Claude Code 2.1.204 tracing and traffic-capture toolkit for macOS. It combines
same-runtime Bun preload hooks, precise JavaScript `Proxy` wrappers, correlated
network JSONL tracing, optional Frida native hooks, and mitmproxy HAR capture.

Use it only on software and traffic you are authorized to inspect. Trace files
can contain prompts, source code, tool results, identifiers, and credentials.
They are ignored by Git and should be handled as sensitive data.

## What is included

| Layer | Entry point | Coverage |
|---|---|---|
| Bun preload | `bin/claude-hooked` | `fetch`, Bun spawn hooks, precise module/object method proxies |
| Network JSONL | `preload/network_trace.js` | fetch, HTTP/1, HTTP/2, WebSocket, Bun/net/TLS connections |
| MITM capture | `bin/run-mitmproxy` + `bin/claude-mitm` | decrypted HTTP(S) flows and HAR output |
| Native tracing | `bin/claude-frida` | `dlopen`, `napi_run_script`, `connect`, version-specific Bun/JSC evaluator |
| Viewer | `bin/show-network-trace` | correlates requests, response headers, response bodies, errors, and optional connection records |
| LLM viewer | `bin/show-llm-trace` | filters `/v1/messages`, pretty-prints `system` / `messages` / `tools`, and parses model responses |

The preload path is the recommended starting point. It runs in Claude Code's
own Bun `globalThis`, so JavaScript objects can be wrapped without guessing
native layouts. Frida is useful for native boundaries and version-specific
internal evaluator work.

## Analysis documents and probes

For the detailed telemetry and attribution analysis used during reverse
engineering, see:

- `docs/telemetry-three-chains.md`
- `docs/cch-location-method.md`

The main attribution-related probes checked into this repository are:

- `frida/cch_probe.js` — confirms the first outbound native buffer containing
  `cch=`
- `frida/cch_mutation_probe.js` — locates the native body-preparation rewrite
  point and the `XXH64` helper path
- `preload/cch_hash_probe.js` — JS-side negative control for `createHash`
  inputs involving `cch=00000`

## Quick start: JSONL network trace

```sh
git clone https://github.com/Dispa1r/trace-claude-code.git
cd trace-claude-code
chmod +x bin/* scripts/*

CLAUDE_NETWORK_TRACE_DIR="$PWD/traces" \
  bin/claude-hooked -p 'only reply OK'

bin/show-network-trace --directory "$PWD/traces" --headers --bodies
```

Without `CLAUDE_NETWORK_TRACE_DIR`, output is written to:

```text
${XDG_STATE_HOME}/trace-claude-code
~/.local/state/trace-claude-code
```

Network request and response bodies are capped at 2 MiB by default.
Authentication, API key, cookie, token, password, and secret fields are
redacted by default, but prompts, model outputs, and project data are
intentionally captured. Useful controls:

```sh
export CLAUDE_NETWORK_TRACE=0                    # disable network tracing
export CLAUDE_NETWORK_TRACE_MAX_BODY=4194304     # body cap in bytes
export CLAUDE_NETWORK_TRACE_STDERR=1             # one-line request summaries
export CLAUDE_NETWORK_TRACE_SOCKET_WRITES=1      # raw socket writes; very noisy
export CLAUDE_NETWORK_TRACE_CAPTURE_RESPONSE_BODIES=0  # disable response body capture
export CLAUDE_NETWORK_TRACE_SECRETS=1            # disable redaction; dangerous
```

## Quick start: LLM trace

Once a network JSONL trace exists, extract only model interactions:

```sh
bin/show-llm-trace --directory "$PWD/traces"
```

Useful options:

```sh
bin/show-llm-trace --directory "$PWD/traces" --headers
bin/show-llm-trace --directory "$PWD/traces" --raw-response
```

Typical workflow:

```sh
export CLAUDE_NETWORK_TRACE_DIR="$PWD/traces"
export CLAUDE_NETWORK_TRACE_MAX_BODY=8388608

bin/claude-hooked
bin/show-llm-trace --directory "$PWD/traces"
```

What you get from `show-llm-trace`:

- the exact `/v1/messages` request URL and method
- request `model`, `system`, `messages`, and `tools`
- response status and headers
- parsed streaming SSE responses, including reconstructed assistant text, tool-use payloads, usage, and stop reason

The raw network JSONL remains the ground-truth source. `show-llm-trace` is only
a filtered viewer on top of it, so when you need byte-level details you can
still inspect the same capture with:

```sh
bin/show-network-trace --directory "$PWD/traces" --headers --bodies
```

## Precise JavaScript method tracing

Edit `preload/preload_user_logic.js` or override targets for one run:

```sh
CLAUDE_HOOK_TRACE_TARGETS='[
  {"object":"globalThis","path":"fetch","label":"globalThis.fetch"},
  {"module":"node:fs","path":"readFile","label":"fs.readFile"},
  {"object":"globalThis","path":"Response.prototype.json"}
]' bin/claude-hooked -p 'only reply OK'
```

Each call emits a `[method-trace]` JSON record on stderr. `callId` links
`enter` with `return`, `throw`, `resolve`, or `reject`. The wrapper preserves the
original receiver and return value and does not consume Request/Response bodies.

```sh
export CLAUDE_HOOK_TRACE_BODY=1   # include prompt/body/content fields
export CLAUDE_HOOK_TRACE_STACK=1  # include stacks
export CLAUDE_HOOK_TRACE_THIS=1   # include receiver snapshots
```

## Datadog datalog gate

Claude Code's Datadog sink is gated by the `tengu_log_datadog_events` feature
flag, a `firstParty` provider classification, and an official Claude model
name. When the first two conditions already pass, the preload can replace the
parsed `--model` argument before Claude Code starts:

```sh
CLAUDE_HOOK_ENABLE_DATALOG=1 \
CLAUDE_NETWORK_TRACE_DIR="$PWD/traces" \
  bin/claude-hooked -p 'only reply OK'
```

The default hook model is `claude-haiku-4-5`. Override it with
`CLAUDE_HOOK_DATALOG_MODEL`. This changes Claude Code's actual model selection;
when a custom `ANTHROPIC_BASE_URL` is configured, that provider receives the
official model identifier. The hook does not redirect normal model traffic.
Datadog itself uses Claude Code's built-in official endpoint,
`https://http-intake.logs.us5.datadoghq.com/api/v2/logs`.

## MITM HAR capture

Install mitmproxy with the required package-download proxy environment:

```sh
export https_proxy=http://127.0.0.1:7890 \
       http_proxy=http://127.0.0.1:7890 \
       all_proxy=socks5://127.0.0.1:7890
python3 -m pip install mitmproxy
```

Start the proxy in terminal 1:

```sh
MITM_PORT=8080 bin/run-mitmproxy
```

Run Claude through it in terminal 2:

```sh
MITM_PORT=8080 bin/claude-mitm -p 'only reply OK'
```

`bin/claude-mitm` sets upper- and lower-case proxy variables plus
`NODE_EXTRA_CA_CERTS=~/.mitmproxy/mitmproxy-ca-cert.pem`. Stop mitmproxy cleanly
so its `hardump` option writes the HAR file. Set `MITM_HAR_FILE` to choose an
exact output path.

## Frida native hooks on macOS

Frida attach/spawn requires macOS developer debugging permission and a target
signed with `get-task-allow`. Prepare a copy; the installed Claude binary is not
modified:

```sh
scripts/prepare-debuggable-claude-macos
```

Create an environment for the Python bindings. Export the download proxy before
installing dependencies:

```sh
export https_proxy=http://127.0.0.1:7890 \
       http_proxy=http://127.0.0.1:7890 \
       all_proxy=socks5://127.0.0.1:7890
python3 -m venv .venv
.venv/bin/pip install -r requirements-frida.txt
```

Then run:

```sh
FRIDA_PYTHON="$PWD/.venv/bin/python" bin/claude-frida --version
```

On hardened macOS setups the Python interpreter used by Frida may also need the
debugger entitlement from `entitlements/frida-debugger.entitlements`. Sign a
copy of the interpreter rather than modifying a system or Xcode installation.

Native hooks live in `frida/agent.js`; callbacks belong in
`frida/user_logic.js`. The internal evaluator RVA `0x02AB0C88` is specific to
Claude Code 2.1.204. Disable it after upgrading until the new function has been
identified:

```sh
FRIDA_PYTHON="$PWD/.venv/bin/python" \
  "$PWD/frida/launcher.py" --spawn --no-internal-evaluate -- --version
```

## Capture safety

- JSONL, HAR, mitmproxy flow files, signed binaries, and local runtime folders
  are excluded by `.gitignore`.
- Header and common JSON secret fields are redacted by default.
- Body capture can still include prompts, repository contents, device/session
  identifiers, and tool results.
- Review every capture before sharing it. Do not rely on automatic redaction as
  the only privacy control.

## Version scope

The Bun preload and network wrappers are mostly version-tolerant. Native
offsets and some reachable JavaScript object paths are not. The checked-in
offset map currently targets Claude Code 2.1.204.
