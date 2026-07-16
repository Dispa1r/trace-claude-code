# Locating the `cch` rewrite function in Claude Code 2.1.204

This note explains how the target native function was identified without
guessing. The short version is: first determine that `cch` is added after the
JavaScript layer, then instrument the whole request-body path, and finally pin
the exact body-preparation routine with dynamic evidence.

## Goal

We wanted to answer two separate questions:

1. Where is `cch=xxxxx` actually written?
2. Is the value produced by JavaScript, by a late socket wrapper, or by an
   earlier native request-body transform?

The final answer for Claude Code 2.1.204 is:

- the placeholder `cch=00000` exists before final serialization,
- the real value is written inside `sub_10142D258` (RVA `0x142d258`),
- the function computes `XXH64` over a canonicalized view of the prepared JSON
  body: it skips each `"model":"<value>"` string value and omits complete
  `fallbacks`, `fallback_credit_token`, and numeric `max_tokens` fields when
  present, then overwrites the placeholder in place.

## Step 1: prove the JavaScript view is incomplete

The first signal came from comparing multiple observation points for the same
request:

- Bun preload / JSONL only showed:

  ```text
  x-anthropic-billing-header: cc_version=...; cc_entrypoint=...;
  ```

- later native-side buffers already contained:

  ```text
  cch=xxxxx
  ```

- on-wire bytes also contained the same rewritten `cch=xxxxx`.

That rules out “plain JS already built the final header” and narrows the target
to a native stage between body construction and network send.

Related analysis:

- [docs/telemetry-three-chains.md](./telemetry-three-chains.md)

## Step 2: use high-signal string anchors

The candidate routine had to be able to see all of the following in one place:

- `cch=00000`
- `"system":[`
- `"model":"`
- `"fallbacks":[`
- `"fallback_credit_token":"`
- `"max_tokens":`

Those anchors imply a routine that operates on the prepared JSON request body,
not just on abstract request metadata and not only on raw socket fragments.

## Step 3: hook the whole candidate chain, not one function

Instead of trusting a single suspected function, we instrumented several points
in the native request path:

- send wrapper
- dispatch write
- alternate write path
- HTTP serializers
- request-body preparation candidate

The main probe is:

- [frida/cch_mutation_probe.js](../frida/cch_mutation_probe.js)

Relevant hooks and RVAs:

- `sub_100765AB4` — send wrapper
- `sub_101428DA0` — dispatch write
- `sub_100BF8D00` — alternate write path
- `sub_10141C998` / `sub_10141C4BC` — HTTP serializers
- `sub_10142D258` — body-prepare candidate

The critical observation was that `sub_10142D258` already exposed a body buffer
with the final `cch` value on function leave, using the request object’s body
pointer and length at offsets `+0x120` and `+0x128`.

That means the mutation is complete inside this function; later send/serialize
code only forwards bytes that are already rewritten.

## Step 4: prove the routine is doing search + hash + in-place rewrite

After narrowing to `sub_10142D258`, we hooked helper routines reached from that
path:

- a `memmem`-like search helper
- `sub_101435960`, which locates internal routing/budget fields to omit
- `XXH64` init / update / digest helpers

The probe emits backtraces and return RVAs so we can correlate helper calls with
the body-preparation path instead of unrelated uses elsewhere in the binary.

What we observed:

- the search helper was used from the candidate path to find body substrings,
  including the `"model":"` anchor;
- the code hashes bytes up to the start of a model value, resumes at its closing
  quote, and therefore retains the field syntax while omitting only the value;
- `sub_101435960` searches for `"fallbacks":[`,
  `"fallback_credit_token":"`, and numeric `"max_tokens":` fields; the caller
  hashes up to the returned range and resumes after it, omitting the complete
  field and one adjacent comma;
- `XXH64` was initialized from the same path with seed
  `0x4d659218e32a3268`;
- the digest’s low 20 bits matched the 5 lowercase hex characters written into
  `cch=00000`.

The omissions affect only the bytes fed to XXH64. The request body itself still
contains fields such as `model` and `max_tokens` when it is sent.

Two direct dynamic examples:

| XXH64 digest | Low 20 bits | Rewritten body value |
|---|---|---|
| `0x232b8b0fc55d004c` | `0xd004c` | `cch=d004c` |
| `0xe8224a7adaac1f8f` | `0xc1f8f` | `cch=c1f8f` |

A controlled local-upstream run also tested the canonicalization against the
actual outbound body. That request contained `model = claude-sonnet-4-6` and
`max_tokens = 32000`; the wire value was `cch=1f4b9`:

| Hash input | XXH64 digest | Low 20 bits | Matches wire |
|---|---|---|---|
| Full body with `cch=00000` | `0xa745d9d6591d9e49` | `d9e49` | No |
| Skip only the model value | `0x506e5056e9804563` | `04563` | No |
| Skip the model value and omit `"max_tokens":32000,` | `0xdc2fe934fbc1f4b9` | `1f4b9` | Yes |

The normal request did not contain `fallbacks` or `fallback_credit_token`, so
their omission is established statically by the same native range-selection
path rather than exercised by this particular wire sample.

## Step 5: rule out the “ordinary JS hash” explanation

We also patched JavaScript `crypto.createHash` to log suspicious inputs that
contain `cch=00000`:

- [preload/cch_hash_probe.js](../preload/cch_hash_probe.js)

This script is useful as a negative control:

- it helps explain the JavaScript-visible attribution pieces such as
  `cc_version`,
- but it does not explain the final native rewrite of `cch`.

So the final mutation is not just “a normal JS hash that later gets copied to
the socket”.

## Wire-level confirmation

There is also a narrower Frida probe that watches libc/network write APIs and
captures the first outbound buffer containing `cch=`:

- [frida/cch_probe.js](../frida/cch_probe.js)

That probe is useful for confirming what reaches the wire, but by itself it
cannot tell where the value was created. It was used as the outermost boundary,
while `cch_mutation_probe.js` was used to locate the actual rewrite point.

## Why `sub_10142D258` is the target function

`sub_10142D258` is the target because all of these are true at once:

1. it executes before serialization/send;
2. it has access to the full prepared JSON body;
3. the body already contains the final `cch` value when the function returns;
4. helper calls reached from this path perform the exact substring search and
   `XXH64` hashing behavior needed to explain the rewrite;
5. later hooks only observe the already-mutated bytes.

That is enough to move from “candidate” to “confirmed rewrite point” for
Claude Code 2.1.204.

## Version scope

All RVAs in this note are specific to Claude Code `2.1.204` on macOS arm64.
The methodology should survive upgrades, but the offsets and even the exact
helper split may change.
