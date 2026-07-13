"use strict";

/* IDA image base: 0x100000000, Claude Code 2.1.204 arm64. */
const offsets = {
  evaluate: 0x02ab0c88,
  executeProgram: 0x02820eec,
  call: 0x02a850cc,
  executeCall: 0x02822ce0,
  executeCallImpl: 0x02822914,
};

const enabledHooks = new Set(["evaluate", "call"]);
const maxArguments = 8;
const numberTag = uint64("0xfffe000000000000");
const otherTag = uint64(2);

function encodedValue(value) {
  const raw = uint64(value.toString());
  const hex = `0x${raw.toString(16).padStart(16, "0")}`;

  if (raw.compare(0) === 0) return { raw: hex, kind: "empty" };
  if (raw.compare(2) === 0) return { raw: hex, kind: "null" };
  if (raw.compare(6) === 0) return { raw: hex, kind: "boolean", value: false };
  if (raw.compare(7) === 0) return { raw: hex, kind: "boolean", value: true };
  if (raw.compare(10) === 0) return { raw: hex, kind: "undefined" };

  if (raw.and(numberTag).compare(numberTag) === 0) {
    let value32 = raw.and(uint64("0xffffffff")).toNumber();
    if (value32 >= 0x80000000) value32 -= 0x100000000;
    return { raw: hex, kind: "int32", value: value32 };
  }

  if (raw.and(numberTag.or(otherTag)).compare(0) === 0) {
    let cellType = null;
    try {
      cellType = value.add(5).readU8();
    } catch (_) {
      // A raw cell pointer may become invalid before asynchronous consumers run.
    }
    return { raw: hex, kind: "cell", cellType };
  }

  return { raw: hex, kind: "double-or-special" };
}

function readArguments(argList) {
  if (argList.isNull()) return [];

  try {
    const data = argList.readPointer();
    const count = argList.add(Process.pointerSize).readU32();
    const values = [];
    const visibleCount = Math.min(count, maxArguments);

    for (let index = 0; index < visibleCount; index++) {
      values.push(encodedValue(data.add(index * Process.pointerSize).readPointer()));
    }
    if (count > visibleCount) values.push({ omitted: count - visibleCount });
    return values;
  } catch (error) {
    return [{ error: String(error) }];
  }
}

function emit(event) {
  send({ timestamp: new Date().toISOString(), threadId: Process.getCurrentThreadId(), ...event });
}

function attach(name, callbacks) {
  if (!enabledHooks.has(name)) return;
  const address = Process.mainModule.base.add(offsets[name]);
  Interceptor.attach(address, callbacks);
  emit({ event: "hook-attached", name, address: address.toString() });
}

attach("evaluate", {
  onEnter(args) {
    this.startedAt = Date.now();
    emit({
      event: "enter",
      name: "JSC::evaluate",
      globalObject: args[0].toString(),
      sourceCode: args[1].toString(),
      thisValue: encodedValue(args[2]),
    });
  },
  onLeave(retval) {
    emit({
      event: "leave",
      name: "JSC::evaluate",
      elapsedMs: Date.now() - this.startedAt,
      result: encodedValue(retval),
    });
  },
});

attach("call", {
  onEnter(args) {
    this.startedAt = Date.now();
    emit({
      event: "enter",
      name: "JSC::call",
      functionObject: encodedValue(args[1]),
      callDataType: args[2].readU8(),
      thisValue: encodedValue(args[3]),
      arguments: readArguments(args[4]),
    });
  },
  onLeave(retval) {
    emit({
      event: "leave",
      name: "JSC::call",
      elapsedMs: Date.now() - this.startedAt,
      result: encodedValue(retval),
    });
  },
});
