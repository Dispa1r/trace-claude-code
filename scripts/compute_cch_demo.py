#!/usr/bin/env python3
"""
Compute Claude Code 2.1.204 `cch` from a captured request body.

What this script implements:

- normalize `cch=<value>` to `cch=00000`
- find the top-level `"model":"<value>"` field
- compute XXH64 with seed 0x4d659218e32a3268 while skipping only the model
  value bytes
- return the low 20 bits as 5 lowercase hex characters

By default, the script validates against a real captured request body stored in:

  traces/cch_pair2/claude-network-1784023170915-68494.jsonl

The expected `cch` for that request is `d1a7a`.
"""

from __future__ import annotations

import argparse
import json
import re
import struct
from pathlib import Path


MASK64 = (1 << 64) - 1
PRIME64_1 = 11400714785074694791
PRIME64_2 = 14029467366897019727
PRIME64_3 = 1609587929392839161
PRIME64_4 = 9650029242287828579
PRIME64_5 = 2870177450012600261
SEED = 0x4D659218E32A3268

DEFAULT_JSONL = (
    Path(__file__).resolve().parent.parent
    / "traces"
    / "cch_pair2"
    / "claude-network-1784023170915-68494.jsonl"
)
DEFAULT_EXPECTED_CCH = "d1a7a"


def rotl64(value: int, bits: int) -> int:
    return ((value << bits) & MASK64) | (value >> (64 - bits))


def xxh64_round(acc: int, lane: int) -> int:
    acc = (acc + lane * PRIME64_2) & MASK64
    acc = rotl64(acc, 31)
    acc = (acc * PRIME64_1) & MASK64
    return acc


def xxh64_merge_round(acc: int, value: int) -> int:
    acc ^= xxh64_round(0, value)
    acc = (acc * PRIME64_1 + PRIME64_4) & MASK64
    return acc


def xxh64_avalanche(value: int) -> int:
    value ^= value >> 33
    value = (value * PRIME64_2) & MASK64
    value ^= value >> 29
    value = (value * PRIME64_3) & MASK64
    value ^= value >> 32
    return value & MASK64


def xxh64(data: bytes, seed: int = 0) -> int:
    view = memoryview(data)
    length = len(view)
    index = 0

    if length >= 32:
        v1 = (seed + PRIME64_1 + PRIME64_2) & MASK64
        v2 = (seed + PRIME64_2) & MASK64
        v3 = seed & MASK64
        v4 = (seed - PRIME64_1) & MASK64

        limit = length - 32
        while index <= limit:
            v1 = xxh64_round(v1, struct.unpack_from("<Q", view, index)[0])
            index += 8
            v2 = xxh64_round(v2, struct.unpack_from("<Q", view, index)[0])
            index += 8
            v3 = xxh64_round(v3, struct.unpack_from("<Q", view, index)[0])
            index += 8
            v4 = xxh64_round(v4, struct.unpack_from("<Q", view, index)[0])
            index += 8

        acc = (
            rotl64(v1, 1)
            + rotl64(v2, 7)
            + rotl64(v3, 12)
            + rotl64(v4, 18)
        ) & MASK64
        acc = xxh64_merge_round(acc, v1)
        acc = xxh64_merge_round(acc, v2)
        acc = xxh64_merge_round(acc, v3)
        acc = xxh64_merge_round(acc, v4)
    else:
        acc = (seed + PRIME64_5) & MASK64

    acc = (acc + length) & MASK64

    while index + 8 <= length:
        lane = struct.unpack_from("<Q", view, index)[0]
        k1 = xxh64_round(0, lane)
        acc ^= k1
        acc = (rotl64(acc, 27) * PRIME64_1 + PRIME64_4) & MASK64
        index += 8

    if index + 4 <= length:
        lane32 = struct.unpack_from("<I", view, index)[0]
        acc ^= (lane32 * PRIME64_1) & MASK64
        acc = (rotl64(acc, 23) * PRIME64_2 + PRIME64_3) & MASK64
        index += 4

    while index < length:
        acc ^= (view[index] * PRIME64_5) & MASK64
        acc = (rotl64(acc, 11) * PRIME64_1) & MASK64
        index += 1

    return xxh64_avalanche(acc)


