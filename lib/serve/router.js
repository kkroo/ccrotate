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

async function passthroughResponse(upstreamResult) {
  // upstreamResult.response is a fetch Response — read body once, propagate status.
  const text = await upstreamResult.response.text();
  return {
    status: upstreamResult.status,
    headers: {
      'content-type': upstreamResult.response.headers.get('content-type') || 'application/json',
      'X-Ccrotate-Attempts': String(upstreamResult.attempts ?? 1),
      ...(upstreamResult.account ? { 'X-Ccrotate-Account': upstreamResult.account } : {}),
      ...(upstreamResult.trigger ? { 'X-Ccrotate-Trigger': upstreamResult.trigger } : {}),
      ...(upstreamResult.poolExhausted ? { 'X-Ccrotate-Pool-Exhausted': 'true' } : {}),
    },
    body: text,
  };
}

export function createRouter(deps) {
  const { callMessages, callChat, callEmbeddings, profilesDir, serveToken,
          hasAnthropic, hasOpenai } = deps;

  async function dispatch(req) {
    // /healthz unauth
    if (req.url === '/healthz') {
      return jsonResponse(200, { status: 'ok' });
    }

    // Bearer auth gate
    const tok = parseBearer(req);
    if (!tok || tok !== serveToken) {
      return errorResponse(401, 'authentication_error', 'invalid_bearer', 'missing or invalid bearer token');
    }

    if (req.url === '/v1/models' && req.method === 'GET') {
      return jsonResponse(200, listModels({ hasAnthropic, hasOpenai }));
    }

    if (req.method !== 'POST') {
      return errorResponse(405, 'invalid_request_error', 'method_not_allowed', `method ${req.method} not allowed`);
    }

    const body = parseBody(req);
    if (body === null) {
      return errorResponse(400, 'invalid_request_error', 'invalid_json', 'request body is not valid JSON');
    }

    if (req.url === '/v1/messages') {
      const upstream = pickUpstream(body.model);
      if (upstream !== 'anthropic') {
        return errorResponse(400, 'invalid_request_error', 'model_endpoint_mismatch',
                             '/v1/messages requires a Claude model');
      }
      if (body.stream === true) {
        return errorResponse(400, 'invalid_request_error', 'streaming_not_supported_v1',
                             'stream:true is deferred to v2');
      }
      const result = await callMessages(body, { profilesDir });
      return passthroughResponse(result);
    }

    if (req.url === '/v1/chat/completions') {
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
        const result = await callMessages(anthroReq, { profilesDir });
        // Translate response back to OpenAI shape on 200 only.
        if (result.status === 200) {
          const anthBody = await result.response.json();
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
      const result = await callChat(body);
      return passthroughResponse(result);
    }

    if (req.url === '/v1/responses') {
      const upstream = pickUpstream(body.model);
      if (upstream === null) {
        return errorResponse(404, 'invalid_request_error', 'model_not_found',
                             `model ${body.model} is not available`);
      }
      if (upstream !== 'anthropic') {
        return errorResponse(400, 'invalid_request_error', 'model_endpoint_mismatch',
                             '/v1/responses is currently supported for Claude models');
      }

      let anthroReq;
      try { anthroReq = responsesToAnthropic(body); }
      catch (e) {
        return errorResponse(400, 'invalid_request_error', e.code || 'translation_failed', e.message);
      }
      const result = await callMessages(anthroReq, { profilesDir });
      if (result.status !== 200) {
        return passthroughResponse(result);
      }

      const anthBody = await result.response.json();
      const responseBody = anthropicToResponses(anthBody);
      const wantsSse = String(getHeader(req, 'accept') || '').includes('text/event-stream') ||
                       body.stream === true;
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

    if (req.url === '/v1/embeddings') {
      const upstream = pickUpstream(body.model);
      if (upstream !== 'openai') {
        return errorResponse(400, 'invalid_request_error', 'model_endpoint_mismatch',
                             '/v1/embeddings requires an OpenAI model');
      }
      const result = await callEmbeddings(body);
      return passthroughResponse(result);
    }

    return errorResponse(404, 'invalid_request_error', 'unknown_endpoint', `${req.url} not found`);
  }

  return { dispatch };
}
