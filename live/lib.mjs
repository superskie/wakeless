// Shared plumbing for Wakeless live mode on the NEAR Intents Agent API.
// Secrets come from the repository's .env and are never printed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentApi } from '@near-intents-agent-api/sdk';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { waitForStatus } from './status.mjs';

export { waitForStatus };

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ENV_FILE = path.join(ROOT, '.env');

/** Parse .env (UTF-8 or UTF-16 LE) into an object without touching process.env. */
export function readEnv(file = ENV_FILE) {
  if (!fs.existsSync(file)) return {};
  const buf = fs.readFileSync(file);
  const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8');
  const out = {};
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    out[line.slice(0, eq).trim()] = value;
  }
  return { ...out, ...pick(process.env, Object.keys(out)) };
}

function pick(source, keys) {
  return Object.fromEntries(keys.filter((k) => source[k] !== undefined && source[k] !== '').map((k) => [k, source[k]]));
}

/** Append KEY=value lines to .env. Refuses to overwrite a key that already has a value. */
export function appendEnv(entries, comment) {
  const current = readEnv();
  const lines = [];
  for (const [key, value] of Object.entries(entries)) {
    if (current[key]) throw new Error(`${key} is already set in .env; remove it first to replace it`);
    lines.push(`${key}=${value}`);
  }
  const prefix = fs.existsSync(ENV_FILE) && !fs.readFileSync(ENV_FILE, 'utf8').endsWith('\n') ? '\n' : '';
  fs.appendFileSync(ENV_FILE, `${prefix}${comment ? `# ${comment}\n` : ''}${lines.join('\n')}\n`);
}

export function required(env, key, hint) {
  const value = env[key];
  if (!value) throw new Error(`${key} is not set in .env${hint ? ` (${hint})` : ''}`);
  return value;
}

export function agentApi(env = readEnv()) {
  return createAgentApi({
    apiKey: required(env, 'NEAR_INTENTS_AGENT_API_KEY', 'create one in the partner dashboard'),
    baseUrl: env.NEAR_INTENTS_AGENT_API_URL || undefined,
  });
}

/**
 * The owner: a throwaway EVM key kept in .env. The API derives a NEAR account
 * from its public key and sponsors its deployment, so it needs no NEAR and no
 * funds. It only signs the agent's rules and grants; it never holds money.
 */
export function loadOwner(env = readEnv()) {
  const key = required(env, 'AGENT_OWNER_EVM_PRIVATE_KEY', 'run: node live/agent.mjs owner');
  const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`);
  return {
    account,
    owner: {
      type: 'evm',
      address: account.address.toLowerCase(),
      chain_id: 1,
      public_key: `0x${account.publicKey.slice(4)}`,
    },
  };
}

export function createOwnerKey() {
  return generatePrivateKey();
}

/** Signs a generated owner intent with EIP-712, unchanged, like a wallet would. */
export async function signEvmIntent(account, generated) {
  const { intent } = generated;
  if (intent.standard !== 'eip712') throw new Error(`expected an eip712 intent, got ${intent.standard}`);
  const signature = await account.signTypedData(intent.payload);
  return { ...intent, signature };
}

/** generate, sign with the owner key, submit, then follow the status. */
export async function runOwnerIntent(api, account, request) {
  const generated = await api.generateIntent(request, { idempotencyKey: crypto.randomUUID() });
  const signed = await signEvmIntent(account, generated);
  await api.submitIntent({ type: generated.type, correlation_id: generated.correlation_id, signed_data: signed });
  return waitForStatus(api, generated.correlation_id);
}

/**
 * The Wakeless rulebook, signed once by the owner at creation:
 * - the agent may only swap; it can not transfer or withdraw anywhere
 *   (`allow-withdraw` later adds withdrawals to the owner's one address),
 * - the confidential form of each action is allowed (the desk always uses it),
 * - a USD budget and an hourly action cap bound what a leaked grant could do,
 * - the owner can freeze it at any time.
 */
export function wakelessPolicy({ dailyUsd = '250', maxActionsPerHour = 120 } = {}) {
  return {
    frozen: false,
    actions: ['swap'],
    confidential: true,
    owner_approval: false,
    assets: 'any',
    limits: {},
    max_actions_per_hour: maxActionsPerHour,
    destinations: { mode: 'only', list: [] },
    budget: { daily_usd: dailyUsd, weekly_usd: null, monthly_usd: null },
    timelock_ms: 0,
  };
}

/** JSON with bigint support, for printing API responses. */
export function show(value) {
  console.log(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
}
