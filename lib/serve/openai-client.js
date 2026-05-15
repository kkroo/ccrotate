// OpenAI upstream client. Single-key path is the default; codex pool
// rotation lands in Task 13 IFF Gate 1 probe passed.
//
// We do not retry/rotate on the single-key path — LiteLLM's router
// already handles transient retries.

const CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const EMB_URL = 'https://api.openai.com/v1/embeddings';

async function callOnceJson({ url, payload, timeoutMs }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('openai-client: OPENAI_API_KEY env not set');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

export async function callChat(payload, opts = {}) {
  const { timeoutMs = 15000 } = opts;
  const response = await callOnceJson({ url: CHAT_URL, payload, timeoutMs });
  return { status: response.status, response, attempts: 1 };
}

export async function callEmbeddings(payload, opts = {}) {
  const { timeoutMs = 15000 } = opts;
  const response = await callOnceJson({ url: EMB_URL, payload, timeoutMs });
  return { status: response.status, response, attempts: 1 };
}
