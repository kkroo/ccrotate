// Codex/OpenAI admission control. Mirrors anthropic-admission.js so the
// /v1/responses (and chat) codex paths pace themselves before talking to
// the ChatGPT proxy or api.openai.com instead of fire-and-pray.
//
// Knobs (per family or global, family wins):
//   CCROTATE_CODEX_ADMISSION_<GROUP>_RPM            requests/min
//   CCROTATE_CODEX_ADMISSION_<GROUP>_INPUT_TPM      input tokens/min
//   CCROTATE_CODEX_ADMISSION_<GROUP>_OUTPUT_TPM     output tokens/min
//   CCROTATE_CODEX_ADMISSION_<GROUP>_MAX_CONCURRENCY  in-flight per group
//   CCROTATE_CODEX_ADMISSION_<GROUP>_MAX_WAIT_MS    upper bound on wait
//   CCROTATE_CODEX_ADMISSION_<GROUP>_OUTPUT_RESERVE_TOKENS  default reserve
// Group is the normalized model group (e.g. CODEX_GPT_5). Globals drop the
// group segment. CCROTATE_OPENAI_ADMISSION_* are accepted as aliases.

import { normalizeCodexModelGroup } from './rate-limit-state.js';

const buckets = new Map();
const activeByGroup = new Map();

function envKey(prefix, modelGroup, suffix) {
  const group = modelGroup.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return `${prefix}_${group}_${suffix}`;
}

function numberEnv(names, fallback = 0) {
  for (const name of names) {
    const raw = process.env[name];
    if (raw == null || raw === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return fallback;
}

function configFor(modelGroup, opts = {}) {
  if (opts.admissionConfig) return opts.admissionConfig;
  const keys = (suffix, ...aliases) => [
    envKey('CCROTATE_CODEX_ADMISSION', modelGroup, suffix),
    envKey('CCROTATE_OPENAI_ADMISSION', modelGroup, suffix),
    `CCROTATE_CODEX_ADMISSION_${suffix}`,
    `CCROTATE_OPENAI_ADMISSION_${suffix}`,
    ...aliases,
  ];
  return {
    rpm: numberEnv(keys('RPM'), 0),
    inputTpm: numberEnv(keys('INPUT_TPM', envKey('CCROTATE_CODEX_ADMISSION', modelGroup, 'ITPM'), 'CCROTATE_CODEX_ADMISSION_ITPM'), 0),
    outputTpm: numberEnv(keys('OUTPUT_TPM', envKey('CCROTATE_CODEX_ADMISSION', modelGroup, 'OTPM'), 'CCROTATE_CODEX_ADMISSION_OTPM'), 0),
    maxConcurrency: numberEnv(keys('MAX_CONCURRENCY'), 0),
    maxWaitMs: numberEnv(keys('MAX_WAIT_MS'), 30 * 60_000),
    outputReserveTokens: numberEnv(keys('OUTPUT_RESERVE_TOKENS'), 4096),
  };
}

// /v1/responses input is structured (`payload.input` array of message items),
// /v1/chat/completions input lives in `payload.messages`. Either way we fall
// back to JSON-length / 4 if attribution didn't pre-estimate.
function estimateInputTokens(payload, attribution) {
  const fromAttribution = Number(attribution?.estimatedInputTokens);
  if (Number.isFinite(fromAttribution) && fromAttribution > 0) return Math.ceil(fromAttribution);
  try {
    const src = payload?.input ?? payload?.messages ?? payload?.instructions ?? payload ?? {};
    return Math.max(1, Math.ceil(JSON.stringify(src).length / 4));
  } catch {
    return 1;
  }
}

function reserveOutputTokens(payload, attribution, cfg) {
  const requested = Number(
    attribution?.requestedMaxOutputTokens
    ?? payload?.max_output_tokens
    ?? payload?.max_tokens,
  );
  const reserve = Number(cfg.outputReserveTokens);
  if (!Number.isFinite(requested) || requested <= 0) return Number.isFinite(reserve) ? reserve : 0;
  if (!Number.isFinite(reserve) || reserve <= 0) return requested;
  return Math.min(requested, reserve);
}

function reserveBucket(key, limitPerMinute, amount, now) {
  if (!limitPerMinute || limitPerMinute <= 0 || !amount || amount <= 0) return { waitMs: 0 };
  const intervalMs = (60_000 * amount) / limitPerMinute;
  const availableAt = buckets.get(key) ?? now;
  const startAt = Math.max(now, availableAt);
  buckets.set(key, startAt + intervalMs);
  return { waitMs: startAt - now, intervalMs };
}

function releaseConcurrency(modelGroup) {
  const current = activeByGroup.get(modelGroup) ?? 0;
  if (current <= 1) activeByGroup.delete(modelGroup);
  else activeByGroup.set(modelGroup, current - 1);
}

export async function admitCodexAttempt(payload, {
  attribution = null,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = () => {},
  now = () => Date.now(),
  ...opts
} = {}) {
  const modelGroup = normalizeCodexModelGroup(payload?.model);
  const cfg = configFor(modelGroup, opts);
  const inputTokens = estimateInputTokens(payload, attribution);
  const outputTokens = reserveOutputTokens(payload, attribution, cfg);
  const maxWaitMs = Number.isFinite(cfg.maxWaitMs) ? cfg.maxWaitMs : 0;

  let release = () => {};
  if (cfg.maxConcurrency > 0) {
    let waitedMs = 0;
    while ((activeByGroup.get(modelGroup) ?? 0) >= cfg.maxConcurrency) {
      const waitMs = 250;
      if (maxWaitMs > 0 && waitedMs + waitMs > maxWaitMs) break;
      await sleep(waitMs);
      waitedMs += waitMs;
    }
    activeByGroup.set(modelGroup, (activeByGroup.get(modelGroup) ?? 0) + 1);
    release = () => releaseConcurrency(modelGroup);
  }

  const nowMs = now();
  const reservations = [
    ['requests', reserveBucket(`${modelGroup}:rpm`, cfg.rpm, 1, nowMs)],
    ['input_tokens', reserveBucket(`${modelGroup}:input`, cfg.inputTpm, inputTokens, nowMs)],
    ['output_tokens', reserveBucket(`${modelGroup}:output`, cfg.outputTpm, outputTokens, nowMs)],
  ];
  const waitMs = Math.max(0, ...reservations.map(([, r]) => r.waitMs ?? 0));
  if (waitMs > 0) {
    const boundedWaitMs = maxWaitMs > 0 ? Math.min(waitMs, maxWaitMs) : waitMs;
    log({
      modelGroup,
      waitMs: Math.round(boundedWaitMs),
      requestedWaitMs: Math.round(waitMs),
      limits: {
        rpm: cfg.rpm || null,
        inputTpm: cfg.inputTpm || null,
        outputTpm: cfg.outputTpm || null,
        maxConcurrency: cfg.maxConcurrency || null,
      },
      reserved: { inputTokens, outputTokens },
    });
    await sleep(boundedWaitMs);
  }
  return { release, modelGroup, waitMs, inputTokens, outputTokens };
}

export function resetCodexAdmissionForTests() {
  buckets.clear();
  activeByGroup.clear();
}
