#!/usr/bin/env python3
"""Attach to or spawn Claude Code and load the concatenated Frida JS agent."""

from __future__ import annotations

import argparse
import json
import os
import signal
import shutil
import sys
import threading
from pathlib import Path

import frida


ROOT = Path(__file__).resolve().parent
DEFAULT_BINARY = os.environ.get(
    "CLAUDE_BINARY",
    shutil.which("claude") or "/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--pid", type=int, help="attach to an existing PID")
    target.add_argument("--name", help="attach by process name")
    target.add_argument("--spawn", action="store_true", help="spawn Claude suspended, hook, then resume")
    parser.add_argument("--binary", default=DEFAULT_BINARY)
    parser.add_argument("--version", default=os.environ.get("CLAUDE_TRACE_TARGET_VERSION", "2.1.204"))
    parser.add_argument("--user-script", type=Path, default=ROOT / "user_logic.js")
    parser.add_argument("--no-internal-evaluate", action="store_true")
    parser.add_argument("--backtraces", action="store_true")
    parser.add_argument("--verbose-evaluate", action="store_true")
    parser.add_argument("--verbose-connect", action="store_true")
    parser.add_argument("--verbose-dlopen", action="store_true")
    parser.add_argument("target_args", nargs=argparse.REMAINDER, help="arguments after -- for spawned Claude")
    return parser.parse_args()


def on_message(message: dict, data: bytes | None) -> None:
    if message.get("type") == "send":
        print(json.dumps(message["payload"], ensure_ascii=False), flush=True)
    elif message.get("type") == "error":
        print(message.get("stack", message), file=sys.stderr, flush=True)
    else:
        print(json.dumps(message, ensure_ascii=False), flush=True)


def main() -> int:
    args = parse_args()
    config = {
        "version": args.version,
        "internalEvaluate": not args.no_internal_evaluate,
        "backtraces": args.backtraces,
        "verboseEvaluate": args.verbose_evaluate,
        "verboseConnect": args.verbose_connect,
        "verboseDlopen": args.verbose_dlopen,
    }

    source = (
        f"globalThis.HookConfig = {json.dumps(config)};\n"
        + args.user_script.read_text(encoding="utf-8")
        + "\n"
        + (ROOT / "agent.js").read_text(encoding="utf-8")
    )

    device = frida.get_local_device()
    spawned_pid: int | None = None
    if args.spawn:
        argv = [args.binary]
        if args.target_args and args.target_args[0] == "--":
            argv.extend(args.target_args[1:])
        else:
            argv.extend(args.target_args)
        spawned_pid = device.spawn(argv)
        target: int | str = spawned_pid
    else:
        target = args.pid if args.pid is not None else args.name

    done = threading.Event()
    session = device.attach(target)
    session.on(
        "detached",
        lambda reason, crash=None: (
            print(f"[launcher] detached: {reason}", flush=True),
            done.set(),
        ),
    )
    script = session.create_script(source)
    script.on("message", on_message)
    script.load()

    if spawned_pid is not None:
        device.resume(spawned_pid)

    print(f"[launcher] attached to {target}; Ctrl-C to detach", flush=True)

    def stop(_signum: int, _frame: object) -> None:
        done.set()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    done.wait()
    session.detach()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
