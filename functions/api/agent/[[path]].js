// Cloudflare Pages Function for /api/agent/*: the Agent API proxy in
// src/agent/proxy.mjs, with the partner key from the AGENT_API_KEY secret.
import { agentProxy, DEFAULT_UPSTREAM } from '../../../src/agent/proxy.mjs';

let handler = null;

export async function onRequest({ request, env, params }) {
  handler ??= agentProxy({ apiKey: env.AGENT_API_KEY, upstream: env.AGENT_API_URL || DEFAULT_UPSTREAM });
  const segments = Array.isArray(params.path) ? params.path : [params.path].filter(Boolean);
  const client = request.headers.get('cf-connecting-ip') ?? 'unknown';
  return handler(request, { path: `/${segments.join('/')}`, client });
}
