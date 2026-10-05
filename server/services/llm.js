import { recordUsage } from './ai-usage.js';

/* ── 大模型调用（OpenAI 兼容协议）──────────────────────────────────────
   assistant.js（工作台助手）和 knowledge-ai.js（文章助手）都走这里。

   抽出来是因为流式那段细节不少：reasoning_content 要先攒再发、空闲超时和
   整体超时是两道闸、SSE 要逐行解析还得容忍脏行、报错措辞要能指出下一步。
   复制两份的话，迟早有一份修了另一份没修。

   协议层面只认标准 OpenAI 格式，所以 Ollama / vLLM / 局域网里的 agent
   都能直接当供应商填（见 README 的「接局域网里的 Hermes Agent」）。 */

export const aiConfigured = () => Boolean(process.env.AI_API_KEY);

export function aiEndpoint() {
  return {
    base: (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    model: process.env.AI_MODEL || 'gpt-4o-mini',
  };
}

/* 单次问答的等待上限。Hermes 这类 agent 处理复杂问题要做多步推理，
   实测同一个复杂问题要 29 秒——原来硬编码的 30 秒等于踩在悬崖边上。 */
const DEFAULT_AI_TIMEOUT_MS = 120000;

export function aiTimeoutMs() {
  const raw = Number(process.env.AI_TIMEOUT_MS);
  // 下限 5 秒：写 0 或负数会让每次请求立刻超时，那是故障，不是配置
  return Number.isFinite(raw) && raw > 0 ? Math.max(5000, raw) : DEFAULT_AI_TIMEOUT_MS;
}

/* 流式：非流式时用户只能干等，复杂问题实测 64 秒才出第一个字。
   流式把模型的过程一路带出来——Hermes 会逐 token 吐 reasoning_content，
   既让用户看见进展，也天然保活：反代不会因为"长时间没数据"把连接掐掉。 */

const DEFAULT_AI_STREAM_TIMEOUT_MS = 300000;
/** 流里多久收不到任何 chunk 就认定断了。推理是逐 token 出的，真卡住才会触发 */
export const AI_STREAM_IDLE_MS = 90000;

export function aiStreamTimeoutMs() {
  const raw = Number(process.env.AI_STREAM_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.max(10000, raw) : DEFAULT_AI_STREAM_TIMEOUT_MS;
}

function headers() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.AI_API_KEY}`,
  };
}

/** 解析一行 SSE，取出 OpenAI 兼容格式里的增量内容与用量 */
function parseStreamLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === '[DONE]') return null;
  let json;
  try {
    json = JSON.parse(payload);
  } catch {
    return null; // 一行脏数据不该打断整段回答
  }
  const delta = json?.choices?.[0]?.delta;
  /* 用量在最后一个分片上单独来（那里 choices 的 delta 是空对象，实测这个端点
     不需要 stream_options 就会带上）。所以这里不能因为 delta 为空就整行丢掉。 */
  const usage = json?.usage && typeof json.usage === 'object' ? json.usage : null;
  if (!delta && !usage) return null;
  return {
    thinking: delta?.reasoning_content || '',
    content: delta?.content || '',
    usage,
  };
}

/** 一次性返回。messages 是标准的 [{role, content}]。source 只用于用量统计 */
export async function llmReply(messages, { temperature = 0.3, source = 'other' } = {}) {
  const { base, model } = aiEndpoint();
  const timeoutMs = aiTimeoutMs();

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ model, temperature, messages }),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((err) => {
    // 原始报错是 "The operation was aborted due to timeout"：既不像中文，也没说下一步该干什么
    if (/abort|timeout/i.test(String(err?.message || ''))) {
      throw new Error(`模型 ${Math.round(timeoutMs / 1000)} 秒内没有返回；复杂问题会更慢，可用 AI_TIMEOUT_MS 调大`);
    }
    throw err;
  });

  if (!res.ok) throw new Error(`大模型接口返回 ${res.status}`);
  const json = await res.json();
  recordUsage(source, json.usage);
  return json.choices?.[0]?.message?.content?.trim() || '模型没有返回内容。';
}

/**
 * 流式调用，onChunk 收到 {type:'thinking'|'delta', text}。
 * 返回拼好的完整答案。中途失败抛异常 —— 调用方靠"有没有出过 delta"
 * 决定能不能回退（已经吐出去半截再回退，两段文字接在一起更难懂）。
 */
export async function llmStream(messages, onChunk, { temperature = 0.3, source = 'other' } = {}) {
  const { base, model } = aiEndpoint();
  const timeoutMs = aiStreamTimeoutMs();
  const controller = new AbortController();
  let idleTimer = null;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(new Error('IDLE')), AI_STREAM_IDLE_MS);
  };

  let answer = '';
  /* 用量在流的最后一个分片上才来。中途断开就收不到 —— 那一笔只能不记，
     总比拿半截答案去估一个数是强。 */
  let usage = null;
  try {
    armIdle();
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ model, temperature, stream: true, messages }),
      // 两道闸：空闲太久要断，整体太久也要断（模型偶尔会陷在长循环里）
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
    });

    if (!res.ok) throw new Error(`大模型接口返回 ${res.status}`);
    if (!res.body) throw new Error('大模型没有返回可读的流');

    const decoder = new TextDecoder();
    let buffer = '';
    // 推理是逐 token 来的，一次复杂问题能出几千个分片；它只用来表示"有进展"，
    // 攒够一截再发，省掉几千个小帧和对应的前端重渲染。答案分片保持原样，逐字更自然。
    let thinkBuf = '';
    const flushThinking = () => {
      if (!thinkBuf) return;
      onChunk({ type: 'thinking', text: thinkBuf });
      thinkBuf = '';
    };

    for await (const chunk of res.body) {
      armIdle();
      buffer += decoder.decode(chunk, { stream: true });
      let cut;
      while ((cut = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 1);
        const part = parseStreamLine(line);
        if (!part) continue;
        if (part.usage) usage = part.usage;
        if (part.thinking) {
          thinkBuf += part.thinking;
          if (thinkBuf.length >= 24) flushThinking();
        }
        if (part.content) {
          flushThinking(); // 答案开始了，先把攒着的推理交出去，顺序才不乱
          answer += part.content;
          onChunk({ type: 'delta', text: part.content });
        }
      }
    }
    flushThinking();
    recordUsage(source, usage);
  } catch (err) {
    const msg = String(err?.message || err);
    if (/IDLE/.test(msg)) throw new Error(`模型 ${AI_STREAM_IDLE_MS / 1000} 秒没有输出，连接中断`);
    if (/abort|timeout/i.test(msg)) throw new Error(`模型 ${Math.round(timeoutMs / 1000)} 秒内没答完，连接中断`);
    throw err;
  } finally {
    clearTimeout(idleTimer);
  }
  return answer;
}
