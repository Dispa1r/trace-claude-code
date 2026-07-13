# Claude Code hook probes

This directory contains two complementary probes for the arm64 Claude Code
2.1.204 standalone executable.

## Native JSC trace

The original Developer ID signature does not allow debugger attachment on this
machine. `prepare-hookable-copy.sh` creates an APFS clone-copy and ad-hoc signs
that copy with JIT, library-loading, and task-debugging entitlements. It never
modifies the installed binary.

The runner launches that copy under the system LLDB. A Python breakpoint script
logs entry registers, matches the function's statically verified return sites,
and logs the encoded `JSValue` in `x0` on return.

```sh
./run-native-trace.sh --version
```

Trace records are written as JSONL to stderr. Set `CC_HOOK_LOG` to keep them in
a file while leaving Claude's terminal UI on stdout:

```sh
CC_HOOK_LOG=/tmp/claude-jsc.jsonl ./run-native-trace.sh
```

The IDA-confirmed boundaries are:

| Function | IDA address | Image offset |
| --- | ---: | ---: |
| `JSC::evaluate` | `0x102ab0c88` | `0x02ab0c88` |
| `Interpreter::executeProgram` | `0x102820eec` | `0x02820eec` |
| `JSC::call(..., Exception&)` | `0x102a850cc` | `0x02a850cc` |
| `Interpreter::executeCall` | `0x102822ce0` | `0x02822ce0` |
| `Interpreter::executeCallImpl` | `0x102822914` | `0x02822914` |

`native_lldb.py` enables `evaluate` and `executeCall` by default. Override that
with `CC_HOOKS=evaluate`, `CC_HOOKS=call`, `CC_HOOKS=executeCall`, or
`CC_HOOKS=executeCallImpl`. Results are raw encoded `JSValue` records with safe
decoding for empty, null, undefined, booleans, int32 values, and cell
pointers. For `CallData::JS`, the first sample of each `FunctionExecutable`
also includes a compact memory snapshot and heuristic `SourceCode` candidates,
so we can recover source ranges without re-entering JSC. A cell pointer is not
converted to a JavaScript string from the breakpoint callback because
re-entering JSC at arbitrary points can corrupt VM state.

`native-trace.js` is the equivalent Frida proof. Frida 17.15.4 hit the same
addresses successfully once, but its helper crashes repeatedly on this macOS
26.4.1 machine, so it is not used by the runner.

For large JSONL traces, summarize the hottest native callbacks and the first
sampled JS executables with:

```sh
python3 ./summarize-trace.py /tmp/claude-jsc.jsonl
```

If `output/claude/claude.js` is present, the summarizer automatically maps the
main anonymous Claude bundle wrapper back to its source offsets and prints a
short excerpt. Override that path or tune the preview size with:

```sh
python3 ./summarize-trace.py /tmp/claude-jsc.jsonl --bundle /path/to/claude.js --excerpt-context 64 --excerpt-limit 240
```

## Native network trace

`native_lldb.py` also supports a best-effort native network trace. It installs
symbol breakpoints for `connect`, `send`, `write`, `writev`, `sendmsg`, and
tries `SSL_write` when symbol names are available. This reliably captures
destination metadata and plaintext payloads for many HTTP/HTTP proxy requests.
For HTTPS, plaintext request bodies are only visible if an `SSL_write` hook is
resolved; otherwise socket writes are encrypted and you will only see connect
metadata plus encrypted payload chunks.

Use the dedicated runner:

```sh
CC_HOOK_LOG=/tmp/claude-net.jsonl ./run-network-trace.sh
```

Useful env knobs:

```sh
CC_NET_CAPTURE_READS=1         # also hook read/recv paths
CC_NET_PREVIEW_BYTES=2048      # preview length stored in JSONL
CC_NET_DUMP_DIR=/tmp/claude-hook-network
CC_NET_DUMP_MAX_BYTES=131072   # per-chunk dump cap
```

Payload dumps are written to `CC_NET_DUMP_DIR`. Socket writes are filtered to
file descriptors that previously hit `connect`, so normal file IO and terminal
output stay mostly out of the trace.

These C++ boundaries cover whole-program evaluation and native-to-JS calls.
Ordinary JS-to-JS calls made by JIT or LLInt code bypass them. Use Bun's WebKit
Inspector breakpoints or source instrumentation for lexical bundle functions.
