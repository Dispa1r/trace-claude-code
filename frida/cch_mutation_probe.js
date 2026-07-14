'use strict';

const cchMainModule = Process.mainModule;
const cchPattern = '63 63 68 3d'; // cch=
const candidateRanges = [];

const RVAS = {
  sendWrapper: 0x00765ab4,
  sha256UpdateLike: 0x007ec07c,
  httpSerializePlain: 0x0141c998,
  httpSerializeTls: 0x0141c4bc,
  prepareBodyChunk: 0x0142d258,
  memmemLike: 0x0031a118,
  xxh64Init: 0x00606098,
  xxh64Update: 0x006060fc,
  xxh64Digest: 0x00606278,
  dispatchWrite: 0x01428da0,
  altWrite: 0x00bf8d00,
};

const trackedHashContexts = new Set();

function emitMutation(kind, fields) {
  send({ kind, ...fields });
}

function rva(address) {
  if (address.compare(cchMainModule.base) < 0 || address.compare(cchMainModule.base.add(cchMainModule.size)) >= 0) {
    return null;
  }
  return address.sub(cchMainModule.base).toString();
}

function maybeNumber(value) {
  try {
    return value.toNumber();
  } catch (_) {
    try {
      return value.toInt32();
    } catch (_) {
      return null;
    }
  }
}

function backtrace(context) {
  return Thread.backtrace(context, Backtracer.ACCURATE).map(address => ({
    address: address.toString(),
    rva: rva(address),
    symbol: DebugSymbol.fromAddress(address).toString(),
  }));
}

function bytesToAscii(buffer) {
  const bytes = new Uint8Array(buffer);
  let output = '';
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    output += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.';
  }
  return output;
}

function containsRange(pointer) {
  return candidateRanges.some(range => pointer.compare(range.start) >= 0 && pointer.compare(range.end) < 0);
}

function rememberRange(pointer, length, label) {
  if (pointer.isNull() || length <= 0 || length > 4 * 1024 * 1024) return;
  candidateRanges.push({
    start: pointer,
    end: pointer.add(length),
    label,
  });
  if (candidateRanges.length > 32) candidateRanges.shift();
}

function readWindow(pointer, beforeBytes, afterBytes) {
  if (pointer.isNull()) return '';
  const start = pointer.sub(beforeBytes);
  const total = beforeBytes + afterBytes;
  try {
    return bytesToAscii(start.readByteArray(total));
  } catch (_) {
    return '';
  }
}

function findCch(pointer, length) {
  if (pointer.isNull() || length <= 0 || length > 4 * 1024 * 1024) return null;
  try {
    const matches = Memory.scanSync(pointer, length, cchPattern);
    if (matches.length === 0) return null;
    const hit = matches[0].address;
    let excerpt = '';
    try {
      excerpt = hit.readUtf8String(Math.min(128, pointer.add(length).sub(hit).toInt32()));
    } catch (_) {}
    return { hit, excerpt };
  } catch (_) {
    return null;
  }
}

function cchValue(text) {
  const match = /cch=([0-9a-z]{5})/i.exec(text);
  return match ? match[1] : null;
}

function emitIfBufferHasCch(kind, pointer, length, context, extra) {
  const match = findCch(pointer, length);
  if (match === null) return null;
  rememberRange(pointer, length, kind);
  emitMutation(kind, {
    pointer: pointer.toString(),
    length,
    hit: match.hit.toString(),
    excerpt: match.excerpt,
    cch: cchValue(match.excerpt),
    backtrace: backtrace(context),
    ...extra,
  });
  return match;
}

function hookCandidateFunction(name, address, onEnter) {
  Interceptor.attach(address, {
    onEnter(args) {
      try {
        onEnter.call(this, args);
      } catch (error) {
        emitMutation('probe-error', { name, error: String(error), stack: error.stack || '' });
      }
    },
  });
  emitMutation('hook-installed', { name, address: address.toString(), rva: rva(address) });
}

