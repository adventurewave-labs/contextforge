'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const PROJECT = path.resolve(__dirname, '..');
const CHAT = '/v1/chat/completions';
const UPSTREAM_PATH = '/fixture' + CHAT;
const PRICE_MESSAGE = 'Keep the total of $314.15 for the café order.';
const TEMPLATE = {
  model: 'fixture',
  messages: [{ role: 'user', content: PRICE_MESSAGE }],
  tools: [{
    type: 'function',
    function: { name: 'charge', parameters: { type: 'object', properties: { total: { type: 'number' } } } },
  }],
  tool_choice: 'auto',
};
const usage = { prompt_tokens: 20, completion_tokens: 7, total_tokens: 27 };
const tool = {
  id: 'call_fixture', type: 'function', function: { name: 'charge', arguments: '{"total":314.15}' },
};
const completion = {
  id: 'chatcmpl-fixture', object: 'chat.completion', created: 1700000000, model: 'fixture',
  choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [tool] } }],
  usage,
};
function event(choices, tokens) {
  const data = { ...completion, object: 'chat.completion.chunk', choices };
  if (tokens === undefined) delete data.usage;
  else data.usage = tokens;
  return 'data: ' + JSON.stringify(data) + '\n\n';
}
const STREAM = [
  event([{ index: 0, delta: { role: 'assistant', content: 'Café' }, finish_reason: null }]),
  event([{ index: 0, delta: { tool_calls: [{ index: 0, ...tool }] }, finish_reason: null }]),
  event([{ index: 0, delta: {}, finish_reason: 'tool_calls' }]),
  event([], usage),
  'data: [DONE]\n\n',
];

