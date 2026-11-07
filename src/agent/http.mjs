// A small Agent API client for the web desk. It talks to the site's own proxy
// (/api/agent), which adds the partner key, so the page never holds a key.
// Method names, arguments and error fields follow the official SDK, so the
// executor and the quote client in src/ run on it unchanged.
import { waitForStatus } from './status.mjs';

export class AgentHttpError extends Error {
  constructor(status, document) {
    const first = document?.errors?.[0];
    super(first?.detail ?? first?.title ?? `HTTP ${status}`);
    this.name = 'AgentHttpError';
    this.status = status;
    this.code = first?.code ?? 'http_error';
    this.layer = first?.layer;
    this.document = document;
  }
}

const newKey = () => crypto.randomUUID();

/**
 * @param {object} [p]
 * @param {string} [p.base] the proxy's prefix, or an origin plus prefix
 * @param {typeof fetch} [p.fetch]
 * @param {string} [p.grantToken] runs grant-scoped calls (swap, withdraw)
 */
export function agentHttp({ base = '/api/agent', fetch: fetcher = (...a) => globalThis.fetch(...a), grantToken } = {}) {
  async function call(method, path, { query, body, idempotencyKey, grant = false, signal } = {}) {
    const qs = query
      ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]))}`
      : '';
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    if (grant) {
      if (!grantToken) throw new Error('this call needs a grant token');
      headers['x-grant-token'] = grantToken;
    }
    let res;
    try {
      res = await fetcher(`${base}${path}${qs}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch (err) {
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError') throw err;
      const e = new Error(`the Agent API is not reachable: ${err?.message ?? err}`);
      e.status = null;
      throw e;
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) throw new AgentHttpError(res.status, json);
    return idempotencyKey && json && typeof json === 'object' ? { ...json, idempotencyKey } : json;
  }

  const id = (agentId) => encodeURIComponent(agentId);

  return {
    getTokens: () => call('GET', '/v1/tokens'),
    generateIntent: (request, { idempotencyKey = newKey() } = {}) => call('POST', '/v1/generate-intent', { body: request, idempotencyKey }),
    submitIntent: (request) => call('POST', '/v1/submit-intent', { body: request }),
    getStatus: (correlationId, { waitMs, signal } = {}) =>
      call('GET', '/v1/status', { query: { correlation_id: correlationId, wait_ms: waitMs }, signal }),
    getAgent: (agentId) => call('GET', `/v1/agents/${id(agentId)}`),
    getPolicy: (agentId) => call('GET', `/v1/agents/${id(agentId)}/policy`),
    getBalances: (agentId, query = {}) => call('GET', `/v1/agents/${id(agentId)}/balances`, { query }),
    deposit: (agentId, request, { idempotencyKey = newKey() } = {}) =>
      call('POST', `/v1/agents/${id(agentId)}/deposit`, { body: request, idempotencyKey }),
    // A dry swap is a preview and takes no idempotency key; a withdrawal always
    // takes one, dry or not (the API answers idempotency_key_required).
    swap: (agentId, request, { idempotencyKey } = {}) =>
      call('POST', `/v1/agents/${id(agentId)}/swap`, { body: request, idempotencyKey: request.dry ? undefined : idempotencyKey ?? newKey(), grant: true }),
    withdraw: (agentId, request, { idempotencyKey = newKey() } = {}) =>
      call('POST', `/v1/agents/${id(agentId)}/withdraw`, { body: request, idempotencyKey, grant: true }),
    forGrant: (token) => agentHttp({ base, fetch: fetcher, grantToken: token }),
  };
}

/** generate, have the owner's wallet sign, submit, then follow the status. */
export async function runOwnerIntent(api, signTypedData, request, { onGenerated } = {}) {
  const generated = await api.generateIntent(request);
  const { intent } = generated;
  if (intent?.standard !== 'eip712') throw new Error(`expected an EIP-712 intent, got ${intent?.standard}`);
  onGenerated?.(generated);
  const signature = await signTypedData(intent.payload);
  await api.submitIntent({ type: generated.type, correlation_id: generated.correlation_id, signed_data: { ...intent, signature } });
  return waitForStatus(api, generated.correlation_id);
}
