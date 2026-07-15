import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';

const STATE = Symbol.for('claude-code.network-trace.state');
const REQUEST_STATE = Symbol.for('claude-code.network-trace.request');
const SOCKET_STATE = Symbol.for('claude-code.network-trace.socket');

function now() {
  return new Date().toISOString();
}

function sensitiveHeader(name) {
  const normalized = String(name);
  return /^(authorization|proxy-authorization|cookie|set-cookie|x-auth-token)$/i.test(normalized)
    || /(^|[-_])api[-_]?key$/i.test(normalized);
}

function redactText(text, enabled) {
  if (!enabled || typeof text !== 'string') return text;
  return text
    .replace(/(^|\r?\n)(authorization|proxy-authorization|cookie|set-cookie|x-auth-token|[a-z0-9_-]*api[-_]?key)\s*:[^\r\n]*/gi, '$1$2: <redacted>')
    .replace(/(["'](?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)["']\s*:\s*["'])[^"']*/gi, '$1<redacted>');
}

function headerObject(headers, redactSecrets) {
  if (!headers) return {};
  const result = {};
  try {
    if (typeof headers.entries === 'function') {
      for (const [name, value] of headers.entries()) {
        result[name] = redactSecrets && sensitiveHeader(name) ? '<redacted>' : String(value);
      }
      return result;
    }
    if (Array.isArray(headers)) {
      for (let index = 0; index + 1 < headers.length; index += 2) {
        const name = String(headers[index]);
        const value = headers[index + 1];
        result[name] = redactSecrets && sensitiveHeader(name) ? '<redacted>' : String(value);
      }
      return result;
    }
    for (const [name, value] of Object.entries(headers)) {
      result[name] = redactSecrets && sensitiveHeader(name)
        ? '<redacted>'
        : Array.isArray(value) ? value.map(String) : String(value);
    }
  } catch (error) {
    return { '<unreadable>': String(error) };
  }
  return result;
}

function contentType(headers) {
  for (const [name, value] of Object.entries(headers || {})) {
    if (name.toLowerCase() === 'content-type') return Array.isArray(value) ? value.join(';') : String(value);
  }
  return '';
}

function toBuffer(value, encoding) {
  if (value === undefined || value === null) return null;
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, encoding || 'utf8');
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof URLSearchParams) return Buffer.from(value.toString());
  return null;
}

function looksTextual(buffer, type) {
  if (/json|text|xml|javascript|x-www-form-urlencoded|graphql|event-stream/i.test(type || '')) return true;
  if (buffer.length === 0) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 512));
  let printable = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127) || byte >= 0xc2) printable++;
  }
  return printable / sample.length > 0.85;
}

function bodyValue(buffer, type, redactSecrets, totalBytes, truncated) {
  if (!buffer) return { bytes: totalBytes || 0, omitted: true };
  const base = { bytes: totalBytes ?? buffer.length, capturedBytes: buffer.length, truncated: Boolean(truncated) };
  if (looksTextual(buffer, type)) {
    return { ...base, encoding: 'utf8', text: redactText(buffer.toString('utf8'), redactSecrets) };
  }
  return { ...base, encoding: 'base64', data: buffer.toString('base64') };
}

function createCollector(maxBytes) {
  const chunks = [];
  let captured = 0;
  let total = 0;
  let forcedTruncated = false;
  return {
    add(value, encoding) {
      const buffer = toBuffer(value, encoding);
      if (!buffer) return false;
      total += buffer.length;
      if (captured < maxBytes) {
        const part = buffer.subarray(0, maxBytes - captured);
        if (part.length) chunks.push(Buffer.from(part));
        captured += part.length;
      }
      return true;
    },
    markTruncated() {
      forcedTruncated = true;
    },
    finish(type, redactSecrets) {
      return bodyValue(Buffer.concat(chunks), type, redactSecrets, total, forcedTruncated || total > captured);
    },
    get totalBytes() {
      return total;
    },
    get isFull() {
      return captured >= maxBytes;
    },
  };
}

