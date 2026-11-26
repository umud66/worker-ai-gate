import { authorized, challenge, digest, login, logout, randomHex } from './auth.js';
import { HTTPError, json, readJSON, secureResponse } from './http.js';
import { streamCompletion } from './stream.js';

// Cloudflare lists both models as available on Workers Free.
const models = new Map([
  ['@cf/google/gemma-4-26b-a4b-it', 'Google'],
  ['@cf/zai-org/glm-4.7-flash', 'Zhipu AI'],
]);
const scripts = new Set(['/style.css', '/login.js', '/login-crypto.js', '/keys.js']);
const keyColumns = 'id, name, prefix, created_at, revoked_at, requests, successes, input_tokens, output_tokens';

function asset(env, request, path) {
  return env.ASSETS.fetch(new Request(new URL(path, request.url), { method: request.method }));
}

async function requireKey(request, env) {
  const value = request.headers.get('authorization') || '';
  const match = value.match(/^Bearer (sw_[0-9a-f]{64})$/i);
  if (!match) throw new HTTPError(401, '需要有效的 API Key');
  const key = await env.DB.prepare('SELECT id FROM api_keys WHERE digest=? AND revoked_at IS NULL').bind(digest(match[1])).first();
  if (!key) throw new HTTPError(401, 'API Key 无效或已吊销');
  return key.id;
}

async function createKey(request, env) {
  const input = await readJSON(request);
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (!name || Array.from(name).length > 60) throw new HTTPError(400, '请输入 1 至 60 个字符的名称');
  const key = `sw_${randomHex(32)}`;
  const id = randomHex(16);
  const prefix = key.slice(0, 12);
  await env.DB.prepare('INSERT INTO api_keys (id, name, prefix, digest, created_at) VALUES (?,?,?,?,?)')
    .bind(id, name, prefix, digest(key), new Date().toISOString()).run();
  return json({ id, name, prefix, key }, 201);
}

function tokenCount(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function usageCounts(usage) {
  return {
    prompt_tokens: tokenCount(usage?.prompt_tokens ?? usage?.input_tokens),
    completion_tokens: tokenCount(usage?.completion_tokens ?? usage?.output_tokens),
  };
}

async function recordSuccess(env, id, usage) {
  const { prompt_tokens, completion_tokens } = usageCounts(usage);
  return env.DB.prepare('UPDATE api_keys SET successes=successes+1,input_tokens=input_tokens+?,output_tokens=output_tokens+? WHERE id=?')
    .bind(prompt_tokens, completion_tokens, id).run();
}

async function complete(request, env, ctx, id) {
  const input = await readJSON(request, 32 * 1024);
  if (!models.has(input?.model)) throw new HTTPError(400, '请选择模型列表中的 Workers Free 模型');
  if (input.stream != null && typeof input.stream !== 'boolean') throw new HTTPError(400, 'stream 须为布尔值');
  if (!Array.isArray(input.messages) || !input.messages.length || input.messages.length > 20) {
    throw new HTTPError(400, '请提交 1 至 20 条文本消息');
  }
  const roles = new Set(['system', 'user', 'assistant']);
  const messages = input.messages.map((message) => {
    if (!roles.has(message?.role) || typeof message.content !== 'string' || !message.content.trim()) {
      throw new HTTPError(400, '消息须有有效角色和文本内容');
    }
    return { role: message.role, content: message.content };
  });
  if (!messages.some((message) => message.role === 'user')) throw new HTTPError(400, '至少需要一条用户消息');
  const requestedTokens = input.max_completion_tokens ?? input.max_tokens;
  if (requestedTokens != null && (!Number.isSafeInteger(requestedTokens) || requestedTokens < 1)) {
    throw new HTTPError(400, '输出 Token 上限须为正整数');
  }
  const maxTokens = Math.min(800, requestedTokens ?? 650);
  const options = { messages, max_tokens: maxTokens, stream: input.stream === true };
  if (options.stream) options.stream_options = { include_usage: true };
  if (input.temperature != null) {
    if (!Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2) {
      throw new HTTPError(400, 'temperature 须为 0 至 2 之间的数字');
    }
    options.temperature = input.temperature;
  }
  const counted = await env.DB.prepare('UPDATE api_keys SET requests=requests+1 WHERE id=? AND revoked_at IS NULL RETURNING id').bind(id).first();
  if (!counted) throw new HTTPError(401, 'API Key 已吊销');
  let completion;
  try {
    completion = await env.AI.run(input.model, options);
    if (completion instanceof Response && !completion.ok) throw new HTTPError(completion.status, '推理请求失败');
    if (!options.stream && completion instanceof Response) completion = await completion.json();
  } catch (error) {
    const status = Number(error?.status || error?.statusCode || 0);
    const code = Number(error?.code || 0);
    if (status === 429 || code === 3040 || /quota|neurons|rate limit|allocation|capacity/i.test(error?.message || '')) {
      throw new HTTPError(429, 'Workers AI 免费额度或容量暂不可用');
    }
    if ([408, 504, 524].includes(status) || /timed?\s*out|deadline exceeded|ETIMEDOUT/i.test(error?.message || '')) {
      throw new HTTPError(504, 'Workers AI 推理超时');
    }
    console.error('Workers AI inference failed', { model: input.model, status, code });
    throw new HTTPError(502, 'Workers AI 推理暂不可用');
  }
  const metadata = { id: `chatcmpl-${randomHex(12)}`, created: Math.floor(Date.now() / 1000), model: input.model };
  if (options.stream) {
    const source = completion instanceof Response ? completion.body : completion;
    if (!(source instanceof ReadableStream)) throw new HTTPError(502, 'Workers AI 未返回流式响应');
    return streamCompletion(source, metadata, input.stream_options?.include_usage === true, async (usage) => {
      const task = recordSuccess(env, id, usage).catch(() => console.error('Unable to record streamed AI usage'));
      if (ctx) ctx.waitUntil(task);
      else await task;
    });
  }
  const result = completion?.result || completion;
  const choice = result?.choices?.[0];
  const content = choice?.message?.content || result?.response;
  if (typeof content !== 'string' || !content.trim()) throw new HTTPError(502, '模型未返回文本');

  const usage = usageCounts(result?.usage);
  await recordSuccess(env, id, usage);
  return json({
    ...metadata, object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: choice?.finish_reason || 'stop' }],
    usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
  });
}