function installCandidateHooks() {
  const sendWrapper = cchMainModule.base.add(RVAS.sendWrapper);
  hookCandidateFunction('sub_100765AB4', sendWrapper, function (args) {
    const length = args[2].toInt32();
    emitIfBufferHasCch('send-wrapper-enter', args[1], length, this.context, {
      returnAddress: this.returnAddress.toString(),
      returnRva: rva(this.returnAddress),
      returnSymbol: DebugSymbol.fromAddress(this.returnAddress).toString(),
    });
  });

  const dispatchWrite = cchMainModule.base.add(RVAS.dispatchWrite);
  hookCandidateFunction('sub_101428DA0', dispatchWrite, function (args) {
    const mode = args[0].toInt32();
    const length = maybeNumber(args[3]) ?? 0;
    emitIfBufferHasCch('dispatch-write-enter', args[2], length, this.context, {
      mode,
      returnAddress: this.returnAddress.toString(),
      returnRva: rva(this.returnAddress),
      returnSymbol: DebugSymbol.fromAddress(this.returnAddress).toString(),
    });
  });

  const altWrite = cchMainModule.base.add(RVAS.altWrite);
  hookCandidateFunction('sub_100BF8D00', altWrite, function (args) {
    const length = maybeNumber(args[2]) ?? 0;
    emitIfBufferHasCch('alt-write-enter', args[1], length, this.context, {
      returnAddress: this.returnAddress.toString(),
      returnRva: rva(this.returnAddress),
      returnSymbol: DebugSymbol.fromAddress(this.returnAddress).toString(),
    });
  });

  const shaUpdate = cchMainModule.base.add(RVAS.sha256UpdateLike);
  hookCandidateFunction('sub_1007EC07C', shaUpdate, function (args) {
    const pointer = args[1];
    const length = maybeNumber(args[2]) ?? 0;
    const window = readWindow(pointer, 0, Math.min(length + 8, 128));
    const interesting = window.includes('cch=')
      || window.includes('cc_version=')
      || window.includes('cc_entrypoint=')
      || trackedHashContexts.has(args[0].toString());
    if (!interesting) return;
    trackedHashContexts.add(args[0].toString());
    emitMutation('sha-update-enter', {
      context: args[0].toString(),
      pointer: pointer.toString(),
      length,
      chunk: window,
      returnAddress: this.returnAddress.toString(),
      returnRva: rva(this.returnAddress),
      returnSymbol: DebugSymbol.fromAddress(this.returnAddress).toString(),
      backtrace: backtrace(this.context),
    });
  });

  const prepareBodyChunk = cchMainModule.base.add(RVAS.prepareBodyChunk);
  Interceptor.attach(prepareBodyChunk, {
    onEnter(args) {
      this.request = args[0];
    },
    onLeave() {
      try {
        if (this.request.isNull()) return;
        const bodyPtr = this.request.add(0x120).readPointer();
        const bodyLen = this.request.add(0x128).readPointer();
        const lenNum = maybeNumber(bodyLen) ?? 0;
        if (bodyPtr.isNull() || lenNum <= 0 || lenNum > 4 * 1024 * 1024) return;
        emitIfBufferHasCch('prepare-body-leave', bodyPtr, lenNum, this.context, {
          request: this.request.toString(),
          bodyPtr: bodyPtr.toString(),
          bodyLen: lenNum,
        });
      } catch (error) {
        emitMutation('probe-error', { name: 'sub_10142D258', error: String(error), stack: error.stack || '' });
      }
    },
  });
  emitMutation('hook-installed', { name: 'sub_10142D258', address: prepareBodyChunk.toString(), rva: rva(prepareBodyChunk) });

  const memmemLike = cchMainModule.base.add(RVAS.memmemLike);
  Interceptor.attach(memmemLike, {
    onEnter(args) {
      this.returnAddressSnapshot = this.returnAddress;
      const retRva = rva(this.returnAddress);
      this.interesting = retRva === '0x142e0c4';
      if (!this.interesting) return;
      this.haystack = args[0];
      this.haystackLen = maybeNumber(args[1]) ?? 0;
      this.needle = args[2];
      this.needleLen = maybeNumber(args[3]) ?? 0;
    },
    onLeave(retval) {
      if (!this.interesting) return;
      let needleText = '';
      try {
        needleText = bytesToAscii(this.needle.readByteArray(this.needleLen));
      } catch (_) {}
      emitMutation('memmem-like', {
        returnAddress: this.returnAddressSnapshot.toString(),
        returnRva: rva(this.returnAddressSnapshot),
        haystack: this.haystack.toString(),
        haystackLen: this.haystackLen,
        needle: this.needle.toString(),
        needleLen: this.needleLen,
        needleText,
        result: retval.toString(),
        resultRva: retval.isNull() ? null : rva(retval),
      });
    },
  });
  emitMutation('hook-installed', { name: 'sub_10031A118', address: memmemLike.toString(), rva: rva(memmemLike) });

  const xxh64Init = cchMainModule.base.add(RVAS.xxh64Init);
  Interceptor.attach(xxh64Init, {
    onEnter(args) {
      this.returnAddressSnapshot = this.returnAddress;
      if (rva(this.returnAddress) !== '0x142e080') return;
      emitMutation('xxh64-init', {
        state: args[0].toString(),
        seed: args[1].toString(),
        returnAddress: this.returnAddressSnapshot.toString(),
        returnRva: rva(this.returnAddressSnapshot),
      });
    },
  });
  emitMutation('hook-installed', { name: 'sub_100606098', address: xxh64Init.toString(), rva: rva(xxh64Init) });

  const xxh64Digest = cchMainModule.base.add(RVAS.xxh64Digest);
  Interceptor.attach(xxh64Digest, {
    onEnter(args) {
      this.returnAddressSnapshot = this.returnAddress;
      this.interesting = rva(this.returnAddress) === '0x142e1a8';
      if (!this.interesting) return;
      this.state = args[0];
    },
    onLeave(retval) {
      if (!this.interesting) return;
      const value = retval.toString();
      let low20 = null;
      try {
        const asBig = BigInt(value);
        low20 = '0x' + (asBig & 0xfffffn).toString(16).padStart(5, '0');
      } catch (_) {}
      emitMutation('xxh64-digest', {
        state: this.state.toString(),
        digest: value,
        low20,
        returnAddress: this.returnAddressSnapshot.toString(),
        returnRva: rva(this.returnAddressSnapshot),
      });
    },
  });
  emitMutation('hook-installed', { name: 'sub_100606278', address: xxh64Digest.toString(), rva: rva(xxh64Digest) });

  for (const [name, rvaValue] of [
    ['sub_10141C998', RVAS.httpSerializePlain],
    ['sub_10141C4BC', RVAS.httpSerializeTls],
  ]) {
    const address = cchMainModule.base.add(rvaValue);
    Interceptor.attach(address, {
      onEnter(args) {
        this.out = args[0];
        this.request = args[2];
        this.name = name;
      },
      onLeave() {
        try {
          if (this.out.isNull()) return;
          const capacity = this.out.readPointer();
          const buffer = this.out.add(Process.pointerSize).readPointer();
          const length = this.out.add(Process.pointerSize * 2).readPointer();
          const capNum = maybeNumber(capacity) ?? 0;
          const lenNum = maybeNumber(length) ?? 0;
          if (lenNum <= 0 || lenNum > 4 * 1024 * 1024 || buffer.isNull()) return;
          emitIfBufferHasCch('http-serialize-leave', buffer, lenNum, this.context, {
            serializer: this.name,
            outStruct: this.out.toString(),
            request: this.request.toString(),
            capacity: capNum,
            length: lenNum,
          });
        } catch (error) {
          emitMutation('probe-error', { name: this.name, error: String(error), stack: error.stack || '' });
        }
      },
    });
    emitMutation('hook-installed', { name, address: address.toString(), rva: rva(address) });
  }
}

