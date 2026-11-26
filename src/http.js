export class HTTPError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function json(value, status = 200) {
  return Response.json(value, { status });
}

export async function readJSON(request, limit = 4096) {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
    throw new HTTPError(415, '请求须使用 application/json');
  }
  if (!request.body) throw new HTTPError(400, '请求内容为空');
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new HTTPError(413, '请求内容超过限制');
    }
    text += decoder.decode(value, { stream: true });
  }
  try {
    return JSON.parse(text + decoder.decode());
  } catch {
    throw new HTTPError(400, 'JSON 请求格式无效');
  }
}

export function secureResponse(response) {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('Content-Security-Policy', "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(response.body, { status: response.status, headers });
}