async function handle(request, env, ctx) {
  const { pathname } = new URL(request.url);
  const method = request.method;
  if (method === 'GET' && scripts.has(pathname)) return asset(env, request, pathname);
  if (pathname.startsWith('/v1/')) {
    if (method === 'GET' && pathname === '/v1/models') {
      await requireKey(request, env);
      return json({ object: 'list', data: [...models].map(([id, owned_by]) => ({ id, object: 'model', owned_by })) });
    }
    if (method === 'POST' && pathname === '/v1/chat/completions') return complete(request, env, ctx, await requireKey(request, env));
    throw new HTTPError(404, '找不到 API');
  }
  if (!env.ADMIN_PASSWORD) throw new HTTPError(503, '请在 Worker 中设置 ADMIN_PASSWORD 密钥');
  if (method === 'GET' && pathname === '/') return asset(env, request, await authorized(request, env) ? '/keys.html' : '/login.html');
  if (method === 'POST' && pathname === '/api/auth/challenge') {
    await readJSON(request);
    return challenge(env);
  }
  if (method === 'POST' && pathname === '/api/auth/login') return login(request, env);
  if (!await authorized(request, env)) throw new HTTPError(401, '需要管理员登录');
  if (method === 'POST' && pathname === '/api/auth/logout') {
    await readJSON(request);
    return logout(request, env);
  }
  if (method === 'GET' && pathname === '/api/keys') {
    const result = await env.DB.prepare(`SELECT ${keyColumns} FROM api_keys ORDER BY created_at DESC`).all();
    return json({ keys: result.results });
  }
  if (method === 'POST' && pathname === '/api/keys') return createKey(request, env);
  const match = pathname.match(/^\/api\/keys\/([0-9a-f]{32})\/revoke$/);
  if (method === 'POST' && match) {
    await readJSON(request);
    const result = await env.DB.prepare('UPDATE api_keys SET revoked_at=? WHERE id=? AND revoked_at IS NULL')
      .bind(new Date().toISOString(), match[1]).run();
    if (!result.meta.changes) throw new HTTPError(404, '找不到有效的 API Key');
    return new Response(null, { status: 204 });
  }
  throw new HTTPError(404, '页面不存在');
}

export default {
  async fetch(request, env, ctx) {
    try {
      return secureResponse(await handle(request, env, ctx));
    } catch (error) {
      if (error instanceof HTTPError) {
        return secureResponse(json({ error: { message: error.message } }, error.status));
      }
      const missingTable = /no such table:\s*(?:main\.)?(?:auth_nonces|admin_sessions|api_keys)\b/i;
      if (missingTable.test(error?.message) || missingTable.test(error?.cause?.message)) {
        return secureResponse(json({ error: { message: 'DB 已绑定，但缺少网关数据表。请将 Cloudflare Build command 设为 npm run build 后重新构建。' } }, 503));
      }
      console.error('Gateway request failed', request.method, new URL(request.url).pathname, error);
      return secureResponse(json({ error: { message: '网关暂不可用，请查看 Cloudflare Worker 实时日志' } }, 500));
    }
  },
};