async function readWebStreamIntoCollector(stream, collector) {
  if (!stream || typeof stream.getReader !== 'function') return false;
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      collector.add(value);
      if (collector.isFull) {
        collector.markTruncated();
        try {
          await reader.cancel();
        } catch {}
        break;
      }
    }
    return true;
  } finally {
    try {
      reader.releaseLock?.();
    } catch {}
  }
}

function emitResponseEnd(state, context, responseLike, started, body, extra = {}) {
  state.emit({
    phase: 'response-end',
    layer: 'http',
    transport: context.transport,
    requestId: context.requestId,
    method: context.method,
    url: context.url,
    status: responseLike?.status ?? responseLike?.statusCode,
    statusText: responseLike?.statusText ?? responseLike?.statusMessage,
    durationMs: Number((performance.now() - started).toFixed(3)),
    body,
    ...extra,
  });
}

async function captureFetchResponseBody(response, context, started, state) {
  const collector = createCollector(state.options.maxBodyBytes);
  const rawHeaders = headerObject(response?.headers, false);
  const type = contentType(rawHeaders);

  if (!response) {
    emitResponseEnd(state, context, response, started, { omitted: true, reason: 'no response object' });
    return;
  }

  let clone;
  try {
    clone = typeof response.clone === 'function' ? response.clone() : response;
  } catch (error) {
    emitResponseEnd(state, context, response, started, { omitted: true, reason: String(error) });
    return;
  }

  try {
    if (await readWebStreamIntoCollector(clone.body, collector)) {
      emitResponseEnd(state, context, response, started, collector.finish(type, state.options.redactSecrets));
      return;
    }
    if (typeof clone.arrayBuffer === 'function') {
      collector.add(await clone.arrayBuffer());
      emitResponseEnd(state, context, response, started, collector.finish(type, state.options.redactSecrets));
      return;
    }
    if (typeof clone.text === 'function') {
      collector.add(await clone.text());
      emitResponseEnd(state, context, response, started, collector.finish(type, state.options.redactSecrets));
      return;
    }
    emitResponseEnd(state, context, response, started, { omitted: true, reason: 'unsupported response body type' });
  } catch (error) {
    emitResponseEnd(state, context, response, started, { omitted: true, reason: String(error) });
  }
}

function requestUrl(input, options = {}, defaultProtocol = 'https:') {
  if (typeof input === 'string' || input instanceof URL) return String(input);
  const config = input && typeof input === 'object' ? input : options;
  const protocol = config.protocol || defaultProtocol;
  let hostname = config.hostname || config.host || 'localhost';
  if (hostname.includes(':') && !hostname.startsWith('[') && !/^.+:\d+$/.test(hostname)) hostname = `[${hostname}]`;
  const explicitPort = config.port ? `:${config.port}` : '';
  return `${protocol}//${hostname}${explicitPort}${config.path || config.pathname || '/'}`;
}

function parseNodeRequestArgs(args, protocol) {
  const first = args[0];
  const second = args[1];
  let options = {};
  if (typeof first === 'string' || first instanceof URL) {
    if (second && typeof second === 'object' && typeof second !== 'function') options = second;
  } else if (first && typeof first === 'object') {
    options = first;
  }
  const url = requestUrl(first, options, protocol);
  return {
    url,
    method: String(options.method || 'GET').toUpperCase(),
    headers: options.headers,
  };
}

function socketTarget(args) {
  const first = args[0];
  if (first && typeof first === 'object') {
    return {
      host: first.hostname || first.host || first.servername || first.path,
      port: first.port,
      servername: first.servername,
      localAddress: first.localAddress,
    };
  }
  return { port: first, host: args[1] };
}

