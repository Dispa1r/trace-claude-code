'use strict';

const config = globalThis.HookConfig || {};
const user = globalThis.UserLogic || {};
const main = Process.mainModule;

// IDA image base: 0x100000000
// IDA function:   0x102AB0C88
// RVA:            0x02AB0C88
const OFFSETS_BY_VERSION = {
  '2.1.204': {
    internalEvaluate: 0x02ab0c88,
  },
};

function emit(kind, payload = {}) {
  send({ kind, ...payload });
}

function invokeUser(name, payload) {
  const fn = user[name];
  if (typeof fn !== 'function') return;
  try {
    fn(payload);
  } catch (error) {
    emit('user-error', { callback: name, error: String(error), stack: error.stack || '' });
  }
}

function findExport(names) {
  for (const name of names) {
    const local = main.findExportByName(name);
    if (local !== null) return local;
    const global = Module.findGlobalExportByName(name);
    if (global !== null) return global;
  }
  return null;
}

function backtrace(context) {
  if (!config.backtraces) return [];
  return Thread.backtrace(context, Backtracer.ACCURATE)
    .map(DebugSymbol.fromAddress)
    .map(String);
}

function hookDlopen() {
  const address = findExport(['dlopen', '_dlopen']);
  if (address === null) return emit('hook-missing', { name: 'dlopen' });

  Interceptor.attach(address, {
    onEnter(args) {
      this.path = args[0].isNull() ? null : args[0].readUtf8String();
    },
    onLeave(retval) {
      const event = { path: this.path, result: retval.toString() };
      invokeUser('onDlopen', event);
      if (config.verboseDlopen) emit('dlopen', event);
    },
  });
  emit('hook-installed', { name: 'dlopen', address: address.toString() });
}

function hookNapiRunScript() {
  const address = findExport(['napi_run_script', '_napi_run_script']);
  if (address === null) return emit('hook-missing', { name: 'napi_run_script' });

  Interceptor.attach(address, {
    onEnter(args) {
      const event = {
        env: args[0].toString(),
        scriptValue: args[1].toString(),
        resultOut: args[2].toString(),
        returnAddress: this.returnAddress.toString(),
        backtrace: backtrace(this.context),
      };
      invokeUser('onNapiRunScript', event);
      emit('napi-run-script', event);
    },
    onLeave(retval) {
      emit('napi-run-script-result', { status: retval.toInt32() });
    },
  });
  emit('hook-installed', { name: 'napi_run_script', address: address.toString() });
}

function hookInternalEvaluate() {
  if (config.internalEvaluate === false) return;

  const version = config.version || '2.1.204';
  const offsets = OFFSETS_BY_VERSION[version];
  if (offsets === undefined) {
    return emit('hook-skipped', { name: 'internalEvaluate', reason: `unsupported version ${version}` });
  }

  const address = main.base.add(offsets.internalEvaluate);
  Interceptor.attach(address, {
    onEnter(args) {
      const event = {
        address: address.toString(),
        globalObject: args[0].toString(),
        sourceCode: args[1].toString(),
        thisValue: args[2].toString(),
        exceptionOut: args[3].toString(),
        returnAddress: this.returnAddress.toString(),
        threadId: this.threadId,
        backtrace: backtrace(this.context),
      };
      invokeUser('onInternalEvaluate', event);
      if (config.verboseEvaluate) emit('internal-evaluate', event);
    },
  });
  emit('hook-installed', { name: 'internalEvaluate', address: address.toString(), version });
}

function parseSockaddr(pointer) {
  if (pointer.isNull()) return { family: 'null' };
  const length = pointer.readU8();
  const family = pointer.add(1).readU8();

  if (family === 2) {
    const port = (pointer.add(2).readU8() << 8) | pointer.add(3).readU8();
    const ip = [4, 5, 6, 7].map(i => pointer.add(i).readU8()).join('.');
    return { family: 'ipv4', ip, port, length };
  }

  if (family === 30) {
    const port = (pointer.add(2).readU8() << 8) | pointer.add(3).readU8();
    return { family: 'ipv6', port, length };
  }

  if (family === 1) {
    let path = '';
    try { path = pointer.add(2).readUtf8String(); } catch (_) {}
    return { family: 'unix', path, length };
  }

  return { family: `unknown-${family}`, length };
}

function hookConnect() {
  if (config.connect === false) return;
  const address = findExport(['connect', '_connect']);
  if (address === null) return emit('hook-missing', { name: 'connect' });

  Interceptor.attach(address, {
    onEnter(args) {
      const event = {
        fd: args[0].toInt32(),
        address: parseSockaddr(args[1]),
        returnAddress: this.returnAddress.toString(),
      };
      invokeUser('onConnect', event);
      if (config.verboseConnect) emit('connect', event);
    },
  });
  emit('hook-installed', { name: 'connect', address: address.toString() });
}

emit('agent-start', {
  pid: Process.id,
  arch: Process.arch,
  module: main.name,
  path: main.path,
  base: main.base.toString(),
  size: main.size,
});

hookDlopen();
hookNapiRunScript();
hookInternalEvaluate();
hookConnect();

invokeUser('onReady', {
  pid: Process.id,
  arch: Process.arch,
  path: main.path,
  base: main.base.toString(),
});

rpc.exports = {
  info() {
    return {
      pid: Process.id,
      arch: Process.arch,
      path: main.path,
      base: main.base.toString(),
      version: config.version || '2.1.204',
    };
  },
};
