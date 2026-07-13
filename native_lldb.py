from __future__ import annotations

import json
import os
from pathlib import Path
import ipaddress
import sys
import time

import lldb


IDA_ADDRESSES = {
    "evaluate": 0x102AB0C88,
    "call": 0x102A850CC,
    "executeCall": 0x102822CE0,
    "executeCallImpl": 0x102822914,
}
IDA_RETURN_ADDRESSES = {
    "evaluate": [0x102AB0DC0],
    "call": [0x102A85108, 0x102A8512C],
    "executeCall": [],
    "executeCallImpl": [],
}
MAX_ARGUMENTS = 8
MAX_LAYOUT_QWORDS = 24
MAX_LAYOUT_BYTES = 0xC0
MAX_PROVIDER_BYTES = int(os.environ.get("CC_PROVIDER_BYTES", "0xA0"), 0)
MAX_PROVIDER_QWORDS = int(os.environ.get("CC_PROVIDER_QWORDS", str(max(20, (MAX_PROVIDER_BYTES + 7) // 8))))
MAX_EXECUTABLE_SAMPLES = int(os.environ.get("CC_MAX_EXECUTABLE_SAMPLES", "12"))
SOURCE_OFFSET_MAX = int(os.environ.get("CC_SOURCE_OFFSET_MAX", "50000000"))
STRING_PREVIEW_CHARS = int(os.environ.get("CC_STRING_PREVIEW_CHARS", "160"))
SOURCE_DUMP_DIR = Path(os.environ.get("CC_SOURCE_DUMP_DIR", "/tmp/claude-hook-sources"))
MAX_SOURCE_DUMP_LENGTH = int(os.environ.get("CC_MAX_SOURCE_DUMP_LENGTH", "33554432"))
NET_PREVIEW_BYTES = int(os.environ.get("CC_NET_PREVIEW_BYTES", "1024"))
NET_DUMP_DIR = Path(os.environ.get("CC_NET_DUMP_DIR", "/tmp/claude-hook-network"))
NET_DUMP_MAX_BYTES = int(os.environ.get("CC_NET_DUMP_MAX_BYTES", "65536"))
NET_CAPTURE_READS = os.environ.get("CC_NET_CAPTURE_READS", "0") == "1"
NET_LOG_ALL_FDS = os.environ.get("CC_NET_LOG_ALL_FDS", "0") == "1"
BUN_ZIGSTRING_UNTAG_MASK = (1 << 53) - 1
BUN_ZIGSTRING_UTF8_BIT = 1 << 61
BUN_ZIGSTRING_16BIT_BIT = 1 << 63
NUMBER_TAG = 0xFFFE000000000000
OTHER_TAG = 0x2
FUNCTION_EXECUTABLE_SOURCE_OFFSET = 40
FUNCTION_EXECUTABLE_TOP_LEVEL_OFFSET = 80
FUNCTION_EXECUTABLE_UNLINKED_OFFSET = 88
FUNCTION_EXECUTABLE_CODE_BLOCK_FOR_CALL_OFFSET = 96
FUNCTION_EXECUTABLE_CODE_BLOCK_FOR_CONSTRUCT_OFFSET = 104
FUNCTION_EXECUTABLE_SINGLETON_OFFSET = 112
FUNCTION_EXECUTABLE_POLY_PROTO_OFFSET = 120
UNLINKED_FUNCTION_NAME_OFFSET = 72
UNLINKED_FUNCTION_ECMA_NAME_OFFSET = 80
UNLINKED_FUNCTION_RARE_DATA_OFFSET = 88
pending_returns: dict[int, list[dict[str, object]]] = {}
sampled_executables: set[int] = set()
symbol_cache: dict[int, str | None] = {}
dumped_stringimpls: set[int] = set()
socket_peers: dict[int, dict[str, object]] = {}
network_payload_counter = 0

SYMBOL_HOOKS = {
    "connect": {"symbols": ["connect", "_connect"], "callback": "on_connect", "module": "libSystem.B.dylib"},
    "close": {"symbols": ["close", "_close"], "callback": "on_close", "module": "libSystem.B.dylib"},
    "send": {"symbols": ["send", "_send"], "callback": "on_send", "module": "libSystem.B.dylib"},
    "sendmsg": {"symbols": ["sendmsg", "_sendmsg"], "callback": "on_sendmsg", "module": "libSystem.B.dylib"},
    "write": {"symbols": ["write", "_write"], "callback": "on_write", "module": "libSystem.B.dylib"},
    "writev": {"symbols": ["writev", "_writev"], "callback": "on_writev", "module": "libSystem.B.dylib"},
    "recv": {"symbols": ["recv", "_recv"], "callback": "on_recv", "module": "libSystem.B.dylib"},
    "recvmsg": {"symbols": ["recvmsg", "_recvmsg"], "callback": "on_recvmsg", "module": "libSystem.B.dylib"},
    "read": {"symbols": ["read", "_read"], "callback": "on_read", "module": "libSystem.B.dylib"},
    "ssl_write": {"symbols": ["SSL_write", "_SSL_write", "SSL_write_ex", "_SSL_write_ex"], "callback": "on_ssl_write"},
    "ssl_read": {"symbols": ["SSL_read", "_SSL_read", "SSL_read_ex", "_SSL_read_ex"], "callback": "on_ssl_read"},
}


def emit(record: dict[str, object]) -> None:
    path = os.environ.get("CC_HOOK_LOG")
    line = json.dumps(record, ensure_ascii=True, separators=(",", ":"))
    if path:
        with open(path, "a", encoding="utf-8") as output:
            output.write(line + "\n")
    else:
        print(line, file=sys.stderr, flush=True)


def register(frame: lldb.SBFrame, name: str) -> int:
    return frame.FindRegister(name).GetValueAsUnsigned()


def hex_address(value: int | None) -> str | None:
    if value is None:
        return None
    return f"0x{value:x}"


def is_plausible_address(value: int | None) -> bool:
    if value is None:
        return False
    return 0x1000 <= value < (1 << 56)


def read_unsigned(process: lldb.SBProcess, address: int, size: int) -> int | None:
    if address < 0 or address >= (1 << 56):
        return None
    error = lldb.SBError()
    value = process.ReadUnsignedFromMemory(address, size, error)
    if error.Fail():
        return None
    return value


def read_pointer(process: lldb.SBProcess, address: int) -> int | None:
    if address < 0 or address >= (1 << 56):
        return None
    error = lldb.SBError()
    value = process.ReadPointerFromMemory(address, error)
    if error.Fail():
        return None
    return value


def read_memory(process: lldb.SBProcess, address: int, size: int) -> bytes | None:
    if address < 0 or address >= (1 << 56):
        return None
    error = lldb.SBError()
    data = process.ReadMemory(address, size, error)
    if error.Fail():
        return None
    return data


def read_capped_memory(process: lldb.SBProcess, address: int, size: int, cap: int = 4096) -> bytes | None:
    if size < 0:
        return None
    return read_memory(process, address, min(size, cap))


def read_c_string(process: lldb.SBProcess, address: int, max_bytes: int = 256) -> str | None:
    if not is_plausible_address(address):
        return None
    raw = read_capped_memory(process, address, max_bytes, max_bytes)
    if raw is None:
        return None
    end = raw.find(b"\x00")
    if end != -1:
        raw = raw[:end]
    try:
        return raw.decode("utf-8", errors="replace")
    except UnicodeDecodeError:
        return None


def read_cell_type(process: lldb.SBProcess, address: int | None) -> int | None:
    if not is_plausible_address(address):
        return None
    return read_unsigned(process, address + 5, 1)


def describe_cell_pointer(process: lldb.SBProcess, address: int | None) -> dict[str, object]:
    return {"address": hex_address(address), "cellType": read_cell_type(process, address)}


def resolve_symbol_name(process: lldb.SBProcess, address: int | None) -> str | None:
    if not is_plausible_address(address):
        return None
    if address in symbol_cache:
        return symbol_cache[address]
    target = process.GetTarget()
    sb_address = target.ResolveLoadAddress(address)
    symbol = sb_address.GetSymbol()
    if symbol and symbol.IsValid():
        name = symbol.GetName()
        symbol_cache[address] = name
        return name
    function = sb_address.GetFunction()
    if function and function.IsValid():
        name = function.GetName()
        symbol_cache[address] = name
        return name
    symbol_cache[address] = None
    return None


def decode_value(process: lldb.SBProcess, raw: int) -> dict[str, object]:
    value: dict[str, object] = {"raw": f"0x{raw:016x}"}
    if raw == 0:
        return {**value, "kind": "empty"}
    if raw == 2:
        return {**value, "kind": "null"}
    if raw == 6:
        return {**value, "kind": "boolean", "value": False}
    if raw == 7:
        return {**value, "kind": "boolean", "value": True}
    if raw == 10:
        return {**value, "kind": "undefined"}
    if raw & NUMBER_TAG == NUMBER_TAG:
        number = raw & 0xFFFFFFFF
        if number >= 0x80000000:
            number -= 0x100000000
        return {**value, "kind": "int32", "value": number}
    if raw & (NUMBER_TAG | OTHER_TAG) == 0:
        return {
            **value,
            "kind": "cell",
            "cellType": read_cell_type(process, raw),
        }
    return {**value, "kind": "double-or-special"}


def read_qword_window(process: lldb.SBProcess, address: int, count: int) -> list[str]:
    values = []
    for index in range(count):
        raw = read_unsigned(process, address + index * 8, 8)
        if raw is None:
            break
        values.append(f"0x{raw:016x}")
    return values


def sockaddr_to_dict(process: lldb.SBProcess, address: int | None) -> dict[str, object] | None:
    if not is_plausible_address(address):
        return None
    sa_len = read_unsigned(process, address, 1)
    family = read_unsigned(process, address + 1, 1)
    if family is None:
        return None
    record: dict[str, object] = {
        "address": hex_address(address),
        "saLen": sa_len,
        "family": family,
    }
    if family == 2:
        port_bytes = read_memory(process, address + 2, 2)
        ip_bytes = read_memory(process, address + 4, 4)
        if port_bytes and ip_bytes:
            record["kind"] = "ipv4"
            record["port"] = int.from_bytes(port_bytes, "big")
            record["host"] = str(ipaddress.IPv4Address(ip_bytes))
        return record
    if family == 30:
        port_bytes = read_memory(process, address + 2, 2)
        ip_bytes = read_memory(process, address + 8, 16)
        if port_bytes and ip_bytes:
            record["kind"] = "ipv6"
            record["port"] = int.from_bytes(port_bytes, "big")
            record["host"] = str(ipaddress.IPv6Address(ip_bytes))
            scope_id = read_unsigned(process, address + 24, 4)
            if scope_id:
                record["scopeId"] = scope_id
        return record
    if family == 1:
        path = read_c_string(process, address + 2, 104)
        record["kind"] = "unix"
        record["path"] = path
        return record
    return record


def should_log_fd(fd: int) -> bool:
    return NET_LOG_ALL_FDS or fd in socket_peers


def socket_peer_for_fd(fd: int) -> dict[str, object] | None:
    return socket_peers.get(fd)


def classify_payload(data: bytes) -> str:
    if data.startswith(b"CONNECT "):
        return "http-connect"
    if data.startswith((b"GET ", b"POST ", b"PUT ", b"PATCH ", b"DELETE ", b"HEAD ", b"OPTIONS ")):
        return "http1"
    if data.startswith(b"HTTP/1."):
        return "http1-response"
    if data.startswith(b"PRI * HTTP/2.0"):
        return "http2-preface"
    printable = sum(1 for byte in data if 32 <= byte < 127 or byte in (9, 10, 13))
    if data and printable / len(data) >= 0.85:
        return "text"
    return "binary"


def payload_preview(data: bytes, limit: int = NET_PREVIEW_BYTES) -> str:
    view = data[:limit]
    return "".join(chr(b) if 32 <= b < 127 or b in (9, 10, 13) else "." for b in view)


def dump_network_payload(direction: str, kind: str, data: bytes, fd: int | None = None) -> str | None:
    global network_payload_counter
    if not data:
        return None
    try:
        NET_DUMP_DIR.mkdir(parents=True, exist_ok=True)
    except OSError:
        return None
    network_payload_counter += 1
    suffix = "txt" if kind in {"http1", "http1-response", "http-connect", "text", "http2-preface"} else "bin"
    label = f"fd{fd}" if fd is not None else "nofd"
    path = NET_DUMP_DIR / f"{network_payload_counter:06d}_{direction}_{label}_{kind}.{suffix}"
    try:
        path.write_bytes(data[:NET_DUMP_MAX_BYTES])
    except OSError:
        return None
    return str(path)


def emit_network_payload(process: lldb.SBProcess, *, name: str, direction: str, fd: int | None, data: bytes | None, extra: dict[str, object] | None = None) -> None:
    if data is None:
        return
    kind = classify_payload(data)
    record: dict[str, object] = {
        "timestamp": time.time(),
        "event": "network",
        "name": name,
        "direction": direction,
        "threadId": process.GetSelectedThread().GetThreadID() if process.GetSelectedThread().IsValid() else None,
        "fd": fd,
        "peer": socket_peer_for_fd(fd) if fd is not None else None,
        "payloadKind": kind,
        "payloadBytes": len(data),
        "preview": payload_preview(data),
    }
    dump_path = dump_network_payload(direction, kind, data, fd)
    if dump_path:
        record["dumpPath"] = dump_path
    if extra:
        record.update(extra)
    emit(record)


def read_buffer(process: lldb.SBProcess, address: int | None, size: int | None, cap: int = NET_PREVIEW_BYTES) -> bytes | None:
    if not is_plausible_address(address) or size is None or size <= 0:
        return None
    return read_capped_memory(process, address, size, cap)


def read_iovec_buffer(process: lldb.SBProcess, iov_ptr: int | None, iov_count: int | None, cap: int = NET_PREVIEW_BYTES) -> bytes | None:
    if not is_plausible_address(iov_ptr) or iov_count is None or iov_count <= 0:
        return None
    chunks = bytearray()
    for index in range(min(iov_count, 32)):
        base = read_pointer(process, iov_ptr + index * 16)
        length = read_unsigned(process, iov_ptr + index * 16 + 8, 8)
        if not is_plausible_address(base) or length is None or length <= 0:
            continue
        remaining = cap - len(chunks)
        if remaining <= 0:
            break
        chunk = read_capped_memory(process, base, length, remaining)
        if chunk:
            chunks.extend(chunk)
    return bytes(chunks) if chunks else None


def read_msghdr_buffer(process: lldb.SBProcess, msghdr_ptr: int | None, cap: int = NET_PREVIEW_BYTES) -> bytes | None:
    if not is_plausible_address(msghdr_ptr):
        return None
    iov_ptr = read_pointer(process, msghdr_ptr + 16)
    iov_count = read_unsigned(process, msghdr_ptr + 24, 4)
    return read_iovec_buffer(process, iov_ptr, iov_count, cap)


def scan_pointer_slots(process: lldb.SBProcess, address: int, size: int = MAX_LAYOUT_BYTES) -> list[dict[str, object]]:
    pointers = []
    for offset in range(0, size, 8):
        raw = read_pointer(process, address + offset)
        if raw is None:
            continue
        entry: dict[str, object] = {"offset": offset, "value": hex_address(raw)}
        cell_type = read_cell_type(process, raw)
        if cell_type is not None:
            entry["cellType"] = cell_type
        pointers.append(entry)
    return pointers


def decode_sourcecode_at(process: lldb.SBProcess, address: int) -> dict[str, object] | None:
    provider = read_pointer(process, address)
    start = read_unsigned(process, address + 8, 4)
    end = read_unsigned(process, address + 12, 4)
    first_line = read_unsigned(process, address + 16, 4)
    start_column = read_unsigned(process, address + 20, 4)
    if provider is None or start is None or end is None or first_line is None or start_column is None:
        return None
    if not provider or start >= end or end > SOURCE_OFFSET_MAX:
        return None
    return {
        "provider": hex_address(provider),
        "startOffset": start,
        "endOffset": end,
        "length": end - start,
        "firstLine": first_line,
        "startColumn": start_column,
    }


def scan_sourcecode_candidates(process: lldb.SBProcess, address: int, size: int = MAX_LAYOUT_BYTES) -> list[dict[str, object]]:
    candidates = []
    seen = set()
    for offset in range(0, max(size - 24, 0) + 1, 4):
        provider = read_pointer(process, address + offset)
        start = read_unsigned(process, address + offset + 8, 4)
        end = read_unsigned(process, address + offset + 12, 4)
        first_line = read_unsigned(process, address + offset + 16, 4)
        start_column = read_unsigned(process, address + offset + 20, 4)
        if provider is None or start is None or end is None or first_line is None or start_column is None:
            continue
        if not provider or start >= end:
            continue
        if end > SOURCE_OFFSET_MAX:
            continue
        if not (1 <= first_line <= 1_000_000 and 1 <= start_column <= 100_000):
            continue
        key = (provider, start, end, first_line, start_column)
        if key in seen:
            continue
        seen.add(key)
        candidates.append(
            {
                "offset": offset,
                "provider": hex_address(provider),
                "startOffset": start,
                "endOffset": end,
                "length": end - start,
                "firstLine": first_line,
                "startColumn": start_column,
            }
        )
    return candidates[:6]


def decode_string_impl(process: lldb.SBProcess, address: int | None, max_length: int = SOURCE_OFFSET_MAX, preview_chars: int = STRING_PREVIEW_CHARS) -> dict[str, object] | None:
    if not address:
        return None
    length = read_unsigned(process, address + 4, 4)
    data = read_pointer(process, address + 8)
    hash_and_flags = read_unsigned(process, address + 16, 4)
    if length is None or data is None or hash_and_flags is None:
        return None
    is_8bit = bool(hash_and_flags & 0x4)
    record: dict[str, object] = {
        "address": hex_address(address),
        "length": length,
        "is8Bit": is_8bit,
    }
    if not length or length > max_length:
        return record
    preview_length = min(length, preview_chars)
    byte_length = preview_length if is_8bit else preview_length * 2
    payload = read_memory(process, data, byte_length)
    if payload is None:
        return record
    try:
        text = payload.decode("latin-1") if is_8bit else payload.decode("utf-16-le")
    except UnicodeDecodeError:
        return record
    if length <= preview_chars:
        record["text"] = text
    else:
        record["preview"] = text
    return record


def dump_string_impl(process: lldb.SBProcess, address: int, decoded: dict[str, object]) -> str | None:
    length = int(decoded.get("length", 0) or 0)
    if not (1024 <= length <= MAX_SOURCE_DUMP_LENGTH):
        return None
    path = SOURCE_DUMP_DIR / f"{address:016x}_{length}.js"
    if address in dumped_stringimpls or path.exists():
        dumped_stringimpls.add(address)
        return str(path)
    data = read_pointer(process, address + 8)
    is_8bit = bool(decoded.get("is8Bit"))
    if not is_plausible_address(data):
        return None
    raw = read_memory(process, data, length if is_8bit else length * 2)
    if raw is None:
        return None
    try:
        text = raw.decode("latin-1") if is_8bit else raw.decode("utf-16-le")
    except UnicodeDecodeError:
        return None
    try:
        SOURCE_DUMP_DIR.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    except OSError:
        return None
    dumped_stringimpls.add(address)
    return str(path)


def looks_like_human_text(text: str) -> bool:
    if not text:
        return False
    printable = sum(1 for char in text if char.isprintable() or char in "\r\n\t")
    return printable / len(text) >= 0.9


def decode_bun_zig_string(process: lldb.SBProcess, tagged_ptr: int | None, length: int | None) -> dict[str, object] | None:
    if tagged_ptr is None or length is None:
        return None
    untagged = tagged_ptr & BUN_ZIGSTRING_UNTAG_MASK
    is_utf16 = bool(tagged_ptr & BUN_ZIGSTRING_16BIT_BIT)
    is_utf8 = bool(tagged_ptr & BUN_ZIGSTRING_UTF8_BIT)
    record: dict[str, object] = {
        "taggedPtr": hex_address(tagged_ptr),
        "dataAddress": hex_address(untagged),
        "length": length,
        "isUtf16": is_utf16,
        "isUtf8": is_utf8,
    }
    if not is_plausible_address(untagged) or not (0 < length <= 4096):
        return record
    raw = read_capped_memory(process, untagged, length * (2 if is_utf16 else 1))
    if raw is None:
        return record
    try:
        if is_utf16:
            text = raw.decode("utf-16-le")
        else:
            text = raw.decode("utf-8" if is_utf8 else "latin-1")
    except UnicodeDecodeError:
        return record
    record["text"] = text
    return record


def scan_string_slots(process: lldb.SBProcess, address: int, size: int) -> list[dict[str, object]]:
    matches = []
    for offset in range(0, size, 8):
        candidate = read_pointer(process, address + offset)
        if not candidate:
            continue
        decoded = decode_string_impl(process, candidate)
        if not decoded:
            continue
        text = decoded.get("text") or decoded.get("preview")
        if text is not None and not looks_like_human_text(str(text)):
            continue
        if text is None and not (0 < int(decoded.get("length", 0)) <= 4096):
            continue
        matches.append({"offset": offset, "string": decoded})
    return matches[:12]


def scan_stringimpl_slots(process: lldb.SBProcess, address: int, size: int) -> list[dict[str, object]]:
    matches = []
    seen = set()
    for offset in range(0, size, 8):
        candidate = read_pointer(process, address + offset)
        if not is_plausible_address(candidate) or candidate in seen:
            continue
        seen.add(candidate)
        decoded = decode_string_impl(process, candidate)
        if not decoded:
            continue
        length = int(decoded.get("length", 0) or 0)
        text = decoded.get("text") or decoded.get("preview")
        if text is not None and not looks_like_human_text(str(text)):
            continue
        if text is None and length == 0:
            continue
        dump_path = dump_string_impl(process, candidate, decoded)
        if dump_path:
            decoded["dumpPath"] = dump_path
        matches.append({"offset": offset, "stringImpl": decoded})
    return matches[:16]


def decode_bun_string(process: lldb.SBProcess, address: int) -> dict[str, object] | None:
    tag = read_unsigned(process, address, 1)
    if tag is None or tag > 4:
        return None
    result: dict[str, object] = {
        "address": hex_address(address),
        "tag": tag,
        "tagName": {
            0: "Dead",
            1: "WTFStringImpl",
            2: "ZigString",
            3: "StaticZigString",
            4: "Empty",
        }.get(tag, "Unknown"),
    }
    if tag == 1:
        decoded = decode_string_impl(process, read_pointer(process, address + 8))
        if decoded is not None:
            result["value"] = decoded
        return result
    if tag in (2, 3):
        decoded = decode_bun_zig_string(process, read_pointer(process, address + 8), read_unsigned(process, address + 16, 8))
        if decoded is not None:
            result["value"] = decoded
        return result
    return result


def scan_bunstring_slots(process: lldb.SBProcess, address: int, size: int) -> list[dict[str, object]]:
    matches = []
    for offset in range(0, size - 24 + 1, 4):
        decoded = decode_bun_string(process, address + offset)
        if not decoded:
            continue
        tag = decoded["tag"]
        if tag in (0, 4):
            continue
        value = decoded.get("value") or {}
        text = value.get("text")
        if text is not None and not looks_like_human_text(str(text)):
            continue
        if text is None and int(value.get("length", 0) or 0) == 0:
            continue
        matches.append({"offset": offset, "bunString": decoded})
    return matches[:12]


def decode_unlinked_function_packed_fields(process: lldb.SBProcess, address: int) -> dict[str, object]:
    names = [
        ("firstLineOffset", "isGeneratedFromCache"),
        ("lineCount", "hasCapturedVariables"),
        ("unlinkedFunctionStart", "isBuiltinFunction"),
        ("unlinkedBodyStartColumn", "isBuiltinDefaultClassConstructor"),
        ("unlinkedBodyEndColumn", "constructAbility"),
        ("startOffset", "scriptMode"),
        ("sourceLength", "superBinding"),
        ("parametersStartOffset", "isCached"),
        ("unlinkedFunctionEnd", "needsClassFieldInitializer"),
        ("parameterCount", "singletonHasBeenInvalidated_privateBrandRequirement"),
    ]
    result: dict[str, object] = {}
    for index, (value_name, flag_name) in enumerate(names):
        word = read_unsigned(process, address + 8 + index * 4, 4)
        if word is None:
            continue
        if index == 9:
            result[value_name] = word & 0x3FFFFFFF
            result["singletonHasBeenInvalidated"] = (word >> 30) & 0x1
            result["privateBrandRequirement"] = (word >> 31) & 0x1
            continue
        result[value_name] = word & 0x7FFFFFFF
        result[flag_name] = (word >> 31) & 0x1
    flags_word0 = read_unsigned(process, address + 48, 4)
    flags_word1 = read_unsigned(process, address + 52, 4)
    if flags_word0 is not None:
        result["rawFlagsWord0"] = f"0x{flags_word0:08x}"
    if flags_word1 is not None:
        result["rawFlagsWord1"] = f"0x{flags_word1:08x}"
    return result


def snapshot_unlinked_executable(process: lldb.SBProcess, address: int | None) -> dict[str, object] | None:
    if not address:
        return None
    snapshot: dict[str, object] = {
        "address": hex_address(address),
        "cellType": read_cell_type(process, address),
        "qwords": read_qword_window(process, address, 12),
        "decoded": decode_unlinked_function_packed_fields(process, address),
        "name": decode_string_impl(process, read_pointer(process, address + UNLINKED_FUNCTION_NAME_OFFSET)),
        "ecmaName": decode_string_impl(process, read_pointer(process, address + UNLINKED_FUNCTION_ECMA_NAME_OFFSET)),
        "rareData": hex_address(read_pointer(process, address + UNLINKED_FUNCTION_RARE_DATA_OFFSET)),
    }
    return snapshot


def snapshot_source_provider(process: lldb.SBProcess, address: int | None) -> dict[str, object] | None:
    if not address:
        return None
    snapshot: dict[str, object] = {
        "address": hex_address(address),
        "qwords": read_qword_window(process, address, MAX_PROVIDER_QWORDS),
        "pointerSlots": scan_pointer_slots(process, address, MAX_PROVIDER_BYTES),
        "stringSlots": scan_string_slots(process, address, MAX_PROVIDER_BYTES),
        "stringImplSlots": scan_stringimpl_slots(process, address, MAX_PROVIDER_BYTES),
        "bunStringSlots": scan_bunstring_slots(process, address, MAX_PROVIDER_BYTES),
    }
    return snapshot


def snapshot_function_executable(process: lldb.SBProcess, address: int | None) -> dict[str, object] | None:
    if not address:
        return None
    source = decode_sourcecode_at(process, address + FUNCTION_EXECUTABLE_SOURCE_OFFSET)
    top_level = read_pointer(process, address + FUNCTION_EXECUTABLE_TOP_LEVEL_OFFSET)
    unlinked = read_pointer(process, address + FUNCTION_EXECUTABLE_UNLINKED_OFFSET)
    snapshot: dict[str, object] = {
        "address": hex_address(address),
        "cellType": read_cell_type(process, address),
        "qwords": read_qword_window(process, address, MAX_LAYOUT_QWORDS),
        "pointerSlots": scan_pointer_slots(process, address),
        "decoded": {
            "source": source,
            "topLevelExecutable": describe_cell_pointer(process, top_level),
            "unlinkedExecutable": describe_cell_pointer(process, unlinked),
            "codeBlockForCall": hex_address(read_pointer(process, address + FUNCTION_EXECUTABLE_CODE_BLOCK_FOR_CALL_OFFSET)),
            "codeBlockForConstruct": hex_address(read_pointer(process, address + FUNCTION_EXECUTABLE_CODE_BLOCK_FOR_CONSTRUCT_OFFSET)),
            "singletonRaw": hex_address(read_pointer(process, address + FUNCTION_EXECUTABLE_SINGLETON_OFFSET)),
            "polyProtoWatchpoint": hex_address(read_pointer(process, address + FUNCTION_EXECUTABLE_POLY_PROTO_OFFSET)),
        },
    }
    source_candidates = scan_sourcecode_candidates(process, address)
    if source_candidates:
        snapshot["sourceCandidates"] = source_candidates
    if source:
        provider_snapshot = snapshot_source_provider(process, read_pointer(process, address + FUNCTION_EXECUTABLE_SOURCE_OFFSET))
        if provider_snapshot is not None:
            snapshot["providerSnapshot"] = provider_snapshot
    unlinked_snapshot = snapshot_unlinked_executable(process, unlinked)
    if unlinked_snapshot is not None:
        snapshot["unlinkedSnapshot"] = unlinked_snapshot
    return snapshot


def describe_call_data(process: lldb.SBProcess, call_data: int) -> dict[str, object]:
    call_data_type = read_unsigned(process, call_data, 1)
    record: dict[str, object] = {
        "address": hex_address(call_data),
        "type": call_data_type,
        "typeName": {0: "None", 1: "Native", 2: "JS"}.get(call_data_type, "Unknown"),
    }
    if call_data_type == 1:
        native_function = read_pointer(process, call_data + 8)
        record["native"] = {
            "function": hex_address(native_function),
            "symbol": resolve_symbol_name(process, native_function),
            "isBoundFunction": bool(read_unsigned(process, call_data + 16, 1) or 0),
            "isWasm": bool(read_unsigned(process, call_data + 17, 1) or 0),
        }
    elif call_data_type == 2:
        function_executable = read_pointer(process, call_data + 8)
        scope = read_pointer(process, call_data + 16)
        js: dict[str, object] = {
            "functionExecutable": describe_cell_pointer(process, function_executable),
            "scope": hex_address(scope),
        }
        if function_executable and function_executable not in sampled_executables and len(sampled_executables) < MAX_EXECUTABLE_SAMPLES:
            sampled_executables.add(function_executable)
            snapshot = snapshot_function_executable(process, function_executable)
            if snapshot is not None:
                js["sampledLayout"] = snapshot
        record["js"] = js
    return record


def install_socket_peer(fd: int, peer: dict[str, object] | None) -> None:
    if peer is not None:
        socket_peers[fd] = peer


def on_connect(frame: lldb.SBFrame, _location: lldb.SBBreakpointLocation, _dict: dict) -> bool:
    process = frame.GetThread().GetProcess()
    fd = register(frame, "x0")
    peer = sockaddr_to_dict(process, register(frame, "x1"))
    install_socket_peer(fd, peer)
    emit(
        {
            "timestamp": time.time(),
            "event": "network-connect",
            "name": "connect",
            "threadId": frame.GetThread().GetThreadID(),
            "fd": fd,
            "peer": peer,
            "addressLength": register(frame, "x2"),
        }
    )
    return False


def on_close(frame: lldb.SBFrame, _location: lldb.SBBreakpointLocation, _dict: dict) -> bool:
    fd = register(frame, "x0")
    peer = socket_peers.pop(fd, None)
    if peer is None and not NET_LOG_ALL_FDS:
        return False
    emit(
        {
            "timestamp": time.time(),
            "event": "network-close",
            "name": "close",
            "threadId": frame.GetThread().GetThreadID(),
            "fd": fd,
            "peer": peer,
        }
    )
    return False


def on_send(frame: lldb.SBFrame, _location: lldb.SBBreakpointLocation, _dict: dict) -> bool:
    process = frame.GetThread().GetProcess()
    fd = register(frame, "x0")
    if not should_log_fd(fd):
        return False
    data = read_buffer(process, register(frame, "x1"), register(frame, "x2"))
    emit_network_payload(process, name="send", direction="out", fd=fd, data=data, extra={"flags": register(frame, "x3")})
    return False


def on_write(frame: lldb.SBFrame, _location: lldb.SBBreakpointLocation, _dict: dict) -> bool:
    process = frame.GetThread().GetProcess()
    fd = register(frame, "x0")
    if not should_log_fd(fd):
        return False
    data = read_buffer(process, register(frame, "x1"), register(frame, "x2"))
    emit_network_payload(process, name="write", direction="out", fd=fd, data=data)
    return False


def on_writev(frame: lldb.SBFrame, _location: lldb.SBBreakpointLocation, _dict: dict) -> bool:
    process = frame.GetThread().GetProcess()
    fd = register(frame, "x0")
    if not should_log_fd(fd):
        return False
    data = read_iovec_buffer(process, register(frame, "x1"), register(frame, "x2"))
    emit_network_payload(process, name="writev", direction="out", fd=fd, data=data, extra={"iovCount": register(frame, "x2")})
    return False


def on_sendmsg(frame: lldb.SBFrame, _location: lldb.SBBreakpointLocation, _dict: dict) -> bool:
    process = frame.GetThread().GetProcess()
    fd = register(frame, "x0")
    if not should_log_fd(fd):
        return False
    data = read_msghdr_buffer(process, register(frame, "x1"))
    emit_network_payload(process, name="sendmsg", direction="out", fd=fd, data=data, extra={"flags": register(frame, "x2")})
    return False


def on_recv(frame: lldb.SBFrame, _location: lldb.SBBreakpointLocation, _dict: dict) -> bool:
    if not NET_CAPTURE_READS:
        return False
    process = frame.GetThread().GetProcess()
    fd = register(frame, "x0")
    if not should_log_fd(fd):
        return False
    data = read_buffer(process, register(frame, "x1"), register(frame, "x2"))
    emit_network_payload(process, name="recv", direction="in", fd=fd, data=data, extra={"flags": register(frame, "x3")})
    return False


def on_read(frame: lldb.SBFrame, _location: lldb.SBBreakpointLocation, _dict: dict) -> bool:
    if not NET_CAPTURE_READS:
        return False
    process = frame.GetThread().GetProcess()
    fd = register(frame, "x0")
    if not should_log_fd(fd):
        return False
    data = read_buffer(process, register(frame, "x1"), register(frame, "x2"))
    emit_network_payload(process, name="read", direction="in", fd=fd, data=data)
    return False


def on_recvmsg(frame: lldb.SBFrame, _location: lldb.SBBreakpointLocation, _dict: dict) -> bool:
    if not NET_CAPTURE_READS:
        return False
    process = frame.GetThread().GetProcess()
    fd = register(frame, "x0")
    if not should_log_fd(fd):
        return False
    data = read_msghdr_buffer(process, register(frame, "x1"))
    emit_network_payload(process, name="recvmsg", direction="in", fd=fd, data=data, extra={"flags": register(frame, "x2")})
    return False


def on_ssl_write(frame: lldb.SBFrame, _location: lldb.SBBreakpointLocation, _dict: dict) -> bool:
    process = frame.GetThread().GetProcess()
    data = read_buffer(process, register(frame, "x1"), register(frame, "x2"))
    emit_network_payload(process, name="SSL_write", direction="out", fd=None, data=data, extra={"ssl": hex_address(register(frame, "x0"))})
    return False


def on_ssl_read(frame: lldb.SBFrame, _location: lldb.SBBreakpointLocation, _dict: dict) -> bool:
    if not NET_CAPTURE_READS:
        return False
    process = frame.GetThread().GetProcess()
    data = read_buffer(process, register(frame, "x1"), register(frame, "x2"))
    emit_network_payload(process, name="SSL_read", direction="in", fd=None, data=data, extra={"ssl": hex_address(register(frame, "x0"))})
    return False


def read_arguments(frame: lldb.SBFrame, arg_list: int) -> list[dict[str, object]]:
    if not arg_list:
        return []

    process = frame.GetThread().GetProcess()
    error = lldb.SBError()
    data = process.ReadPointerFromMemory(arg_list, error)
    if error.Fail():
        return [{"error": error.GetCString()}]
    count = process.ReadUnsignedFromMemory(arg_list + 8, 4, error)
    if error.Fail():
        return [{"error": error.GetCString()}]

    values = []
    for index in range(min(count, MAX_ARGUMENTS)):
        raw = process.ReadUnsignedFromMemory(data + index * 8, 8, error)
        if error.Fail():
            values.append({"error": error.GetCString()})
            break
        values.append(decode_value(process, raw))
    if count > MAX_ARGUMENTS:
        values.append({"omitted": count - MAX_ARGUMENTS})
    return values


def push_call(frame: lldb.SBFrame, name: str, started_at: float) -> None:
    thread_id = frame.GetThread().GetThreadID()
    pending_returns.setdefault(thread_id, []).append({"name": name, "startedAt": started_at})


def on_evaluate(frame: lldb.SBFrame, _location: lldb.SBBreakpointLocation, _dict: dict) -> bool:
    started_at = time.monotonic()
    process = frame.GetThread().GetProcess()
    emit(
        {
            "timestamp": time.time(),
            "event": "enter",
            "name": "JSC::evaluate",
            "threadId": frame.GetThread().GetThreadID(),
            "globalObject": f"0x{register(frame, 'x0'):x}",
            "sourceCode": f"0x{register(frame, 'x1'):x}",
            "thisValue": decode_value(process, register(frame, "x2")),
        }
    )
    push_call(frame, "JSC::evaluate", started_at)
    return False


def on_call(frame: lldb.SBFrame, _location: lldb.SBBreakpointLocation, _dict: dict) -> bool:
    started_at = time.monotonic()
    process = frame.GetThread().GetProcess()
    emit(
        {
            "timestamp": time.time(),
            "event": "enter",
            "name": "JSC::call",
            "threadId": frame.GetThread().GetThreadID(),
            "functionObject": decode_value(process, register(frame, "x1")),
            "callData": describe_call_data(process, register(frame, "x2")),
            "thisValue": decode_value(process, register(frame, "x3")),
            "arguments": read_arguments(frame, register(frame, "x4")),
        }
    )
    push_call(frame, "JSC::call", started_at)
    return False


def on_execute_call(frame: lldb.SBFrame, _location: lldb.SBBreakpointLocation, _dict: dict) -> bool:
    process = frame.GetThread().GetProcess()
    emit(
        {
            "timestamp": time.time(),
            "event": "enter",
            "name": "Interpreter::executeCall",
            "threadId": frame.GetThread().GetThreadID(),
            "interpreter": hex_address(register(frame, "x0")),
            "calleeObject": describe_cell_pointer(process, register(frame, "x1")),
            "callData": describe_call_data(process, register(frame, "x2")),
            "thisValue": decode_value(process, register(frame, "x3")),
            "context": hex_address(register(frame, "x4")),
            "arguments": read_arguments(frame, register(frame, "x5")),
        }
    )
    return False


def on_execute_call_impl(frame: lldb.SBFrame, _location: lldb.SBBreakpointLocation, _dict: dict) -> bool:
    process = frame.GetThread().GetProcess()
    emit(
        {
            "timestamp": time.time(),
            "event": "enter",
            "name": "Interpreter::executeCallImpl",
            "threadId": frame.GetThread().GetThreadID(),
            "interpreter": hex_address(register(frame, "x0")),
            "calleeObject": describe_cell_pointer(process, register(frame, "x1")),
            "callData": describe_call_data(process, register(frame, "x2")),
            "thisValue": decode_value(process, register(frame, "x3")),
            "context": hex_address(register(frame, "x4")),
            "arguments": read_arguments(frame, register(frame, "x5")),
        }
    )
    return False


def on_return(frame: lldb.SBFrame, _location: lldb.SBBreakpointLocation, _dict: dict) -> bool:
    thread_id = frame.GetThread().GetThreadID()
    stack = pending_returns.get(thread_id)
    if not stack:
        return False
    state = stack.pop()
    if not stack:
        pending_returns.pop(thread_id, None)
    process = frame.GetThread().GetProcess()
    emit(
        {
            "timestamp": time.time(),
            "event": "leave",
            "name": state["name"],
            "threadId": thread_id,
            "elapsedMs": round((time.monotonic() - float(state["startedAt"])) * 1000, 3),
            "result": decode_value(process, register(frame, "x0")),
        }
    )
    return False


def expand_requested_hooks(requested: list[str]) -> list[str]:
    expanded: list[str] = []
    network_group = ["connect", "close", "send", "sendmsg", "write", "writev", "ssl_write"]
    if NET_CAPTURE_READS:
        network_group += ["recv", "recvmsg", "read", "ssl_read"]
    aliases = {
        "network": network_group,
        "network-meta": ["connect", "close"],
    }
    for name in requested:
        expanded.extend(aliases.get(name, [name]))
    # Preserve order while deduplicating.
    result: list[str] = []
    seen = set()
    for name in expanded:
        if name in seen:
            continue
        seen.add(name)
        result.append(name)
    return result


def install_symbol_hook(target: lldb.SBTarget, name: str, callback_name: str, symbols: list[str], module_name: str | None, result: lldb.SBCommandReturnObject) -> None:
    installed = False
    for symbol in symbols:
        breakpoint = target.BreakpointCreateByName(symbol, module_name) if module_name else target.BreakpointCreateByName(symbol)
        breakpoint.SetScriptCallbackFunction(f"{__name__}.{callback_name}")
        emit(
            {
                "event": "hook-installed",
                "name": name,
                "symbol": symbol,
                "module": module_name,
                "breakpointId": breakpoint.GetID(),
                "locations": breakpoint.GetNumLocations(),
                "pending": breakpoint.GetNumLocations() == 0,
            }
        )
        installed = True
    if not installed:
        result.AppendWarning(f"symbol hook not resolved: {name}")


def install(debugger: lldb.SBDebugger, command: str, result: lldb.SBCommandReturnObject, _dict: dict) -> None:
    target = debugger.GetSelectedTarget()
    module = target.GetModuleAtIndex(0)
    requested = expand_requested_hooks([item.strip() for item in command.split(",") if item.strip()] or ["evaluate", "executeCall"])
    callbacks = {
        "evaluate": on_evaluate,
        "call": on_call,
        "executeCall": on_execute_call,
        "executeCallImpl": on_execute_call_impl,
    }

    for name in requested:
        if name in IDA_ADDRESSES:
            address = module.ResolveFileAddress(IDA_ADDRESSES[name])
            breakpoint = target.BreakpointCreateBySBAddress(address)
            breakpoint.SetScriptCallbackFunction(f"{__name__}.{callbacks[name].__name__}")
            emit(
                {
                    "event": "hook-installed",
                    "name": name,
                    "fileAddress": f"0x{IDA_ADDRESSES[name]:x}",
                    "breakpointId": breakpoint.GetID(),
                }
            )

            for return_address in IDA_RETURN_ADDRESSES.get(name, []):
                return_breakpoint = target.BreakpointCreateBySBAddress(module.ResolveFileAddress(return_address))
                return_breakpoint.SetScriptCallbackFunction(f"{__name__}.on_return")
            continue

        if name in SYMBOL_HOOKS:
            descriptor = SYMBOL_HOOKS[name]
            install_symbol_hook(
                target,
                name,
                descriptor["callback"],
                descriptor["symbols"],
                descriptor.get("module"),
                result,
            )
            continue

        result.SetError(f"unknown hook: {name}")
        return

    result.AppendMessage(f"installed hooks: {', '.join(requested)}")


def __lldb_init_module(debugger: lldb.SBDebugger, _dict: dict) -> None:
    debugger.HandleCommand(f"command script add -f {__name__}.install cc-hook-install")