function fetchDetails(input, init) {
  const request = typeof Request !== 'undefined' && input instanceof Request ? input : null;
  return {
    url: typeof input === 'string' || input instanceof URL ? String(input) : request?.url || String(input),
    method: String(init?.method || request?.method || 'GET').toUpperCase(),
    headers: init?.headers || request?.headers,
    body: init?.body,
    request,
  };
}

function replaceFunction(owner, name, create) {
  const original = owner?.[name];
  if (typeof original !== 'function') return false;
  const replacement = create(original);
  const descriptor = Object.getOwnPropertyDescriptor(owner, name);
  if (descriptor) Object.defineProperty(owner, name, { ...descriptor, value: replacement });
  else owner[name] = replacement;
  return true;
}

function installRequestBodyCapture(request, context, state) {
  if (!request || request[REQUEST_STATE]) return request;
  request[REQUEST_STATE] = context;
  const collector = createCollector(state.options.maxBodyBytes);
  context.collector = collector;
  let emitted = false;

  const emitRequest = () => {
    if (emitted) return;
    emitted = true;
    state.emit({
      phase: 'request',
      layer: 'http',
      transport: context.transport,
      requestId: context.requestId,
      method: context.method,
      url: context.url,
      headers: headerObject(context.headers, state.options.redactSecrets),
      body: collector.finish(contentType(headerObject(context.headers, false)), state.options.redactSecrets),
    });
  };

  if (typeof request.write === 'function') {
    const originalWrite = request.write;
    request.write = function tracedWrite(chunk, encoding, callback) {
      collector.add(chunk, typeof encoding === 'string' ? encoding : undefined);
      return Reflect.apply(originalWrite, this, arguments);
    };
  }
  if (typeof request.end === 'function') {
    const originalEnd = request.end;
    request.end = function tracedEnd(chunk, encoding, callback) {
      if (chunk !== undefined && typeof chunk !== 'function') {
        collector.add(chunk, typeof encoding === 'string' ? encoding : undefined);
      }
      emitRequest();
      return Reflect.apply(originalEnd, this, arguments);
    };
  }

  request.once?.('response', response => {
    emitRequest();
    const responseCollector = createCollector(state.options.maxBodyBytes);
    const rawResponseHeaders = headerObject(response.headers, false);
    let responseEnded = false;

    if (state.options.captureResponseBodies) {
      response.on?.('data', chunk => {
        responseCollector.add(chunk);
      });
    }

    state.emit({
      phase: 'response',
      layer: 'http',
      transport: context.transport,
      requestId: context.requestId,
      method: context.method,
      url: context.url,
      status: response.statusCode,
      statusMessage: response.statusMessage,
      headers: headerObject(response.headers, state.options.redactSecrets),
      durationMs: Number((performance.now() - context.started).toFixed(3)),
    });

    const finalizeResponse = extra => {
      if (responseEnded) return;
      responseEnded = true;
      emitResponseEnd(
        state,
        context,
        response,
        context.started,
        state.options.captureResponseBodies
          ? responseCollector.finish(contentType(rawResponseHeaders), state.options.redactSecrets)
          : { omitted: true, reason: 'response body capture disabled' },
        extra,
      );
    };

    response.once?.('end', () => finalizeResponse());
    response.once?.('close', () => finalizeResponse({ closed: true }));
  });
  request.once?.('error', error => state.emit({
    phase: 'error',
    layer: 'http',
    transport: context.transport,
    requestId: context.requestId,
    method: context.method,
    url: context.url,
    error: String(error?.stack || error),
    durationMs: Number((performance.now() - context.started).toFixed(3)),
  }));
  request.once?.('close', emitRequest);
  return request;
}

