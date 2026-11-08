// A small Agent API client for the web desk. It talks to the site's own proxy
// (/api/agent), which adds the partner key, so the page never holds a key.
// Method names, arguments and error fields follow the official SDK, so the
// executor and the quote client in src/ run on it unchanged.
import { waitForStatus } from './status.mjs';
import { checkOwnerIntent } from './verify.mjs';

export class AgentHttpError extends Error {
  constructor(status, document, { retryAfter = null } = {}) {
    const first = document?.errors?.[0];
    super(first?.detail ?? first?.title ?? `HTTP ${status}`);
    this.name = 'AgentHttpError';
    this.status = status;
    this.code = first?.code ?? 'http_error';
    this.layer = first?.layer;
    // The same fields as the SDK's error, so the executor and the status
    // poller read them without knowing which client they run on.
    this.retryable = first?.meta?.retryable === true;
    const seconds = Number(retryAfter);
    this.retryAfterSeconds = retryAfter !== null && Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
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
    if (!res.ok) throw new AgentHttpError(res.status, json, { retryAfter: res.headers?.get?.('retry-after') ?? null });
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

/** An owner intent the page will not put in front of the wallet. */
export class OwnerIntentError extends Error {
  constructor(reason) {
    super(`The wallet was not asked to sign: ${reason}.`);
    this.name = 'OwnerIntentError';
  }
}

/**
 * Generate, check, have the owner's wallet sign, submit, then follow the
 * status. The generated intent is compared with the request before the wallet
 * sees it (checkOwnerIntent), since the proxy and the API sit between the page
 * and the wallet; `onGenerated` gets the API's own summary to show.
 * @param {{ owner: string, onGenerated?: (generated: object, summary: string | null) => void }} p
 */
export async function runOwnerIntent(api, signTypedData, request, { owner, onGenerated } = {}) {
  if (!owner) throw new Error('runOwnerIntent needs the owner address to check the intent');
  const generated = await api.generateIntent(request);
  const check = checkOwnerIntent(request, generated, { owner });
  if (!check.ok) throw new OwnerIntentError(check.reason);
  onGenerated?.(generated, check.summary);
  const signature = await signTypedData(generated.intent.payload);
  await api.submitIntent({ type: request.type, correlation_id: generated.correlation_id, signed_data: { ...generated.intent, signature } });
  const status = await waitForStatus(api, generated.correlation_id);
  if (request.type === 'agent_create' && status.agent_id && generated.agent_id && status.agent_id !== generated.agent_id) {
    throw new OwnerIntentError('the wallet made is not the one that was signed for');
  }
  return status;
}
