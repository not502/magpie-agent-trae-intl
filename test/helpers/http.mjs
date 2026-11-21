// Loopback-only HTTP helpers for bridge and CLI tests. Everything binds to
// 127.0.0.1 with port 0; no external host is ever contacted.

import http from 'node:http';

/** @param {import('node:http').Server} server */
export function listen(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address());
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, host);
  });
}

/** @param {import('node:http').Server} server */
export function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

/**
 * One HTTP/1.1 request with a fresh non-keepalive socket.
 * @param {number} port
 * @param {{method?: string, path?: string, headers?: Record<string,string|number>, body?: string|Buffer|null}} [options]
 * @returns {Promise<{status: number, headers: import('node:http').IncomingHttpHeaders, text: string, json: () => any}>}
 */
export function request(port, options = {}) {
  return new Promise((resolve, reject) => {
    const headers = { connection: 'close', ...(options.headers ?? {}) };
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: options.method ?? 'GET',
      path: options.path ?? '/health',
      headers,
      agent: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          text,
          json: () => JSON.parse(text),
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (options.body !== undefined && options.body !== null) req.write(options.body);
    req.end();
  });
}

/** Collect a request body into a Buffer. */
export function bodyOf(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/** @param {number} ms */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
