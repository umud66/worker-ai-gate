import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import gateway from '../src/index.js';

function sqliteBinding(migrated = true) {
  const db = new DatabaseSync(':memory:');
  if (migrated) db.exec(readFileSync(new URL('../migrations/0001_gateway.sql', import.meta.url), 'utf8'));
  return {
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        bind(...args) {
          return {
            first: async () => statement.get(...args) ?? null,
            all: async () => ({ results: statement.all(...args) }),
            run: async () => ({ meta: statement.run(...args) }),
          };
        },
        all: async () => ({ results: statement.all() }),
      };
    },
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    db,
  };
}

const endpoint = 'https://worker.example';
const password = '测试密码 example';
const supported = '@cf/google/gemma-4-26b-a4b-it';

function request(env, path, method = 'GET', body, extraHeaders = {}) {
  const headers = new Headers(extraHeaders);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return gateway.fetch(new Request(endpoint + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
}

async function loginAsAdmin(env) {
  const response = await request(env, '/api/auth/challenge', 'POST', {});
  assert.equal(response.status, 200);
  const { challenge } = await response.json();
  const key = createHash('md5').update(password).digest();
  const proof = createHmac('sha256', key).update(`stockwatch-login:${challenge}`).digest('hex');
  const input = { challenge, proof };
  const confirmed = await request(env, '/api/auth/login', 'POST', input);
  assert.equal(confirmed.status, 204);
  assert.equal((await request(env, '/api/auth/login', 'POST', input)).status, 401);
  const cookie = confirmed.headers.get('Set-Cookie');
  assert.match(cookie, /HttpOnly; SameSite=Strict; Secure/);
  return { Cookie: cookie.split(';')[0] };
}

test('login identifies missing D1 binding and an unmigrated database', async () => {
  const env = { ADMIN_PASSWORD: password };
  const unbound = await request(env, '/api/auth/challenge', 'POST', {});
  assert.equal(unbound.status, 503);
  assert.match((await unbound.json()).error.message, /绑定为 DB/);

  const DB = sqliteBinding(false);
  try {
    const unmigrated = await request({ ...env, DB }, '/api/auth/challenge', 'POST', {});
    assert.equal(unmigrated.status, 503);
    assert.match((await unmigrated.json()).error.message, /缺少网关数据表.*npm run build/);
  } finally {
    DB.db.close();
  }
});

test('keys are created, used only for allowed models, counted, then immediately revoked', async () => {
  const called = [];
  const env = {
    ADMIN_PASSWORD: password,
    DB: sqliteBinding(),
    ASSETS: { fetch: async (req) => new Response(new URL(req.url).pathname) },
    AI: { run: async (model, options) => {
      called.push({ model, options });
      return { choices: [{ message: { content: '会议摘要示例' } }], usage: { prompt_tokens: 30, completion_tokens: 20 } };
    } },
  };
  assert.equal(await (await request(env, '/')).text(), '/login.html');
  assert.equal((await request(env, '/api/keys')).status, 401);
  const headers = await loginAsAdmin(env);
  assert.equal(await (await request(env, '/', 'GET', undefined, headers)).text(), '/keys.html');
  const created = await request(env, '/api/keys', 'POST', { name: '文档服务' }, headers);
  assert.equal(created.status, 201);
  const key = await created.json();
  assert.match(key.key, /^sw_[0-9a-f]{64}$/);
  const stored = env.DB.db.prepare('SELECT digest FROM api_keys').get();
  assert.equal(stored.digest, createHash('sha256').update(key.key).digest('hex'));
  const bearer = { Authorization: `Bearer ${key.key}` };
  const models = await (await request(env, '/v1/models', 'GET', undefined, bearer)).json();
  assert.ok(models.data.some((model) => model.id === supported));
  assert.ok(models.data.every((model) => !model.id.includes('kimi')));
  const messages = [{ role: 'system', content: '请用三句总结。' }, { role: 'user', content: '会议纪要：下周提交原型。' }];
  const payload = { model: supported, temperature: .7, max_completion_tokens: 5000, messages };
  const paid = { ...payload, model: '@cf/moonshotai/kimi-k2.7-code' };
  assert.equal((await request(env, '/v1/chat/completions', 'POST', paid, bearer)).status, 400);
  const response = await request(env, '/v1/chat/completions', 'POST', payload, bearer);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.choices[0].message.content, '会议摘要示例');
  assert.equal(result.usage.total_tokens, 50);
  assert.equal(called.length, 1);
  assert.equal(called[0].options.max_tokens, 800);
  assert.equal(called[0].options.temperature, .7);
  assert.deepEqual(called[0].options.messages, messages);
  const translated = await request(env, '/v1/chat/completions', 'POST', {
    model: supported, messages: [{ role: 'user', content: '把你好翻译成法语。' }],
  }, bearer);
  assert.equal(translated.status, 200);
  assert.equal('temperature' in called[1].options, false);
  const listed = await (await request(env, '/api/keys', 'GET', undefined, headers)).json();
  assert.equal(listed.keys[0].requests, 2);
  assert.equal(listed.keys[0].successes, 2);
  assert.equal(listed.keys[0].input_tokens, 60);
  assert.equal(listed.keys[0].output_tokens, 40);
  assert.equal(JSON.stringify(listed).includes(key.key), false);
  assert.equal((await request(env, `/api/keys/${key.id}/revoke`, 'POST', {}, headers)).status, 204);
  assert.equal((await request(env, '/v1/models', 'GET', undefined, bearer)).status, 401);
  assert.equal((await request(env, '/api/auth/logout', 'POST', {}, headers)).status, 204);
  assert.equal((await request(env, '/api/keys', 'GET', undefined, headers)).status, 401);
});

test('streaming forwards text before completion and records only completed responses', { timeout: 5000 }, async (t) => {
  const DB = sqliteBinding();
  t.after(() => DB.db.close());
  let upstream;
  const env = {
    DB, ADMIN_PASSWORD: password,
    AI: { run: async (_model, options) => {
      assert.equal(options.stream, true);
      assert.equal(options.stream_options.include_usage, true);
      return new ReadableStream({ start(controller) { upstream = controller; } });
    } },
  };
  const headers = await loginAsAdmin(env);
  const created = await request(env, '/api/keys', 'POST', { name: '流式测试' }, headers);
  const { key } = await created.json();
  const bearer = { Authorization: `Bearer ${key}` };
  const body = {
    model: supported, messages: [{ role: 'user', content: '测试流式' }],
    stream: true, stream_options: { include_usage: true },
  };
  const response = await request(env, '/v1/chat/completions', 'POST', body, bearer);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /^text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const first = encoder.encode('data: {"response":"首段"}\r\n\r\n');
  upstream.enqueue(first.slice(0, 21));
  upstream.enqueue(first.slice(21));
  const event = JSON.parse(decoder.decode((await reader.read()).value).slice(6));
  assert.equal(event.object, 'chat.completion.chunk');
  assert.equal(event.choices[0].delta.content, '首段');
  const counts = DB.db.prepare('SELECT requests, successes, input_tokens, output_tokens FROM api_keys');
  assert.equal(counts.get().successes, 0);
  upstream.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"后段"},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":7}}\n\ndata: [DONE]\n\n'));
  upstream.close();
  let output = '';
  for (let next; !(next = await reader.read()).done;) output += decoder.decode(next.value);
  assert.match(output, /后段/);
  assert.match(output, /"completion_tokens":7/);
  assert.match(output, /data: \[DONE\]\n\n$/);
  assert.deepEqual({ ...counts.get() }, { requests: 1, successes: 1, input_tokens: 5, output_tokens: 7 });

  const interrupted = await request(env, '/v1/chat/completions', 'POST', body, bearer);
  upstream.enqueue(encoder.encode('data: {"response":"未完成"}\n\n'));
  upstream.close();
  assert.doesNotMatch(await interrupted.text(), /\[DONE\]/);
  assert.equal(counts.get().successes, 1);

  env.AI.run = async () => new Response(null, { status: 524 });
  const timeout = await request(env, '/v1/chat/completions', 'POST', body, bearer);
  assert.equal(timeout.status, 504);
  assert.match((await timeout.json()).error.message, /推理超时/);
  assert.deepEqual({ ...counts.get() }, { requests: 3, successes: 1, input_tokens: 5, output_tokens: 7 });
});