function installNodeHttp(owner, transport, protocol, state) {
  replaceFunction(owner, 'request', original => function tracedRequest(...args) {
    const details = parseNodeRequestArgs(args, protocol);
    const context = {
      ...details,
      transport,
      requestId: state.nextId(),
      started: performance.now(),
    };
    const request = Reflect.apply(original, this, args);
    return installRequestBodyCapture(request, context, state);
  });

  replaceFunction(owner, 'get', original => function tracedGet(...args) {
    const request = Reflect.apply(original, this, args);
    if (request?.[REQUEST_STATE]) return request;
    const details = parseNodeRequestArgs(args, protocol);
    const context = {
      ...details,
      transport: `${transport}.get`,
      requestId: state.nextId(),
      started: performance.now(),
    };
    installRequestBodyCapture(request, context, state);
    context.collector ||= createCollector(state.options.maxBodyBytes);
    state.emit({
      phase: 'request',
      layer: 'http',
      transport: context.transport,
      requestId: context.requestId,
      method: context.method,
      url: context.url,
      headers: headerObject(context.headers, state.options.redactSecrets),
      body: context.collector.finish(contentType(headerObject(context.headers, false)), state.options.redactSecrets),
    });
    return request;
  });
}

function installFetch(state) {
  replaceFunction(globalThis, 'fetch', original => new Proxy(original, {
    apply(target, thisArg, args) {
      const [input, init] = args;
      const details = fetchDetails(input, init);
      const requestId = state.nextId();
      const started = performance.now();
      const headers = headerObject(details.headers, state.options.redactSecrets);
      const rawHeaders = headerObject(details.headers, false);
      const collector = createCollector(state.options.maxBodyBytes);
      const captured = collector.add(details.body);

      const emitFetchRequest = body => state.emit({
        phase: 'request',
        layer: 'http',
        transport: 'fetch',
        requestId,
        method: details.method,
        url: details.url,
        headers,
        body,
      });

      if (captured || details.body === null || details.body === undefined && !details.request?.body) {
        emitFetchRequest(collector.finish(contentType(rawHeaders), state.options.redactSecrets));
      } else if (details.request?.body && typeof details.request.clone === 'function') {
        try {
          details.request.clone().arrayBuffer().then(
            buffer => {
              collector.add(buffer);
              emitFetchRequest(collector.finish(contentType(rawHeaders), state.options.redactSecrets));
            },
            error => emitFetchRequest({ omitted: true, reason: String(error) }),
          );
        } catch (error) {
          emitFetchRequest({ omitted: true, reason: String(error) });
        }
      } else {
        emitFetchRequest({ omitted: true, reason: 'streaming or unsupported body type' });
      }

      let result;
      try {
        result = Reflect.apply(target, thisArg, args);
      } catch (error) {
        state.emit({ phase: 'error', layer: 'http', transport: 'fetch', requestId, method: details.method, url: details.url, error: String(error?.stack || error) });
        throw error;
      }
      Promise.resolve(result).then(
        response => {
          state.emit({
            phase: 'response',
            layer: 'http',
            transport: 'fetch',
            requestId,
            method: details.method,
            url: details.url,
            status: response?.status,
            statusText: response?.statusText,
            headers: headerObject(response?.headers, state.options.redactSecrets),
            durationMs: Number((performance.now() - started).toFixed(3)),
          });
          if (state.options.captureResponseBodies) {
            void captureFetchResponseBody(response, {
              transport: 'fetch',
              requestId,
              method: details.method,
              url: details.url,
            }, started, state);
          } else {
            emitResponseEnd(state, {
              transport: 'fetch',
              requestId,
              method: details.method,
              url: details.url,
            }, response, started, { omitted: true, reason: 'response body capture disabled' });
          }
        },
        error => state.emit({
          phase: 'error',
          layer: 'http',
          transport: 'fetch',
          requestId,
          method: details.method,
          url: details.url,
          error: String(error?.stack || error),
          durationMs: Number((performance.now() - started).toFixed(3)),
        }),
      );
      return result;
    },
  }));
}

