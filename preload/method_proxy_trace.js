import { createRequire, syncBuiltinESMExports } from 'node:module';

const requireForTrace = createRequire(import.meta.url);
const TRACE_MARK = Symbol.for('claude-code.method-proxy-trace');
const DEFAULT_LIMITS = Object.freeze({
  depth: 4,
  keys: 40,
  array: 12,
  string: 300,
  bytes: 96,
});

let nextCallId = 1;

function truncate(value, limit) {
  return value.length <= limit ? value : `${value.slice(0, limit)}…<${value.length - limit} more>`;
}

function sensitiveKey(key) {
  return /(authorization|proxy.authoriz|cookie|api.?key|token|password|passwd|secret|private.?key|credential)/i.test(String(key));
}

function bulkySecurityKey(key) {
  return /^(ca|cert|certificate|certificates|pfx|secureContext)$/i.test(String(key));
}

function bodyKey(key) {
  return /^(body|prompt|messages|content)$/i.test(String(key));
}

function snapshotHeaders(headers) {
  const result = {};
  try {
    for (const [key, value] of headers.entries()) {
      result[key] = sensitiveKey(key) ? '<redacted>' : truncate(String(value), 200);
    }
  } catch {
    return '<unreadable Headers>';
  }
  return result;
}

function snapshot(value, options, depth = 0, seen = new WeakSet(), propertyKey = '') {
  if (sensitiveKey(propertyKey)) return '<redacted>';
  if (bulkySecurityKey(propertyKey)) return '<TLS material omitted>';
  if (bodyKey(propertyKey) && !options.captureBody) return '<body omitted; set CLAUDE_HOOK_TRACE_BODY=1>';
  if (value === null || value === undefined) return value;

  const type = typeof value;
  if (type === 'string') return truncate(value, options.limits.string);
  if (type === 'number' || type === 'boolean') return value;
  if (type === 'bigint') return `${value}n`;
  if (type === 'symbol') return String(value);
  if (type === 'function') return `[Function ${value.name || '<anonymous>'}]`;
  if (depth >= options.limits.depth) return `[${value?.constructor?.name || 'Object'} depth-limit]`;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (value instanceof URL) return value.toString();
  if (value instanceof Error) {
    return {
      type: value.constructor?.name || 'Error',
      name: value.name,
      message: truncate(String(value.message || ''), options.limits.string),
      stack: options.captureStack ? truncate(String(value.stack || ''), 2000) : undefined,
    };
  }
  if (typeof Headers !== 'undefined' && value instanceof Headers) {
    return { type: 'Headers', values: snapshotHeaders(value) };
  }
  if (typeof Request !== 'undefined' && value instanceof Request) {
    return {
      type: 'Request',
      method: value.method,
      url: value.url,
      headers: snapshotHeaders(value.headers),
      bodyUsed: value.bodyUsed,
    };
  }
  if (typeof Response !== 'undefined' && value instanceof Response) {
    return {
      type: 'Response',
      status: value.status,
      statusText: value.statusText,
      url: value.url,
      redirected: value.redirected,
      bodyUsed: value.bodyUsed,
      headers: snapshotHeaders(value.headers),
    };
  }
  if (ArrayBuffer.isView(value)) {
    const length = Math.min(value.byteLength, options.limits.bytes);
    const bytes = new Uint8Array(value.buffer, value.byteOffset, length);
    return {
      type: value.constructor?.name || 'TypedArray',
      byteLength: value.byteLength,
      previewHex: Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(''),
    };
  }
  if (value instanceof ArrayBuffer) {
    return { type: 'ArrayBuffer', byteLength: value.byteLength };
  }
  if (Array.isArray(value)) {
    const result = value.slice(0, options.limits.array)
      .map((item, index) => snapshot(item, options, depth + 1, seen, index));
    if (value.length > options.limits.array) result.push(`<${value.length - options.limits.array} more items>`);
    return result;
  }
  if (value instanceof Map) {
    return {
      type: 'Map',
      size: value.size,
      entries: Array.from(value.entries()).slice(0, options.limits.keys)
        .map(([key, item]) => [
          snapshot(key, options, depth + 1, seen),
          snapshot(item, options, depth + 1, seen),
        ]),
    };
  }
  if (value instanceof Set) {
    return {
      type: 'Set',
      size: value.size,
      values: Array.from(value.values()).slice(0, options.limits.keys)
        .map(item => snapshot(item, options, depth + 1, seen)),
    };
  }

  const result = { type: value.constructor?.name || 'Object' };
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return `[${result.type} properties-unavailable]`;
  }

  const entries = Reflect.ownKeys(descriptors).slice(0, options.limits.keys);
  for (const key of entries) {
    const outputKey = typeof key === 'symbol' ? String(key) : key;
    const descriptor = descriptors[key];
    if ('value' in descriptor) {
      result[outputKey] = snapshot(descriptor.value, options, depth + 1, seen, outputKey);
    } else {
      result[outputKey] = '<accessor not invoked>';
    }
  }
  if (Reflect.ownKeys(descriptors).length > entries.length) {
    result['<truncated>'] = `${Reflect.ownKeys(descriptors).length - entries.length} more properties`;
  }
  return result;
}

function emit(event) {
  try {
    console.error(`[method-trace] ${JSON.stringify(event)}`);
  } catch (error) {
    console.error(`[method-trace] serialization failed: ${String(error)}`);
  }
}