function hookCopyRoutine(name) {
  const address = Module.findGlobalExportByName(name) || Module.findGlobalExportByName(`_${name}`);
  if (address === null) return;

  Interceptor.attach(address, {
    onEnter(args) {
      this.contextSnapshot = backtrace(this.context);
      this.returnAddressSnapshot = this.returnAddress;
      this.dst = args[0];
      this.src = args[1];
      this.length = maybeNumber(args[2]) ?? 0;
      if (this.length <= 0 || this.length > 4 * 1024 * 1024) return;

      const smallHexCopy = this.length <= 16;
      const aroundTrackedRange = containsRange(this.dst) || containsRange(this.src);
      const beforeDst = readWindow(this.dst, 8, 48);
      const beforeSrc = readWindow(this.src, 8, Math.min(48, this.length + 8));
      const srcMatch = (!this.src.isNull() && this.length <= 32768) ? findCch(this.src, this.length) : null;
      const dstMatch = (!this.dst.isNull() && this.length <= 32768) ? findCch(this.dst, this.length) : null;

      this.interesting = aroundTrackedRange
        || beforeDst.includes('cch=')
        || beforeSrc.includes('cch=')
        || srcMatch !== null
        || dstMatch !== null
        || (smallHexCopy && /[0-9a-f]{5}/i.test(beforeSrc));

      if (!this.interesting) return;
      this.beforeDst = beforeDst;
      this.beforeSrc = beforeSrc;
      this.srcMatch = srcMatch;
      this.dstMatch = dstMatch;
    },
    onLeave() {
      if (!this.interesting) return;

      const afterDst = readWindow(this.dst, 8, 48);
      const afterDstMatch = (!this.dst.isNull() && this.length <= 32768) ? findCch(this.dst, this.length) : null;
      const beforeValue = cchValue(this.beforeDst || this.beforeSrc || '');
      const afterValue = cchValue(afterDst) || (afterDstMatch ? cchValue(afterDstMatch.excerpt || '') : null);
      const mutated = beforeValue === '00000' && afterValue !== null && afterValue !== '00000';
      const stillInteresting = mutated
        || (this.beforeDst && this.beforeDst.includes('cch='))
        || (this.beforeSrc && this.beforeSrc.includes('cch='))
        || (this.srcMatch !== null)
        || (this.dstMatch !== null)
        || afterDst.includes('cch=')
        || (afterDstMatch !== null);

      if (!stillInteresting) return;

      if (afterDst.includes('cch=') || afterDstMatch !== null) rememberRange(this.dst.sub(8), Math.min(this.length + 16, 65536), `${name}-dst`);
      emitMutation('copy-observation', {
        api: name,
        dst: this.dst.toString(),
        src: this.src.toString(),
        length: this.length,
        beforeDst: this.beforeDst || '',
        beforeSrc: this.beforeSrc || '',
        afterDst,
        srcExcerpt: this.srcMatch ? this.srcMatch.excerpt : '',
        dstExcerpt: this.dstMatch ? this.dstMatch.excerpt : '',
        afterDstExcerpt: afterDstMatch ? afterDstMatch.excerpt : '',
        mutated,
        returnAddress: this.returnAddressSnapshot.toString(),
        returnRva: rva(this.returnAddressSnapshot),
        returnSymbol: DebugSymbol.fromAddress(this.returnAddressSnapshot).toString(),
        backtrace: this.contextSnapshot,
      });
    },
  });

  emitMutation('hook-installed', { name, address: address.toString() });
}

