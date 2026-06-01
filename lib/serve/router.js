// HTTP request dispatch. Decoupled from node:http so it's unit-testable —
// node:http server in commands/serve.js just wraps `req` and forwards to
// `dispatch(req)`.
//
// Bearer auth gates everything under /v1/*. /healthz is open.

import { pickUpstream, listModels } from './route-rule.js';
import {
  openaiToAnthropic,
  anthropicToOpenai,
  responsesToAnthropic,
  anthropicToResponses,
  responsesSseBody,
} from './translator.js';
import { tryIntercept } from './intercept.js';
import { summarizeAnthropicRateLimit } from './rate-limit-state.js';
import { tierCacheAccountMap } from '../tier-cache-rows.js';

function jsonResponse(status, body) {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function errorResponse(status, type, code, message) {
  return jsonResponse(status, { error: { type, code, message } });
}

function getHeader(req, name) {
  // Headers are case-insensitive; tests may pass either case.
  const lower = name.toLowerCase();
  for (const k of Object.keys(req.headers || {})) {
    if (k.toLowerCase() === lower) return req.headers[k];
  }
  return undefined;
}

function parseBearer(req) {
  const h = getHeader(req, 'authorization');
  if (typeof h !== 'string' || !h.startsWith('Bearer ')) return null;
  return h.slice('Bearer '.length).trim();
}

function parseBody(req) {
  if (!req.body) return {};
  try { return JSON.parse(req.body); }
  catch { return null; }
}

function requestId() {
  return globalThis.crypto?.randomUUID?.() ?? `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function safeHeader(req, name) {
  const value = getHeader(req, name);
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.slice(0, 200);
}

function estimateTextTokens(value) {
  if (value == null) return 0;
  if (typeof value === 'string') return Math.ceil(value.length / 4);
  if (typeof value === 'number' || typeof value === 'boolean') return 1;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + estimateTextTokens(item), 0);
  if (typeof value === 'object') {
    return Object.values(value).reduce((sum, item) => sum + estimateTextTokens(item), 0);
  }
  return 0;
}

function requestAttribution(req, body, endpoint) {
  const bodyBytes = typeof req.body === 'string' ? Buffer.byteLength(req.body) : 0;
  return {
    requestId: requestId(),
    endpoint,
    model: body?.model ?? null,
    stream: body?.stream === true,
    bodyBytes,
    estimatedInputTokens: estimateTextTokens(body?.messages ?? body?.input ?? body),
    requestedMaxOutputTokens: Number.isFinite(Number(body?.max_tokens))
      ? Number(body.max_tokens)
      : Number.isFinite(Number(body?.max_completion_tokens))
        ? Number(body.max_completion_tokens)
        : null,
    caller: {
      userAgent: safeHeader(req, 'user-agent'),
      forwardedFor: safeHeader(req, 'x-forwarded-for'),
      paperclipCompanyId: safeHeader(req, 'x-paperclip-company-id'),
      paperclipCompanyIds: safeHeader(req, 'x-paperclip-company-ids'),
      paperclipUserId: safeHeader(req, 'x-paperclip-user-id'),
      paperclipKeyId: safeHeader(req, 'x-paperclip-key-id'),
      paperclipAgentId: safeHeader(req, 'x-paperclip-agent-id'),
      paperclipRunId: safeHeader(req, 'x-paperclip-run-id'),
      paperclipSessionId: safeHeader(req, 'x-paperclip-session-id'),
      paperclipTaskId: safeHeader(req, 'x-paperclip-task-id'),
      paperclipAdapterType: safeHeader(req, 'x-paperclip-adapter-type'),
      paperclipSubject: safeHeader(req, 'x-paperclip-subject'),
    },
  };
}

async function passthroughResponse(upstreamResult, onJson) {
  // upstreamResult.response is a fetch Response — read body once, propagate status.
  const text = await upstreamResult.response.text();
  if (onJson && upstreamResult.status === 200) {
    const ct = upstreamResult.response.headers.get('content-type') || '';
    if (ct.includes('json')) {
      try { onJson(JSON.parse(text)); } catch { /* best-effort usage tap */ }
    }
  }
  return {
    status: upstreamResult.status,
    headers: {
      'content-type': upstreamResult.response.headers.get('content-type') || 'application/json',
      ...(upstreamResult.headers || {}),
      'X-Ccrotate-Attempts': String(upstreamResult.attempts ?? 1),
      ...(upstreamResult.account ? { 'X-Ccrotate-Account': upstreamResult.account } : {}),
      ...(upstreamResult.trigger ? { 'X-Ccrotate-Trigger': upstreamResult.trigger } : {}),
      ...(upstreamResult.poolExhausted ? { 'X-Ccrotate-Pool-Exhausted': 'true' } : {}),
    },
    body: text,
  };
}

async function* responseBodyStream(response) {
  if (!response?.body) return;
  for await (const chunk of response.body) {
    yield chunk;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function* messagesStreamWithKeepalive(resultPromise, intervalMs = 5000) {
  let settled = false;
  const wrapped = Promise.resolve(resultPromise).then(
    (result) => {
      settled = true;
      return { result };
    },
    (err) => {
      settled = true;
      return { err };
    },
  );

  while (!settled) {
    const marker = {};
    const winner = await Promise.race([
      wrapped,
      sleep(intervalMs).then(() => marker),
    ]);
    if (winner !== marker) {
      if (winner.err) {
        yield `event: error\ndata: ${JSON.stringify({
          type: 'error',
          error: {
            type: 'api_error',
            message: String(winner.err?.message ?? winner.err ?? 'ccrotate upstream request failed'),
          },
        })}\n\n`;
        return;
      }
      const { result } = winner;
      if (result.status === 200) {
        yield* responseBodyStream(result.response);
        return;
      }
      const message = await result.response.text().catch(() => '');
      yield `event: error\ndata: ${JSON.stringify({
        type: 'error',
        error: {
          type: result.status === 529 ? 'overloaded_error' : 'api_error',
          message: message || `ccrotate upstream returned ${result.status}`,
        },
      })}\n\n`;
      return;
    }
    yield 'event: ping\ndata: {"type":"ping"}\n\n';
  }
}

export function createRouter(deps) {
  const { callMessages, callChat, callResponses, callEmbeddings, callImages, profilesDir, serveToken,
          hasAnthropic, hasOpenai, ccrotate, store, costReporter } = deps;
  const serveStartedAt = deps.serveStartedAt ?? Date.now();
  const streamKeepaliveMs = deps.streamKeepaliveMs ?? 5000;

  async function dispatch(req) {
    const pathname = new URL(req.url || '/', 'http://ccrotate.local').pathname;

    // /healthz unauth
    if (pathname === '/healthz') {
      return jsonResponse(200, { status: 'ok' });
    }

    // Bearer auth gate
    const tok = parseBearer(req);
    if (!tok || tok !== serveToken) {
      return errorResponse(401, 'authentication_error', 'invalid_bearer', 'missing or invalid bearer token');
    }

    if (pathname === '/v1/models' && req.method === 'GET') {
      return jsonResponse(200, listModels({ hasAnthropic, hasOpenai }));
    }

    if (pathname === '/v1/internal/rate-limits' && req.method === 'GET') {
      try {
        const state = await (store ?? (await import('./state-store.js')).createStateStore({ profilesDir })).getRateLimitState();
        return jsonResponse(200, state);
      } catch (e) {
        return errorResponse(500, 'internal_error', 'rate_limits_failed',
                             String(e?.message ?? e).slice(0, 200));
      }
    }

    if (pathname === '/v1/internal/pool-status' && req.method === 'GET') {
      try {
        const stateStore = store ?? (await import('./state-store.js')).createStateStore({ profilesDir });
        const [profiles, tierCache, rateLimitState] = await Promise.all([
          stateStore.getProfiles(),
          stateStore.getTierCache(),
          stateStore.getRateLimitState(),
        ]);
        const active = await stateStore.getActiveEmail().catch(() => null);
        const tierByEmail = tierCacheAccountMap(tierCache);
        const accounts = Object.keys(profiles || {}).map((email) => {
          const modelGroups = rateLimitState?.anthropic?.accounts?.[email]?.modelGroups ?? {};
          return {
            email,
            active: email === active,
            tier: tierByEmail.get(email)?.serviceTier ?? null,
            rateLimits: Object.fromEntries(
              Object.entries(modelGroups).map(([group, entry]) => [
                group,
                { ...entry, summary: summarizeAnthropicRateLimit(entry) },
              ]),
            ),
          };
        });
        return jsonResponse(200, { checkedAt: new Date().toISOString(), target: 'claude', accounts });
      } catch (e) {
        return errorResponse(500, 'internal_error', 'pool_status_failed',
                             String(e?.message ?? e).slice(0, 200));
      }
    }

    if (req.method !== 'POST') {
      return errorResponse(405, 'invalid_request_error', 'method_not_allowed', `method ${req.method} not allowed`);
    }

    const body = parseBody(req);
    if (body === null) {
      return errorResponse(400, 'invalid_request_error', 'invalid_json', 'request body is not valid JSON');
    }
    if (pathname === '/v1/messages') {
      const wantsStream = body.stream === true;
      const intercepted = await tryIntercept({
        body, endpoint: 'messages', wantsStream, ccrotate, serveStartedAt, store,
      });
      if (intercepted) return intercepted;
      const upstream = pickUpstream(body.model);
      if (upstream !== 'anthropic') {
        return errorResponse(400, 'invalid_request_error', 'model_endpoint_mismatch',
                             '/v1/messages requires a Claude model');
      }
      const attribution = requestAttribution(req, body, 'messages');
      const report = costReporter ? costReporter.shouldReport(attribution) : false;
      const resultPromise = callMessages(body, { profilesDir, attribution });
      if (wantsStream) {
        let stream = messagesStreamWithKeepalive(resultPromise, streamKeepaliveMs);
        if (report) stream = costReporter.tapStream(stream, body.model);
        return {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
          },
          stream,
        };
      }
      const result = await resultPromise;
      return passthroughResponse(
        result,
        report ? (json) => costReporter.recordFromJson(json, body.model) : undefined,
      );
    }

    if (pathname === '/v1/chat/completions') {
      const intercepted = await tryIntercept({
        body, endpoint: 'chat', wantsStream: false, ccrotate, serveStartedAt, store,
      });
      if (intercepted) return intercepted;
      const upstream = pickUpstream(body.model);
      if (upstream === null) {
        return errorResponse(404, 'invalid_request_error', 'model_not_found',
                             `model ${body.model} is not available`);
      }
      if (body.stream === true) {
        return errorResponse(400, 'invalid_request_error', 'streaming_not_supported_v1',
                             'stream:true is deferred to v2');
      }
      if (upstream === 'anthropic') {
        let anthroReq;
        try { anthroReq = openaiToAnthropic(body); }
        catch (e) {
          return errorResponse(400, 'invalid_request_error', e.code || 'translation_failed', e.message);
        }
        const attribution = requestAttribution(req, anthroReq, 'chat');
        const report = costReporter ? costReporter.shouldReport(attribution) : false;
        const result = await callMessages(anthroReq, { profilesDir, attribution });
        // Translate response back to OpenAI shape on 200 only.
        if (result.status === 200) {
          const anthBody = await result.response.json();
          if (report) costReporter.recordFromJson(anthBody, anthroReq.model);
          const openaiBody = anthropicToOpenai(anthBody);
          return {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'X-Ccrotate-Attempts': String(result.attempts ?? 1),
              ...(result.account ? { 'X-Ccrotate-Account': result.account } : {}),
              ...(result.trigger ? { 'X-Ccrotate-Trigger': result.trigger } : {}),
            },
            body: JSON.stringify(openaiBody),
          };
        }
        return passthroughResponse(result);
      }
      // upstream === 'openai'
      const attribution = requestAttribution(req, body, 'chat');
      const result = await callChat(body, { attribution });
      return passthroughResponse(result);
    }

    if (pathname === '/v1/responses' || pathname === '/v1/responses/compact') {
      const wantsSse = String(getHeader(req, 'accept') || '').includes('text/event-stream') ||
                       body.stream === true;
      const intercepted = await tryIntercept({
        body, endpoint: 'responses', wantsStream: wantsSse, ccrotate, serveStartedAt, store,
      });
      if (intercepted) return intercepted;
      const upstream = pickUpstream(body.model);
      if (upstream === null) {
        return errorResponse(404, 'invalid_request_error', 'model_not_found',
                             `model ${body.model} is not available`);
      }
      if (upstream === 'openai') {
        const attribution = requestAttribution(req, body, 'responses');
        const report = costReporter ? costReporter.shouldReport(attribution) : false;
        const result = await callResponses(body, {
          stream: wantsSse,
          headers: req.headers,
          compact: pathname === '/v1/responses/compact',
          attribution,
        });
        if (result.stream) {
          return {
            status: result.status,
            headers: {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
              ...(result.headers || {}),
              'X-Ccrotate-Attempts': String(result.attempts ?? 1),
              ...(result.account ? { 'X-Ccrotate-Account': result.account } : {}),
              ...(result.trigger ? { 'X-Ccrotate-Trigger': result.trigger } : {}),
              ...(result.poolExhausted ? { 'X-Ccrotate-Pool-Exhausted': 'true' } : {}),
            },
            stream: report ? costReporter.tapResponsesStream(result.stream, body.model) : result.stream,
          };
        }
        const contentType = result.response?.headers?.get?.('content-type') || '';
        if (result.status === 200 && wantsSse && !contentType.includes('text/event-stream')) {
          const responseBody = await result.response.json();
          if (report) costReporter.recordFromResponsesJson(responseBody, body.model);
          return {
            status: 200,
            headers: {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
              ...(result.headers || {}),
              'X-Ccrotate-Attempts': String(result.attempts ?? 1),
              ...(result.account ? { 'X-Ccrotate-Account': result.account } : {}),
              ...(result.trigger ? { 'X-Ccrotate-Trigger': result.trigger } : {}),
            },
            body: responsesSseBody(responseBody),
          };
        }
        return passthroughResponse(
          result,
          report ? (json) => costReporter.recordFromResponsesJson(json, body.model) : undefined,
        );
      }

      let anthroReq;
      try { anthroReq = responsesToAnthropic(body); }
      catch (e) {
        return errorResponse(400, 'invalid_request_error', e.code || 'translation_failed', e.message);
      }
      const attribution = requestAttribution(req, anthroReq, 'responses');
      const result = await callMessages(anthroReq, { profilesDir, attribution });
      if (result.status !== 200) {
        return passthroughResponse(result);
      }

      const anthBody = await result.response.json();
      const responseBody = anthropicToResponses(anthBody);
      if (wantsSse) {
        return {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'X-Ccrotate-Attempts': String(result.attempts ?? 1),
            ...(result.account ? { 'X-Ccrotate-Account': result.account } : {}),
            ...(result.trigger ? { 'X-Ccrotate-Trigger': result.trigger } : {}),
          },
          body: responsesSseBody(responseBody),
        };
      }
      return {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'X-Ccrotate-Attempts': String(result.attempts ?? 1),
          ...(result.account ? { 'X-Ccrotate-Account': result.account } : {}),
          ...(result.trigger ? { 'X-Ccrotate-Trigger': result.trigger } : {}),
        },
        body: JSON.stringify(responseBody),
      };
    }

    if (pathname === '/v1/embeddings') {
      const upstream = pickUpstream(body.model);
      if (upstream !== 'openai') {
        return errorResponse(400, 'invalid_request_error', 'model_endpoint_mismatch',
                             '/v1/embeddings requires an OpenAI model');
      }
      const attribution = requestAttribution(req, body, 'embeddings');
      const result = await callEmbeddings(body, { attribution });
      return passthroughResponse(result);
    }

    if (pathname === '/v1/images/generations') {
      const upstream = pickUpstream(body.model);
      if (upstream !== 'openai') {
        return errorResponse(400, 'invalid_request_error', 'model_endpoint_mismatch',
                             '/v1/images/generations requires an OpenAI model');
      }
      if (typeof callImages !== 'function') {
        return errorResponse(503, 'service_unavailable', 'images_unavailable',
                             '/v1/images/generations is not configured on this serve instance');
      }
      const attribution = requestAttribution(req, body, 'images');
      const result = await callImages(body, { attribution });
      return passthroughResponse(result);
    }

    // Internal: single-account probe. Wraps probeOne(target, email, ccrotate)
    // from freshness-loop.js. Used by paperclip tier-gate verifier to
    // actively confirm a "claimed-exhausted" account before tying up agent
    // capacity on it. Bearer-auth gated like the rest of /v1/*; the global
    // POST-only gate above already covers method enforcement.
    if (pathname === '/v1/internal/probe-one') {
      if (!body || typeof body !== 'object') {
        return errorResponse(400, 'invalid_request_error', 'invalid_body', 'expected JSON body');
      }
      if (!body.email || typeof body.email !== 'string') {
        return errorResponse(400, 'invalid_request_error', 'missing_email', 'email (string) required');
      }
      if (!body.target || (body.target !== 'claude' && body.target !== 'codex')) {
        return errorResponse(400, 'invalid_request_error', 'invalid_target',
                             'target must be "claude" or "codex"');
      }
      if (!ccrotate) {
        return errorResponse(500, 'internal_error', 'no_ccrotate_instance',
                             'ccrotate instance not wired into router');
      }
      try {
        const { probeOne } = await import('./freshness-loop.js');
        // `store` is optional in deps — when absent (production serve),
        // probeOne defaults to createStateStore() which picks Http/File
        // mode from CCROTATE_STATE_URL. Tests inject a fake store.
        const result = await probeOne(body.target, body.email, ccrotate, store);
        return jsonResponse(200, result);
      } catch (e) {
        return errorResponse(500, 'internal_error', 'probe_failed',
                             String(e?.message ?? e).slice(0, 200));
      }
    }

    return errorResponse(404, 'invalid_request_error', 'unknown_endpoint', `${req.url} not found`);
  }

  return { dispatch };
}
