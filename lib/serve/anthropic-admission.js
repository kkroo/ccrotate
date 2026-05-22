import { normalizeAnthropicModelGroup } from './rate-limit-state.js';

const buckets = new Map();
const activeByGroup = new Map();

function envKey(modelGroup, suffix) {
  return `CCROTATE_ANTHROPIC_ADMISSION_${modelGroup.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_${suffix}`;
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
  return {
    rpm: numberEnv([envKey(modelGroup, 'RPM'), 'CCROTATE_ANTHROPIC_ADMISSION_RPM'], 0),
    inputTpm: numberEnv([envKey(modelGroup, 'INPUT_TPM'), envKey(modelGroup, 'ITPM'), 'CCROTATE_ANTHROPIC_ADMISSION_INPUT_TPM', 'CCROTATE_ANTHROPIC_ADMISSION_ITPM'], 0),
    outputTpm: numberEnv([envKey(modelGroup, 'OUTPUT_TPM'), envKey(modelGroup, 'OTPM'), 'CCROTATE_ANTHROPIC_ADMISSION_OUTPUT_TPM', 'CCROTATE_ANTHROPIC_ADMISSION_OTPM'], 0),
    maxConcurrency: numberEnv([envKey(modelGroup, 'MAX_CONCURRENCY'), 'CCROTATE_ANTHROPIC_ADMISSION_MAX_CONCURRENCY'], 0),
    maxWaitMs: numberEnv([envKey(modelGroup, 'MAX_WAIT_MS'), 'CCROTATE_ANTHROPIC_ADMISSION_MAX_WAIT_MS'], 30 * 60_000),
    outputReserveTokens: numberEnv([envKey(modelGroup, 'OUTPUT_RESERVE_TOKENS'), 'CCROTATE_ANTHROPIC_ADMISSION_OUTPUT_RESERVE_TOKENS'], 4096),
  };
}

function estimateInputTokens(payload, attribution) {
  const fromAttribution = Number(attribution?.estimatedInputTokens);
  if (Number.isFinite(fromAttribution) && fromAttribution > 0) return Math.ceil(fromAttribution);
  try {
    return Math.max(1, Math.ceil(JSON.stringify(payload ?? {}).length / 4));
  } catch {
    return 1;
  }
}

function reserveOutputTokens(payload, attribution, cfg) {
  const requested = Number(attribution?.requestedMaxOutputTokens ?? payload?.max_tokens);
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

export async function admitAnthropicAttempt(payload, {
  attribution = null,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = () => {},
  now = () => Date.now(),
  ...opts
} = {}) {
  const modelGroup = normalizeAnthropicModelGroup(payload?.model);
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

export function resetAnthropicAdmissionForTests() {
  buckets.clear();
  activeByGroup.clear();
}