function hookSnprintfFamily(name) {
  const address = Module.findGlobalExportByName(name) || Module.findGlobalExportByName(`_${name}`);
  if (address === null) return;

  Interceptor.attach(address, {
    onEnter(args) {
      this.contextSnapshot = backtrace(this.context);
      this.returnAddressSnapshot = this.returnAddress;
      this.dst = args[0];
      this.size = maybeNumber(args[1]) ?? 0;
      this.fmt = args[2].isNull() ? '' : readWindow(args[2], 0, 96);
      this.beforeDst = readWindow(this.dst, 8, 64);
      this.interesting = containsRange(this.dst) || this.beforeDst.includes('cch=');
    },
    onLeave(retval) {
      const afterDst = readWindow(this.dst, 8, 64);
      const beforeValue = cchValue(this.beforeDst);
      const afterValue = cchValue(afterDst);
      const mutated = beforeValue === '00000' && afterValue !== null && afterValue !== '00000';
      if (!this.interesting && !mutated && !afterDst.includes('cch=')) return;
      emitMutation('snprintf-observation', {
        api: name,
        dst: this.dst.toString(),
        size: this.size,
        fmt: this.fmt,
        retval: retval.toInt32(),
        beforeDst: this.beforeDst,
        afterDst,
        mutated,
        returnAddress: this.returnAddressSnapshot.toString(),
        returnRva: rva(this.returnAddressSnapshot),
        returnSymbol: DebugSymbol.fromAddress(this.returnAddressSnapshot).toString(),
        backtrace: this.contextSnapshot,
      });
    },
  });

  emitMutation('hook-installed', { name, address: address.toString() });
}

globalThis.UserLogic = {
  onReady(info) {
    installCandidateHooks();
    for (const api of ['memcpy', 'memmove']) hookCopyRoutine(api);
    for (const api of ['snprintf', 'vsnprintf']) hookSnprintfFamily(api);
    emitMutation('mutation-probe-ready', info);
  },
};
