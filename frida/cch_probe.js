'use strict';

const cchMain = Process.mainModule;
const cchPattern = '63 63 68 3d'; // cch=
let emitted = false;
let installed = false;

function emitCch(kind, fields) {
  send({ kind, ...fields });
}

function rva(address) {
  if (address.compare(cchMain.base) < 0 || address.compare(cchMain.base.add(cchMain.size)) >= 0) return null;
  return address.sub(cchMain.base).toString();
}

function inspectBuffer(pointer, length, api, context) {
  if (emitted || pointer.isNull() || length < 9 || length > 4 * 1024 * 1024) return;
  let matches;
  try {
    matches = Memory.scanSync(pointer, length, cchPattern);
  } catch (_) {
    return;
  }
  if (matches.length === 0) return;
  emitted = true;
  const hit = matches[0].address;
  let excerpt = '';
  try { excerpt = hit.readUtf8String(Math.min(96, pointer.add(length).sub(hit).toInt32())); } catch (_) {}
  emitCch('cch-wire-write', {
    api,
    buffer: pointer.toString(),
    length,
    hit: hit.toString(),
    excerpt,
    pc: context.pc.toString(),
    lr: context.lr.toString(),
    backtrace: Thread.backtrace(context, Backtracer.ACCURATE).map(address => ({
      address: address.toString(),
      rva: rva(address),
      symbol: DebugSymbol.fromAddress(address).toString(),
    })),
  });
}

function findCchExport(name) {
  return Module.findGlobalExportByName(name) || Module.findGlobalExportByName(`_${name}`);
}

function hookFlatBuffer(name, address, bufferIndex, lengthIndex) {
  Interceptor.attach(address, {
    onEnter(args) {
      inspectBuffer(args[bufferIndex], args[lengthIndex].toInt32(), name, this.context);
    },
  });
  emitCch('cch-io-hook', { name, address: address.toString() });
}

function hookWritev(name, address) {
  Interceptor.attach(address, {
    onEnter(args) {
      const iov = args[1];
      const count = Math.min(args[2].toInt32(), 64);
      for (let index = 0; index < count; index += 1) {
        const item = iov.add(index * Process.pointerSize * 2);
        inspectBuffer(item.readPointer(), item.add(Process.pointerSize).readU64().toNumber(), 'writev', this.context);
      }
    },
  }); 
  emitCch('cch-io-hook', { name, address: address.toString() });
}

function hookSendmsg(name, address) {
  Interceptor.attach(address, {
    onEnter(args) {
      const msg = args[1];
      if (msg.isNull()) return;
      const iov = msg.add(Process.pointerSize * 3).readPointer();
      const count = msg.add(Process.pointerSize * 4).readU32();
      const capped = Math.min(count, 64);
      for (let index = 0; index < capped; index += 1) {
        const item = iov.add(index * Process.pointerSize * 2);
        inspectBuffer(item.readPointer(), item.add(Process.pointerSize).readU64().toNumber(), name, this.context);
      }
    },
  });
  emitCch('cch-io-hook', { name, address: address.toString() });
}

function installHooks() {
  if (installed) return;
  installed = true;

  for (const name of ['write', 'write_nocancel', 'send', 'sendto']) {
    const address = findCchExport(name);
    if (address === null) continue;
    hookFlatBuffer(name, address, 1, 2);
  }

  for (const name of ['writev', 'writev_nocancel']) {
    const address = findCchExport(name);
    if (address === null) continue;
    hookWritev(name, address);
  }

  for (const name of ['sendmsg']) {
    const address = findCchExport(name);
    if (address === null) continue;
    hookSendmsg(name, address);
  }
}

globalThis.UserLogic = {
  onReady(info) {
    installHooks();
    emitCch('cch-probe-ready', info);
  },
};
