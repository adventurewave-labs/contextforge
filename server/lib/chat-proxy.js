'use strict';

const crypto = require('node:crypto');
const https = require('node:https');
const { pipeline } = require('node:stream/promises');

const CHAT_PATH = '/v1/chat/completions';
const SAFE_RESPONSE_HEADERS = new Set([
  'content-type', 'content-length', 'content-encoding', 'retry-after', 'x-request-id',
  'x-ratelimit-limit-requests', 'x-ratelimit-limit-tokens', 'x-ratelimit-remaining-requests',
  'x-ratelimit-remaining-tokens', 'x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens',
]);
const KEY_PATTERN = /^[!-~]+$/;
const DEFAULT_TIMEOUT = 60_000;

function readConfig(env) {
  const urlValue = env.CONTEXTFORGE_PROXY_UPSTREAM_URL;
  const upstreamKey = env.CONTEXTFORGE_PROXY_UPSTREAM_KEY;
  const clientKey = env.CONTEXTFORGE_PROXY_CLIENT_KEY;
  if (!urlValue && !upstreamKey && !clientKey) return null;
  if (!urlValue || !upstreamKey || !clientKey || upstreamKey === clientKey ||
      !KEY_PATTERN.test(upstreamKey) || !KEY_PATTERN.test(clientKey)) {
    throw new Error('Configure the chat proxy URL and two distinct bearer keys.');
  }

  let url;
  try { url = new URL(urlValue); } catch { /* Report the configuration error without its value. */ }
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.pathname === '/') {
    throw new Error('Configure a complete HTTPS chat endpoint URL with no credentials, query, or fragment.');
  }
  const timeout = Number(env.CONTEXTFORGE_PROXY_TIMEOUT_MS ?? DEFAULT_TIMEOUT);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) {
    throw new Error('Configure a chat proxy timeout between 1 and 120000 milliseconds.');
  }

  return {
    url,
    upstreamKey,
    clientDigest: digest(clientKey),
    timeout,
  };
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest();
}

function authenticates(req, expected) {
  const headers = req.headersDistinct.authorization;
  if (!headers || headers.length !== 1) return false;
  const match = /^Bearer ([!-~]+)$/i.exec(headers[0]);
  return !!match && crypto.timingSafeEqual(digest(match[1]), expected);
}

class RequestError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function readPayload(req, maximum) {
  const tooLarge = () => new RequestError(413, 'Request exceeds the proxy body limit.', 'payload_too_large');
  if (Number(req.headers['content-length']) > maximum) throw tooLarge();
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maximum) throw tooLarge();
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks, size);
  let valid = false;
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    valid = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch { /* Send a stable error rather than the parser's payload excerpt. */ }
  if (!valid) throw new RequestError(400, 'Expected a UTF-8 JSON object.', 'invalid_json');
  return body;
}

function connect(config, body, signal) {
  return new Promise((resolve, reject) => {
    const upstream = https.request(config.url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + config.upstreamKey,
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        Accept: 'application/json, text/event-stream',
        'Accept-Encoding': 'identity',
      },
      signal,
    }, resolve);
    upstream.once('error', reject);
    upstream.end(body);
  });
}

function createChatProxy(env, { maxBody, checkRate, send }) {
  const config = readConfig(env);
  function reject(res, status, message, code, headers = {}) {
    const type = status === 401 ? 'authentication_error'
      : status === 429 ? 'rate_limit_error'
      : status >= 500 ? 'api_error' : 'invalid_request_error';
    return send(res, status, { error: { message, type, param: null, code } }, {
      'Cache-Control': 'no-store',
      // Errors can be sent before consuming a client request body.
      Connection: 'close',
      ...headers,
    });
  }

  return async function handleChatProxy(req, res) {
    if (!config) return reject(res, 404, 'Chat proxy is unavailable.', 'not_found');
    if (req.method !== 'POST') {
      return reject(res, 405, 'Use POST for chat completions.', 'method_not_allowed', { Allow: 'POST' });
    }
    const authorized = authenticates(req, config.clientDigest);
    const rate = checkRate(req, authorized);
    if (rate.limited) {
      return reject(res, 429, 'Proxy rate limit exceeded.', 'rate_limit_exceeded', {
        'Retry-After': String(Math.max(1, Math.ceil(rate.resetMs / 1000))),
      });
    }

    if (!authorized) {
      return reject(res, 401, 'A valid proxy bearer key is required.', 'invalid_api_key', {
        'WWW-Authenticate': 'Bearer',
      });
    }
    const type = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
    const encoding = req.headers['content-encoding'];
    if (type !== 'application/json' || (encoding && encoding.toLowerCase() !== 'identity')) {
      return reject(res, 415, 'Use an uncompressed application/json request.', 'unsupported_media_type');
    }

    const controller = new AbortController();
    const disconnect = () => {
      if (!res.writableFinished) controller.abort();
    };
    res.on('close', disconnect);
    let timer;
    let timedOut = false;
    try {
      const body = await readPayload(req, maxBody);
      if (controller.signal.aborted) return;
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, config.timeout);
      const upstream = await connect(config, body, controller.signal);
      for (const [name, value] of Object.entries(upstream.headers)) {
        if (SAFE_RESPONSE_HEADERS.has(name)) res.setHeader(name, value);
      }
      res.setHeader('Cache-Control', 'no-store');
      res.statusCode = upstream.statusCode;
      res.flushHeaders();
      await pipeline(upstream, res, { signal: controller.signal });
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) return res.destroy();
      if (error instanceof RequestError) return reject(res, error.status, error.message, error.code);
      if (timedOut) return reject(res, 504, 'The upstream request timed out.', 'upstream_timeout');
      return reject(res, 502, 'The upstream connection failed.', 'upstream_connection_error');
    } finally {
      clearTimeout(timer);
      res.off('close', disconnect);
    }
  };
}

module.exports = { CHAT_PATH, createChatProxy };