async function until(predicate, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < end, 'Waiting for test fixture timed out.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function startProxy(t, env) {
  const child = spawn(process.execPath, ['-e', [
    "const {server} = require('./server/index.js');",
    "server.listen(0, '127.0.0.1', () => console.log('TEST_PORT=' + server.address().port));",
  ].join(' ')], {
    cwd: PROJECT, env: { ...process.env, CONTEXTFORGE_DB: ':memory:', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  });
  return { child, readOutput: () => output };
}

async function baseUrl(server) {
  await until(() => /TEST_PORT=\d+/.test(server.readOutput()) || server.child.exitCode !== null);
  const match = /TEST_PORT=(\d+)/.exec(server.readOutput());
  assert.ok(match, 'Proxy did not start: ' + server.readOutput());
  return 'http://127.0.0.1:' + match[1];
}

test('chat proxy wire and SDK contracts', { timeout: 40_000 }, async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'contextforge-chat-proxy-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const cert = path.join(folder, 'cert.pem');
  const key = path.join(folder, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });

  const clientKey = 'client-fixture-' + randomUUID();
  const upstreamKey = 'provider-fixture-' + randomUUID();
  const calls = [];
  let releaseStream;
  const upstream = https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const { model, stream } = JSON.parse(body);
    const record = { body, path: req.url, headers: req.headers, model, closed: false };
    calls.push(record);
    res.on('close', () => { record.closed = true; });
    res.setHeader('X-Request-ID', 'req_fixture_001');
    res.setHeader('Set-Cookie', 'upstream-only=1');
    if (model === 'stall-before-headers') return;
    if (model === 'redirect') {
      res.writeHead(307, { Location: 'https://example.invalid/redirected' }).end();
      return;
    }
    if (model === 'limited' || model === 'unavailable') {
      res.writeHead(model === 'limited' ? 429 : 503, {
        'Content-Type': 'application/json', 'Retry-After': '7', 'X-RateLimit-Remaining-Requests': '0',
      }).end(JSON.stringify({ error: { message: 'fixture failure', type: 'api_error' } }));
      return;
    }
    if (!stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(completion));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const first = Buffer.from(STREAM[0]);
    const offset = first.indexOf(Buffer.from('é')) + 1;
    res.write(first.subarray(0, offset));
    res.write(first.subarray(offset));
    if (model === 'raw-stream') {
      releaseStream = () => res.end(STREAM.slice(1).join(''));
    } else if (model !== 'stall-after-event') {
      setTimeout(() => res.end(STREAM.slice(1).join('')), 40).unref();
    }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    upstream.closeAllConnections();
    return new Promise(resolve => upstream.close(resolve));
  });

  const configured = {
    CONTEXTFORGE_PROXY_UPSTREAM_URL: 'https://127.0.0.1:' + upstream.address().port + UPSTREAM_PATH,
    CONTEXTFORGE_PROXY_CLIENT_KEY: clientKey,
    CONTEXTFORGE_PROXY_UPSTREAM_KEY: upstreamKey,
    CONTEXTFORGE_PROXY_TIMEOUT_MS: '2500',
    NODE_EXTRA_CA_CERTS: cert,
    RATE_LIMIT_MAX: '40',
  };
  const proxy = startProxy(t, configured);
  const address = await baseUrl(proxy);
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + clientKey };
  const send = (body = TEMPLATE, options = {}) => fetch(address + CHAT, {
    method: 'POST', body: JSON.stringify(body), headers, redirect: 'manual', ...options,
  });

  await t.test('disabled and unauthenticated requests never dispatch', async tt => {
    const disabled = startProxy(tt, {
      CONTEXTFORGE_PROXY_UPSTREAM_URL: '', CONTEXTFORGE_PROXY_CLIENT_KEY: '', CONTEXTFORGE_PROXY_UPSTREAM_KEY: '',
    });
    const before = calls.length;
    assert.equal((await fetch(await baseUrl(disabled) + CHAT, { method: 'POST' })).status, 404);
    const denied = await send(TEMPLATE, { headers: { 'Content-Type': 'application/json' } });
    assert.equal(denied.status, 401);
    assert.equal((await denied.json()).error.code, 'invalid_api_key');
    assert.equal((await send(TEMPLATE, { headers: { ...headers, 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await send(TEMPLATE, { body: '{"messages":' })).status, 400);
    const announcedTooLarge = await new Promise((resolve, reject) => {
      const req = http.request(address + CHAT, {
        method: 'POST', headers: { ...headers, 'Content-Length': 8 * 1024 * 1024 + 1 },
      }, res => { res.resume(); resolve(res.statusCode); });
      req.once('error', reject);
      req.end();
    });
    assert.equal(announcedTooLarge, 413);
    assert.equal(calls.length, before);
  });

  await t.test('exact JSON bytes with fixed upstream credentials and headers', async () => {
    const raw = Buffer.from(' \n' + JSON.stringify(TEMPLATE, null, 2) + '\n');
    const response = await send(TEMPLATE, {
      body: raw,
      headers: {
        ...headers, 'Host': 'caller.example.invalid', 'X-Upstream-URL': 'https://example.invalid/',
        'X-Request-ID': clientKey, 'X-Private-Fixture': PRICE_MESSAGE.replace('é', 'e'),
      },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-request-id'), 'req_fixture_001');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), completion);
    const call = calls.at(-1);
    assert.deepEqual(call.body, raw);
    assert.equal(call.path, UPSTREAM_PATH);
    assert.equal(call.headers.authorization, 'Bearer ' + upstreamKey);
    assert.equal(call.headers.host, '127.0.0.1:' + upstream.address().port);
    assert.equal(call.headers['x-private-fixture'], undefined);
    assert.equal(call.headers['x-request-id'], undefined);
  });

  await t.test('streams bytes before upstream completion with intact usage and termination', async () => {
    const response = await send({ ...TEMPLATE, model: 'raw-stream', stream: true, stream_options: { include_usage: true } });
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.ok(first.value.length > 0);
    assert.equal(calls.at(-1).closed, false);
    releaseStream();
    const chunks = [Buffer.from(first.value)];
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      chunks.push(Buffer.from(chunk.value));
    }
    assert.deepEqual(Buffer.concat(chunks), Buffer.from(STREAM.join('')));
  });

  await t.test('preserves error responses and strips redirect targets', async () => {
    for (const [model, status] of [['limited', 429], ['unavailable', 503]]) {
      const response = await send({ ...TEMPLATE, model });
      assert.equal(response.status, status);
      assert.equal(response.headers.get('retry-after'), '7');
      assert.equal(response.headers.get('x-ratelimit-remaining-requests'), '0');
      assert.deepEqual(await response.json(), { error: { message: 'fixture failure', type: 'api_error' } });
    }
    const response = await send({ ...TEMPLATE, model: 'redirect' });
    assert.equal(response.status, 307);
    assert.equal(response.headers.get('location'), null);
  });

  await t.test('upstream timeout before response and after partial SSE', async () => {
    const response = await send({ ...TEMPLATE, model: 'stall-before-headers' });
    assert.equal(response.status, 504);
    assert.equal((await response.json()).error.code, 'upstream_timeout');
    await until(() => calls.at(-1).closed);
    const streaming = await send({ ...TEMPLATE, model: 'stall-after-event', stream: true });
    const reader = streaming.body.getReader();
    assert.equal((await reader.read()).done, false);
    // A partial UTF-8 token can leave an additional buffered read.
    await assert.rejects(async () => { while (!(await reader.read()).done) { /* drain */ } });
    await until(() => calls.at(-1).closed);
  });

  await t.test('client cancellation closes the upstream stream', async () => {
    const controller = new AbortController();
    const response = await send({ ...TEMPLATE, model: 'stall-after-event', stream: true },
      { signal: controller.signal });
    const reader = response.body.getReader();
    await reader.read();
    controller.abort();
    await until(() => calls.at(-1).closed, 1500);
  });

  await t.test('denied requests have a rate limit separate from the authorized requests', async tt => {
    const low = await baseUrl(startProxy(tt, { ...configured, RATE_LIMIT_MAX: '1' }));
    const post = provided => fetch(low + CHAT, { method: 'POST', body: JSON.stringify(TEMPLATE), headers: provided });
    const before = calls.length;
    assert.equal((await post({ 'Content-Type': 'application/json' })).status, 401);
    const denied = await post({ 'Content-Type': 'application/json' });
    assert.equal(denied.status, 429);
    assert.ok(denied.headers.get('retry-after'));
    assert.equal(calls.length, before);
    assert.equal((await post(headers)).status, 200);
    assert.equal((await post(headers)).status, 429);
    assert.equal(calls.length, before + 1);
  });

  await t.test('stock Node and Python SDKs handle chat completion and streaming',
    { skip: process.env.CONTEXTFORGE_TEST_SDKS !== '1' }, async () => {
      const { OpenAI } = require('openai');
      const client = new OpenAI({ baseURL: address + '/v1', apiKey: clientKey, maxRetries: 0, timeout: 5000 });
      const before = calls.length;
      const output = await client.chat.completions.create(TEMPLATE);
      assert.equal(output.choices[0].finish_reason, 'tool_calls');
      assert.deepEqual(output.choices[0].message.tool_calls, [tool]);
      assert.deepEqual(output.usage, usage);
      const stream = await client.chat.completions.create({ ...TEMPLATE, stream: true, stream_options: { include_usage: true } });
      const events = [];
      for await (const data of stream) events.push(data);
      assert.equal(events[0].choices[0].delta.content, 'Café');
      assert.equal(events[1].choices[0].delta.tool_calls[0].function.arguments, tool.function.arguments);
      assert.deepEqual(events.at(-1).usage, usage);
      await new Promise((resolve, reject) => {
        const python = spawn(process.env.CONTEXTFORGE_TEST_PYTHON || 'python3',
          [path.join(__dirname, 'chat-proxy-sdk.py')], {
            env: { ...process.env, NO_PROXY: '127.0.0.1', TEST_PROXY_URL: address + '/v1',
              TEST_PROXY_KEY: clientKey, TEST_PROXY_REQUEST: JSON.stringify(TEMPLATE) },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        let output = '';
        python.stdout.on('data', chunk => { output += chunk; });
        python.stderr.on('data', chunk => { output += chunk; });
        python.once('error', reject);
        python.once('close', code => code === 0 ? resolve() : reject(new Error(output)));
      });
      const forwarded = calls.slice(before);
      assert.equal(forwarded.length, 4);
      for (const [i, call] of forwarded.entries()) {
        const input = JSON.parse(call.body);
        assert.deepEqual(input.messages, TEMPLATE.messages);
        assert.deepEqual(input.tools, TEMPLATE.tools);
        if (i % 2 === 1) assert.deepEqual(input.stream_options, { include_usage: true });
      }
    });

  await t.test('access logs contain correlation data without fixture content or credentials', async () => {
    await until(() => proxy.readOutput().includes('"upstreamReqId":"req_fixture_001"'));
    const log = proxy.readOutput();
    assert.match(log, /"msg":"access".*?"path":"\/v1\/chat\/completions"/);
    for (const privateValue of [clientKey, upstreamKey, PRICE_MESSAGE, '$314.15']) {
      assert.ok(!log.includes(privateValue), 'Unexpected private fixture data in access log.');
    }
  });
});
