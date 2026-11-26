import { Buffer } from 'node:buffer';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { HTTPError, json, readJSON } from './http.js';

const sessionCookie = 'stockwatch_ai_session';
const sessionSeconds = 12 * 60 * 60;
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export const randomHex = (size) => randomBytes(size).toString('hex');
const timeSeconds = () => Math.floor(Date.now() / 1000);
const passwordTag = (env, token) => createHmac('sha256', env.ADMIN_PASSWORD).update(`stockwatch-worker-session:${token}`).digest('hex');

function sessionToken(request) {
  for (const pair of (request.headers.get('cookie') || '').split(';')) {
    const [name, value] = pair.trim().split('=');
    if (name === sessionCookie && /^[0-9a-f]{64}$/.test(value || '')) return value;
  }
  return '';
}

function sessionResponse(request, value, maxAge) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  const cookie = `${sessionCookie}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Strict${secure}`;
  return new Response(null, { status: 204, headers: { 'Set-Cookie': cookie } });
}

export async function authorized(request, env) {
  const token = sessionToken(request);
  if (!token) return false;
  const row = await env.DB.prepare('SELECT digest FROM admin_sessions WHERE digest=? AND password_tag=? AND expires>?')
    .bind(digest(token), passwordTag(env, token), timeSeconds()).first();
  return Boolean(row);
}

export async function challenge(env) {
  const nonce = randomHex(16);
  const now = timeSeconds();
  const [, inserted] = await env.DB.batch([
    env.DB.prepare('DELETE FROM auth_nonces WHERE expires<=?').bind(now),
    env.DB.prepare('INSERT INTO auth_nonces(nonce, expires) SELECT ?, ? WHERE (SELECT count(*) FROM auth_nonces)<256').bind(nonce, now + 60),
  ]);
  if (!inserted.meta.changes) throw new HTTPError(429, '登录请求较多，请稍后重试');
  return json({ challenge: nonce });
}

export async function login(request, env) {
  const input = await readJSON(request);
  if (!input || typeof input.challenge !== 'string' || !/^[0-9a-f]{32}$/.test(input.challenge)) {
    throw new HTTPError(400, '登录请求格式无效');
  }
  const consumed = await env.DB.prepare('DELETE FROM auth_nonces WHERE nonce=? RETURNING expires').bind(input.challenge).first();
  if (!consumed || consumed.expires <= timeSeconds()) throw new HTTPError(401, '登录校验已过期，请重新登录');
  if (input.username !== 'admin' || typeof input.proof !== 'string' || !/^[0-9a-f]{64}$/.test(input.proof)) {
    throw new HTTPError(401, '账号或密码错误');
  }
  const key = createHash('md5').update(env.ADMIN_PASSWORD, 'utf8').digest();
  const expected = createHmac('sha256', key).update(`stockwatch-login:${input.challenge}`).digest();
  const supplied = Buffer.from(input.proof, 'hex');
  if (!timingSafeEqual(expected, supplied)) throw new HTTPError(401, '账号或密码错误');

  const token = randomHex(32);
  const now = timeSeconds();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM admin_sessions WHERE expires<=? OR digest=?').bind(now, digest(sessionToken(request))),
    env.DB.prepare('INSERT INTO admin_sessions(digest,password_tag,expires) VALUES(?,?,?)').bind(digest(token), passwordTag(env, token), now + sessionSeconds),
  ]);
  return sessionResponse(request, token, sessionSeconds);
}

export async function logout(request, env) {
  const token = sessionToken(request);
  if (token) await env.DB.prepare('DELETE FROM admin_sessions WHERE digest=?').bind(digest(token)).run();
  return sessionResponse(request, '', 0);
}