function installHttp2(state) {
  replaceFunction(http2, 'connect', original => function tracedHttp2Connect(...args) {
    const origin = String(args[0]);
    const connectionId = state.nextId('h2c');
    state.emit({ phase: 'connect', layer: 'connection', transport: 'http2', connectionId, origin });
    const session = Reflect.apply(original, this, args);
    if (session && typeof session.request === 'function') {
      const originalRequest = session.request;
      session.request = function tracedHttp2Request(headers = {}, options) {
        const requestId = state.nextId();
        const started = performance.now();
        const method = String(headers[':method'] || 'GET');
        const url = new URL(String(headers[':path'] || '/'), origin).toString();
        const stream = Reflect.apply(originalRequest, this, arguments);
        const collector = createCollector(state.options.maxBodyBytes);
        const rawWrite = stream.write;
        const rawEnd = stream.end;
        if (typeof rawWrite === 'function') stream.write = function(chunk, encoding) {
          collector.add(chunk, typeof encoding === 'string' ? encoding : undefined);
          return Reflect.apply(rawWrite, this, arguments);
        };
        if (typeof rawEnd === 'function') stream.end = function(chunk, encoding) {
          if (chunk !== undefined && typeof chunk !== 'function') collector.add(chunk, typeof encoding === 'string' ? encoding : undefined);
          state.emit({
            phase: 'request', layer: 'http', transport: 'http2', connectionId, requestId, method, url,
            headers: headerObject(headers, state.options.redactSecrets),
            body: collector.finish(contentType(headerObject(headers, false)), state.options.redactSecrets),
          });
          return Reflect.apply(rawEnd, this, arguments);
        };
        const responseCollector = createCollector(state.options.maxBodyBytes);
        let responseHeaders = {};
        let responseEnded = false;
        if (state.options.captureResponseBodies) {
          stream.on?.('data', chunk => {
            responseCollector.add(chunk);
          });
        }
        stream.once?.('response', nextResponseHeaders => {
          responseHeaders = nextResponseHeaders || {};
          state.emit({
            phase: 'response', layer: 'http', transport: 'http2', connectionId, requestId, method, url,
            status: responseHeaders[':status'], headers: headerObject(responseHeaders, state.options.redactSecrets),
            durationMs: Number((performance.now() - started).toFixed(3)),
          });
        });
        const finalizeResponse = extra => {
          if (responseEnded) return;
          responseEnded = true;
          emitResponseEnd(
            state,
            { transport: 'http2', requestId, method, url },
            { status: responseHeaders[':status'] },
            started,
            state.options.captureResponseBodies
              ? responseCollector.finish(contentType(headerObject(responseHeaders, false)), state.options.redactSecrets)
              : { omitted: true, reason: 'response body capture disabled' },
            { connectionId, ...extra },
          );
        };
        stream.once?.('end', () => finalizeResponse());
        stream.once?.('close', () => finalizeResponse({ closed: true }));
        stream.once?.('error', error => state.emit({ phase: 'error', layer: 'http', transport: 'http2', connectionId, requestId, error: String(error?.stack || error) }));
        return stream;
      };
    }
    session?.once?.('error', error => state.emit({ phase: 'error', layer: 'connection', transport: 'http2', connectionId, error: String(error?.stack || error) }));
    return session;
  });
}

function installWebSocket(state) {
  replaceFunction(globalThis, 'WebSocket', original => new Proxy(original, {
    construct(target, args, newTarget) {
      const requestId = state.nextId('ws');
      const url = String(args[0]);
      state.emit({ phase: 'request', layer: 'websocket', transport: 'websocket', requestId, method: 'CONNECT', url, protocols: args[1] });
      const socket = Reflect.construct(target, args, newTarget);
      socket.addEventListener?.('open', () => state.emit({ phase: 'response', layer: 'websocket', transport: 'websocket', requestId, status: 101, url }));
      socket.addEventListener?.('close', event => state.emit({ phase: 'close', layer: 'websocket', transport: 'websocket', requestId, url, code: event.code, reason: event.reason }));
      socket.addEventListener?.('error', () => state.emit({ phase: 'error', layer: 'websocket', transport: 'websocket', requestId, url }));
      if (typeof socket.send === 'function') {
        const rawSend = socket.send;
        socket.send = function tracedSend(data) {
          const collector = createCollector(state.options.maxBodyBytes);
          collector.add(data);
          state.emit({ phase: 'send', layer: 'websocket', transport: 'websocket', requestId, url, body: collector.finish('', state.options.redactSecrets) });
          return Reflect.apply(rawSend, this, arguments);
        };
      }
      return socket;
    },
  }));
}

