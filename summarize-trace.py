from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any


DEFAULT_BUNDLE_PATHS = [
    Path("/Users/luyiren/unbuned/output/claude/claude.js"),
    Path.cwd() / "output/claude/claude.js",
]
DEFAULT_PROVIDER_DUMP_DIR = Path("/tmp/claude-hook-sources")


def load_events(path: Path) -> list[dict]:
    events = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        events.append(json.loads(line))
    return events


def pick_default_bundle() -> Path | None:
    for path in DEFAULT_BUNDLE_PATHS:
        if path.exists():
            return path
    return None


def normalize_excerpt(text: str, limit: int) -> str:
    compact = " ".join(text.split())
    if len(compact) <= limit:
        return compact
    return compact[: limit - 3] + "..."


def read_excerpt(source_text: str, start: int | None, end: int | None, context: int, limit: int) -> dict[str, Any] | None:
    if start is None or end is None:
        return None
    start = max(start, 0)
    end = min(end, len(source_text))
    if start >= end:
        return None
    snippet_start = max(start - context, 0)
    snippet_end = min(end + context, len(source_text))
    snippet = source_text[snippet_start:snippet_end]
    return {
        "range": [snippet_start, snippet_end],
        "preview": normalize_excerpt(snippet, limit),
    }


def load_provider_source(layout: dict[str, Any]) -> tuple[str | None, str | None]:
    provider_snapshot = layout.get("providerSnapshot") or {}
    best = None
    best_length = -1
    for slot in provider_snapshot.get("stringImplSlots", []):
        string_impl = slot.get("stringImpl") or {}
        length = int(string_impl.get("length", 0) or 0)
        if length > best_length:
            best = string_impl
            best_length = length
    if not best:
        return None, None
    dump_path = best.get("dumpPath")
    if not dump_path and best.get("address") and best.get("length"):
        dump_path = str(DEFAULT_PROVIDER_DUMP_DIR / f"{int(best['address'], 16):016x}_{int(best['length'])}.js")
    if not dump_path:
        return None, None
    path = Path(dump_path)
    if not path.exists():
        return None, None
    return path.read_text(encoding="utf-8", errors="replace"), str(path)


def sampled_js_summaries(events: list[dict], limit: int, bundle_text: str | None, excerpt_context: int, excerpt_limit: int) -> list[dict]:
    seen: dict[str, dict] = {}
    bundle_len = len(bundle_text) if bundle_text is not None else 0
    for event in events:
        if event.get("name") != "Interpreter::executeCall":
            continue
        js = event.get("callData", {}).get("js")
        if not js:
            continue
        layout = js.get("sampledLayout")
        if not layout:
            continue
        executable = js.get("functionExecutable", {}).get("address")
        if not executable or executable in seen:
            continue
        unlinked = layout.get("unlinkedSnapshot") or {}
        source = (layout.get("decoded") or {}).get("source") or {}
        unlinked_decoded = unlinked.get("decoded") or {}
        function_start = unlinked_decoded.get("unlinkedFunctionStart")
        function_end = unlinked_decoded.get("unlinkedFunctionEnd")
        excerpt = None
        source_excerpt = None
        provider_excerpt = None
        provider_dump_path = None
        looks_like_main_bundle = (
            bundle_text is not None
            and not ((unlinked.get("name") or {}).get("text") or (unlinked.get("ecmaName") or {}).get("text"))
            and source.get("length") is not None
            and source["length"] >= max(bundle_len - 256, 0)
            and source.get("endOffset") is not None
            and source["endOffset"] <= bundle_len
        )
        if looks_like_main_bundle:
            excerpt = read_excerpt(bundle_text, function_start, function_end, excerpt_context, excerpt_limit)
            source_excerpt = read_excerpt(bundle_text, source.get("startOffset"), source.get("endOffset"), excerpt_context, excerpt_limit)
        else:
            provider_text, provider_dump_path = load_provider_source(layout)
            if provider_text is not None and source.get("endOffset") is not None and source["endOffset"] <= len(provider_text):
                excerpt = read_excerpt(provider_text, function_start, function_end, excerpt_context, excerpt_limit)
                provider_excerpt = read_excerpt(provider_text, source.get("startOffset"), source.get("endOffset"), excerpt_context, excerpt_limit)
        seen[executable] = {
            "functionExecutable": executable,
            "name": (unlinked.get("name") or {}).get("text"),
            "ecmaName": (unlinked.get("ecmaName") or {}).get("text"),
            "startOffset": source.get("startOffset"),
            "endOffset": source.get("endOffset"),
            "firstLine": source.get("firstLine"),
            "startColumn": source.get("startColumn"),
            "functionStart": function_start,
            "functionEnd": function_end,
            "functionExcerpt": excerpt,
            "sourceExcerpt": source_excerpt,
            "providerExcerpt": provider_excerpt,
            "providerDumpPath": provider_dump_path,
        }
        if len(seen) >= limit:
            break
    return list(seen.values())


def main() -> int:
    parser = argparse.ArgumentParser(description="Summarize Claude Code LLDB hook JSONL traces.")
    parser.add_argument("trace", type=Path, help="Path to JSONL trace emitted by native_lldb.py")
    parser.add_argument("--limit", type=int, default=12, help="How many top entries to print")
    parser.add_argument("--bundle", type=Path, default=pick_default_bundle(), help="Optional bundle source file used to resolve source excerpts")
    parser.add_argument("--excerpt-context", type=int, default=48, help="Context characters around an excerpt")
    parser.add_argument("--excerpt-limit", type=int, default=180, help="Maximum characters to print for an excerpt")
    args = parser.parse_args()

    events = load_events(args.trace)
    bundle_text = None
    if args.bundle and args.bundle.exists():
        bundle_text = args.bundle.read_text(encoding="utf-8", errors="replace")
    native_counter: Counter[tuple[str | None, str | None]] = Counter()
    js_counter: Counter[str] = Counter()

    for event in events:
        if event.get("name") != "Interpreter::executeCall":
            continue
        call_data = event.get("callData", {})
        type_name = call_data.get("typeName")
        if type_name == "Native":
            native = call_data.get("native", {})
            native_counter[(native.get("function"), native.get("symbol"))] += 1
        elif type_name == "JS":
            executable = call_data.get("js", {}).get("functionExecutable", {}).get("address")
            if executable:
                js_counter[executable] += 1

    print("Top native callbacks:")
    for (address, symbol), count in native_counter.most_common(args.limit):
        print(f"{count:6d}  {address}  {symbol or '<unknown>'}")

    print()
    print("Top JS executables:")
    for executable, count in js_counter.most_common(args.limit):
        print(f"{count:6d}  {executable}")

    print()
    print("Sampled JS layouts:")
    for item in sampled_js_summaries(events, args.limit, bundle_text, args.excerpt_context, args.excerpt_limit):
        label = item["ecmaName"] or item["name"] or "<anonymous>"
        print(
            f"{item['functionExecutable']}  {label}  "
            f"offsets={item['startOffset']}..{item['endOffset']}  "
            f"function={item['functionStart']}..{item['functionEnd']}  "
            f"line={item['firstLine']} col={item['startColumn']}"
        )
        if item["functionExcerpt"]:
            print(f"  function excerpt: {item['functionExcerpt']['preview']}")
        elif item["sourceExcerpt"]:
            print(f"  source excerpt:   {item['sourceExcerpt']['preview']}")
        elif item["providerExcerpt"]:
            print(f"  provider excerpt: {item['providerExcerpt']['preview']}")
        if item["providerDumpPath"]:
            print(f"  provider dump:    {item['providerDumpPath']}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