def normalize_cch_placeholder(body: bytes) -> bytes:
    return re.sub(rb"cch=[0-9a-z]{5}", b"cch=00000", body)


def remove_model_value_bytes(body: bytes) -> tuple[bytes, str]:
    anchor = b'"model":"'
    start_anchor = body.find(anchor)
    if start_anchor < 0:
        raise ValueError('top-level `"model":"` anchor not found')

    value_start = start_anchor + len(anchor)
    index = value_start
    escaped = False
    while index < len(body):
        current = body[index]
        if escaped:
            escaped = False
        elif current == 0x5C:  # backslash
            escaped = True
        elif current == 0x22:  # double quote
            value_end = index
            model_value = body[value_start:value_end].decode("utf-8")
            return body[:value_start] + body[value_end:], model_value
        index += 1

    raise ValueError("model closing quote not found")


def compute_cch(body_text: str) -> dict[str, str | int]:
    normalized = normalize_cch_placeholder(body_text.encode("utf-8"))
    hashed_input, model_value = remove_model_value_bytes(normalized)
    digest = xxh64(hashed_input, SEED)
    low20 = digest & 0xFFFFF
    return {
        "model": model_value,
        "digest_hex": f"0x{digest:016x}",
        "low20_hex": f"0x{low20:05x}",
        "cch": f"{low20:05x}",
        "normalized_body_bytes": len(normalized),
        "hashed_input_bytes": len(hashed_input),
    }


def extract_request_body(
    jsonl_path: Path,
    occurrence: int,
) -> tuple[int, str, str]:
    seen = 0
    with jsonl_path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            obj = json.loads(line)
            if obj.get("phase") != "request":
                continue
            if obj.get("transport") != "fetch":
                continue
            url = obj.get("url", "")
            if "/v1/messages" not in url:
                continue
            body = obj.get("body") or {}
            text = body.get("text") if isinstance(body, dict) else None
            if not isinstance(text, str):
                continue
            if "x-anthropic-billing-header" not in text:
                continue
            seen += 1
            if seen == occurrence:
                return line_number, url, text
    raise SystemExit(
        f"could not find occurrence #{occurrence} of a fetch /v1/messages request "
        f"with x-anthropic-billing-header in {jsonl_path}"
    )


def self_check() -> None:
    # Standard XXH64 test vector for empty input, seed=0.
    expected = 0xEF46DB3751D8E999
    actual = xxh64(b"", 0)
    if actual != expected:
        raise SystemExit(
            f"XXH64 self-check failed: expected 0x{expected:016x}, got 0x{actual:016x}"
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--jsonl", type=Path, default=DEFAULT_JSONL)
    parser.add_argument(
        "--occurrence",
        type=int,
        default=1,
        help="1-based occurrence among fetch /v1/messages requests that carry the attribution body",
    )
    parser.add_argument(
        "--expect-cch",
        default=DEFAULT_EXPECTED_CCH,
        help="optional expected cch value; set empty string to disable assertion",
    )
    parser.add_argument(
        "--show-body-prefix",
        type=int,
        default=220,
        help="print the first N characters of the selected request body",
    )
    return parser.parse_args()


def main() -> int:
    self_check()
    args = parse_args()
    line_number, url, body_text = extract_request_body(args.jsonl, args.occurrence)
    result = compute_cch(body_text)

    print(f"jsonl: {args.jsonl}")
    print(f"line: {line_number}")
    print(f"url: {url}")
    print(f"model: {result['model']}")
    print(f"digest: {result['digest_hex']}")
    print(f"low20: {result['low20_hex']}")
    print(f"cch: {result['cch']}")
    print(f"normalized_body_bytes: {result['normalized_body_bytes']}")
    print(f"hashed_input_bytes: {result['hashed_input_bytes']}")
    print("body_prefix:")
    print(body_text[: args.show_body_prefix].replace("\n", "\\n"))

    expected = (args.expect_cch or "").strip().lower()
    if expected:
        actual = str(result["cch"]).lower()
        if actual != expected:
            raise SystemExit(
                f"expected cch={expected}, got cch={actual}"
            )
        print(f"validation: OK (matches expected cch={expected})")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