function observeThenable(result, context) {
  let then;
  try {
    then = result?.then;
  } catch {
    return false;
  }
  if (typeof then !== 'function') return false;

  try {
    Reflect.apply(then, result, [
      value => {
        emit({
          phase: 'resolve',
          ...context.base,
          durationMs: Number((performance.now() - context.started).toFixed(3)),
          result: snapshot(value, context.options),
        });
      },
      error => {
        emit({
          phase: 'reject',
          ...context.base,
          durationMs: Number((performance.now() - context.started).toFixed(3)),
          error: snapshot(error, context.options),
        });
      },
    ]);
  } catch (error) {
    emit({ phase: 'observe-error', ...context.base, error: snapshot(error, context.options) });
  }
  return true;
}

function createMethodProxy(original, label, options) {
  if (original?.[TRACE_MARK]) return original;

  const proxy = new Proxy(original, {
    apply(target, thisArg, args) {
      const callId = `${process.pid}-${nextCallId++}`;
      const started = performance.now();
      const base = { callId, method: label };
      emit({
        phase: 'enter',
        ...base,
        args: snapshot(args, options),
        thisValue: options.captureThis ? snapshot(thisArg, options) : undefined,
        stack: options.captureStack ? new Error().stack : undefined,
      });

      let result;
      try {
        result = Reflect.apply(target, thisArg, args);
      } catch (error) {
        emit({
          phase: 'throw',
          ...base,
          durationMs: Number((performance.now() - started).toFixed(3)),
          error: snapshot(error, options),
        });
        throw error;
      }

      const context = { base, started, options };
      if (observeThenable(result, context)) {
        emit({ phase: 'return-promise', ...base });
      } else {
        emit({
          phase: 'return',
          ...base,
          durationMs: Number((performance.now() - started).toFixed(3)),
          result: snapshot(result, options),
        });
      }
      return result;
    },

    construct(target, args, newTarget) {
      const callId = `${process.pid}-${nextCallId++}`;
      const started = performance.now();
      const base = { callId, method: label, construct: true };
      emit({ phase: 'enter', ...base, args: snapshot(args, options) });
      try {
        const result = Reflect.construct(target, args, newTarget);
        emit({
          phase: 'return',
          ...base,
          durationMs: Number((performance.now() - started).toFixed(3)),
          result: snapshot(result, options),
        });
        return result;
      } catch (error) {
        emit({
          phase: 'throw',
          ...base,
          durationMs: Number((performance.now() - started).toFixed(3)),
          error: snapshot(error, options),
        });
        throw error;
      }
    },
  });

  Object.defineProperty(proxy, TRACE_MARK, { value: { original, label } });
  return proxy;
}

function pathParts(path) {
  if (Array.isArray(path)) return path;
  return String(path || '').split('.').filter(Boolean);
}

function resolvePath(root, path) {
  const parts = pathParts(path);
  let value = root;
  for (const part of parts) value = value?.[part];
  return value;
}

function replaceMethod(root, path, label, options) {
  const parts = pathParts(path);
  if (parts.length === 0) throw new Error('method path is empty');
  const key = parts.pop();
  const owner = resolvePath(root, parts);
  if (owner === null || owner === undefined) throw new Error(`owner for ${label} was not found`);

  const original = owner[key];
  if (typeof original !== 'function') throw new Error(`${label} is ${typeof original}, not a function`);
  const proxy = createMethodProxy(original, label, options);
  if (proxy === original) return { label, status: 'already-installed' };

  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  if (descriptor && !descriptor.configurable && descriptor.writable === false) {
    throw new Error(`${label} is not configurable or writable`);
  }
  if (descriptor) {
    Object.defineProperty(owner, key, { ...descriptor, value: proxy });
  } else {
    owner[key] = proxy;
  }
  return { label, status: 'installed' };
}

function traceOptions(target = {}) {
  return {
    captureBody: target.captureBody ?? process.env.CLAUDE_HOOK_TRACE_BODY === '1',
    captureStack: target.captureStack ?? process.env.CLAUDE_HOOK_TRACE_STACK === '1',
    captureThis: target.captureThis ?? process.env.CLAUDE_HOOK_TRACE_THIS === '1',
    limits: {
      ...DEFAULT_LIMITS,
      ...(target.limits || {}),
    },
  };
}

function environmentTargets(defaultTargets) {
  const encoded = process.env.CLAUDE_HOOK_TRACE_TARGETS;
  if (!encoded) return defaultTargets;
  const parsed = JSON.parse(encoded);
  if (!Array.isArray(parsed)) throw new Error('CLAUDE_HOOK_TRACE_TARGETS must be a JSON array');
  return parsed;
}

export function installTraceTargets(defaultTargets = []) {
  let targets;
  try {
    targets = environmentTargets(defaultTargets);
  } catch (error) {
    emit({ phase: 'configuration-error', error: String(error) });
    return [];
  }

  const results = [];
  for (const target of targets) {
    const label = target.label || (target.module
      ? `${target.module}#${target.path}`
      : `${target.object || 'globalThis'}.${target.path}`);
    try {
      let root;
      if (target.module) {
        root = requireForTrace(target.module);
      } else if (!target.object || target.object === 'globalThis') {
        root = globalThis;
      } else {
        root = resolvePath(globalThis, target.object);
      }
      const result = replaceMethod(root, target.path, label, traceOptions(target));
      if (target.module?.startsWith('node:')) syncBuiltinESMExports();
      results.push(result);
      emit({ phase: 'installed', ...result });
    } catch (error) {
      const result = { label, status: 'failed', error: String(error) };
      results.push(result);
      emit({ phase: 'install-error', ...result });
    }
  }
  return results;
}