function installSocketWrites(socket, context, state) {
  if (!socket || socket[SOCKET_STATE]) return socket;
  socket[SOCKET_STATE] = context;
  if (state.options.captureSocketWrites && typeof socket.write === 'function') {
    const rawWrite = socket.write;
    socket.write = function tracedSocketWrite(data, encoding) {
      const collector = createCollector(state.options.maxSocketWriteBytes);
      collector.add(data, typeof encoding === 'string' ? encoding : undefined);
      state.emit({
        phase: 'send', layer: 'socket', transport: context.transport,
        connectionId: context.connectionId, target: context.target,
        body: collector.finish('', state.options.redactSecrets),
      });
      return Reflect.apply(rawWrite, this, arguments);
    };
  }
  socket.once?.('connect', () => state.emit({ phase: 'connected', layer: 'connection', transport: context.transport, connectionId: context.connectionId, target: context.target }));
  socket.once?.('secureConnect', () => state.emit({
    phase: 'secure-connected', layer: 'connection', transport: context.transport,
    connectionId: context.connectionId, target: context.target,
    alpnProtocol: socket.alpnProtocol,
    protocol: socket.getProtocol?.(),
    peerCertificateFingerprint256: socket.getPeerCertificate?.()?.fingerprint256,
  }));
  socket.once?.('error', error => state.emit({ phase: 'error', layer: 'connection', transport: context.transport, connectionId: context.connectionId, target: context.target, error: String(error?.stack || error) }));
  socket.once?.('close', hadError => state.emit({ phase: 'close', layer: 'connection', transport: context.transport, connectionId: context.connectionId, target: context.target, hadError }));
  return socket;
}

function installSocketModule(owner, names, transport, state) {
  const proxies = new Map();
  for (const name of names) {
    const original = owner?.[name];
    if (typeof original !== 'function') continue;
    let replacement = proxies.get(original);
    if (!replacement) {
      replacement = function tracedConnect(...args) {
        const connectionId = state.nextId('conn');
        const target = socketTarget(args);
        state.emit({ phase: 'connect', layer: 'connection', transport, connectionId, target });
        const socket = Reflect.apply(original, this, args);
        if (socket && typeof socket.then === 'function') {
          socket.then(value => installSocketWrites(value, { transport, connectionId, target }, state));
        } else {
          installSocketWrites(socket, { transport, connectionId, target }, state);
        }
        return socket;
      };
      proxies.set(original, replacement);
    }
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    if (descriptor) Object.defineProperty(owner, name, { ...descriptor, value: replacement });
    else owner[name] = replacement;
  }
}

function installBunConnect(state) {
  if (!globalThis.Bun) return;
  replaceFunction(globalThis.Bun, 'connect', original => function tracedBunConnect(...args) {
    const connectionId = state.nextId('bun');
    const target = socketTarget(args);
    state.emit({ phase: 'connect', layer: 'connection', transport: 'bun.connect', connectionId, target });
    const result = Reflect.apply(original, this, args);
    Promise.resolve(result).then(
      socket => installSocketWrites(socket, { transport: 'bun.connect', connectionId, target }, state),
      error => state.emit({ phase: 'error', layer: 'connection', transport: 'bun.connect', connectionId, target, error: String(error?.stack || error) }),
    );
    return result;
  });
}

