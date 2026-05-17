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

function sseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function messagesSseBody(message) {
  const id = message.id || `msg_${Date.now()}`;
  const model = message.model || 'claude-unknown';
  const usage = message.usage || { input_tokens: 0, output_tokens: 0 };
  let body = '';
  body += sseEvent('message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  });
  for (const [index, block] of (message.content || []).entries()) {
    if (block?.type === 'text') {
      body += sseEvent('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      });
      body += sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: block.text || '' },
      });
      body += sseEvent('content_block_stop', { type: 'content_block_stop', index });
      continue;
    }
    if (block?.type === 'tool_use') {
      body += sseEvent('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: {},
        },
      });
      body += sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(block.input || {}),
        },
      });
      body += sseEvent('content_block_stop', { type: 'content_block_stop', index });
    }
  }
  body += sseEvent('message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: message.stop_reason || 'end_turn',
      stop_sequence: message.stop_sequence || null,
    },
    usage: { output_tokens: usage.output_tokens || 0 },
  });
  body += sseEvent('message_stop', { type: 'message_stop' });
  return body;
}

export function createRouter(deps) {
  const { callMessages, callChat, callResponses, callEmbeddings, profilesDir, serveToken,
          hasAnthropic, hasOpenai } = deps;

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

    if (req.method !== 'POST') {
      return errorResponse(405, 'invalid_request_error', 'method_not_allowed', `method ${req.method} not allowed`);
    }

    const body = parseBody(req);
    if (body === null) {
      return errorResponse(400, 'invalid_request_error', 'invalid_json', 'request body is not valid JSON');
    }
    if (pathname === '/v1/messages') {
      const upstream = pickUpstream(body.model);
      if (upstream !== 'anthropic') {
        return errorResponse(400, 'invalid_request_error', 'model_endpoint_mismatch',
                             '/v1/messages requires a Claude model');
      }
      const wantsStream = body.stream === true;
      const result = await callMessages(wantsStream ? { ...body, stream: false } : body, { profilesDir });
      if (wantsStream && result.status === 200) {
        const message = await result.response.json();
        return {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'X-Ccrotate-Attempts': String(result.attempts ?? 1),
            ...(result.account ? { 'X-Ccrotate-Account': result.account } : {}),
            ...(result.trigger ? { 'X-Ccrotate-Trigger': result.trigger } : {}),
          },
          body: messagesSseBody(message),
        };
      }
      return passthroughResponse(result);
    }

    if (pathname === '/v1/chat/completions') {
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

    if (pathname === '/v1/responses') {
      const upstream = pickUpstream(body.model);
      if (upstream === null) {
        return errorResponse(404, 'invalid_request_error', 'model_not_found',
                             `model ${body.model} is not available`);
      }
      if (upstream === 'openai') {
        const result = await callResponses(body);
        const wantsSse = String(getHeader(req, 'accept') || '').includes('text/event-stream') ||
                         body.stream === true;
        const contentType = result.response?.headers?.get?.('content-type') || '';
        if (result.status === 200 && wantsSse && !contentType.includes('text/event-stream')) {
          const responseBody = await result.response.json();
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
        return passthroughResponse(result);
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

    if (pathname === '/v1/embeddings') {
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
