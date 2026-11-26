export function streamCompletion(source, metadata, includeUsage, recordSuccess) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const frameEnd = /\r?\n\r?\n/;
  const chunk = { ...metadata, object: 'chat.completion.chunk' };
  let pending = '';
  let hasText = false;
  let finished = false;
  let ended = false;
  let usage;

  function send(controller, value) {
    controller.enqueue(encoder.encode(`data: ${value}\n\n`));
  }

  async function finish(controller) {
    if (ended) return;
    ended = true;
    if (!finished) send(controller, JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
    if (includeUsage && usage) send(controller, JSON.stringify({ ...chunk, choices: [], usage }));
    send(controller, '[DONE]');
    if (hasText) await recordSuccess(usage);
  }

  async function forward(frame, controller) {
    if (ended) return;
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) {
      if (frame.startsWith(':')) controller.enqueue(encoder.encode(`${frame}\n\n`));
      return;
    }
    if (data === '[DONE]') return finish(controller);
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      throw new Error('Invalid Workers AI stream event');
    }
    if (event?.error || /^event:\s*error\b/m.test(frame)) {
      ended = true;
      send(controller, JSON.stringify({ error: { message: 'Workers AI 流式推理中断' } }));
      return;
    }
    usage = event?.usage ?? usage;
    const choices = event?.choices;
    if (Array.isArray(choices) && choices.length) {
      hasText ||= choices.some((choice) => Boolean(choice.delta?.content?.trim()));
      finished ||= choices.some((choice) => Boolean(choice.finish_reason));
      send(controller, JSON.stringify({ ...chunk, choices }));
    } else if (typeof event?.response === 'string' && event.response) {
      const delta = hasText ? { content: event.response } : { role: 'assistant', content: event.response };
      hasText ||= Boolean(event.response.trim());
      send(controller, JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: null }] }));
    }
  }

  const stream = source.pipeThrough(new TransformStream({
    async transform(bytes, controller) {
      pending += decoder.decode(bytes, { stream: true });
      let separator;
      while ((separator = frameEnd.exec(pending))) {
        const frame = pending.slice(0, separator.index);
        pending = pending.slice(separator.index + separator[0].length);
        await forward(frame, controller);
      }
      if (pending.length > 512 * 1024) throw new Error('Workers AI stream event is too large');
    },
    async flush(controller) {
      pending += decoder.decode();
      if (pending) await forward(pending, controller);
      if (finished && !ended) await finish(controller);
    },
  }));
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' } });
}