function defaultTraceDirectory() {
  const stateHome = process.env.XDG_STATE_HOME;
  if (stateHome) return path.join(stateHome, 'trace-claude-code');
  const home = process.env.HOME || os.homedir();
  if (home) return path.join(home, '.local', 'state', 'trace-claude-code');
  return path.resolve('trace-claude-code-output');
}

function normalizedOptions(config = {}) {
  return {
    enabled: config.enabled ?? process.env.CLAUDE_NETWORK_TRACE !== '0',
    directory: process.env.CLAUDE_NETWORK_TRACE_DIR || config.directory || defaultTraceDirectory(),
    file: process.env.CLAUDE_NETWORK_TRACE_FILE || config.file,
    maxBodyBytes: Number(process.env.CLAUDE_NETWORK_TRACE_MAX_BODY || config.maxBodyBytes || 2 * 1024 * 1024),
    maxSocketWriteBytes: Number(process.env.CLAUDE_NETWORK_TRACE_MAX_SOCKET_WRITE || config.maxSocketWriteBytes || 256 * 1024),
    captureSocketWrites: config.captureSocketWrites ?? process.env.CLAUDE_NETWORK_TRACE_SOCKET_WRITES === '1',
    captureResponseBodies: config.captureResponseBodies ?? process.env.CLAUDE_NETWORK_TRACE_CAPTURE_RESPONSE_BODIES !== '0',
    redactSecrets: config.redactSecrets ?? process.env.CLAUDE_NETWORK_TRACE_SECRETS !== '1',
    stderr: config.stderr ?? process.env.CLAUDE_NETWORK_TRACE_STDERR === '1',
  };
}

export function installNetworkTrace(config = {}) {
  if (globalThis[STATE]) return globalThis[STATE];
  const options = normalizedOptions(config);
  if (!options.enabled) return { enabled: false };

  fs.mkdirSync(options.directory, { recursive: true });
  const filename = options.file || path.join(options.directory, `claude-network-${Date.now()}-${process.pid}.jsonl`);
  const fd = fs.openSync(filename, 'a');
  let counter = 1;
  const counts = {};
  const state = {
    enabled: true,
    filename,
    options,
    nextId(prefix = 'req') {
      return `${prefix}-${process.pid}-${counter++}`;
    },
    emit(event) {
      const record = { timestamp: now(), pid: process.pid, ...event };
      counts[`${record.layer || 'other'}:${record.phase || 'event'}`] = (counts[`${record.layer || 'other'}:${record.phase || 'event'}`] || 0) + 1;
      try {
        fs.writeSync(fd, `${JSON.stringify(record)}\n`);
        if (options.stderr && (record.phase === 'request' || record.phase === 'error')) {
          console.error(`[network-trace] ${record.phase} ${record.method || ''} ${record.url || JSON.stringify(record.target || '')}`);
        }
      } catch (error) {
        console.error(`[network-trace] write failed: ${String(error)}`);
      }
    },
  };
  globalThis[STATE] = state;

  state.emit({
    phase: 'start',
    layer: 'trace',
    version: process.env.CLAUDE_TRACE_TARGET_VERSION || '2.1.204',
    filename,
    options: { ...options, file: undefined },
  });
  installFetch(state);
  installNodeHttp(http, 'http.request', 'http:', state);
  installNodeHttp(https, 'https.request', 'https:', state);
  installHttp2(state);
  installWebSocket(state);
  installSocketModule(net, ['connect', 'createConnection'], 'net', state);
  installSocketModule(tls, ['connect'], 'tls', state);
  installBunConnect(state);

  process.once('exit', code => {
    state.emit({ phase: 'stop', layer: 'trace', code, counts });
    try { fs.closeSync(fd); } catch {}
  });
  console.error(`[network-trace] active file=${filename}`);
  return state;
}
