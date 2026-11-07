#!/usr/bin/env node
// Wakeless agent lifecycle on the NEAR Intents Agent API.
//
//   node live/agent.mjs owner              create the throwaway EVM owner key (.env)
//   node live/agent.mjs create             create the agent with the Wakeless policy
//   node live/agent.mjs grant              issue the desk's grant token (.env)
//   node live/agent.mjs status             agent, policy and balances
//   node live/agent.mjs deposit <asset> [amount]   deposit address; funds land in the confidential balance
//   node live/agent.mjs shield <asset> <amount>    move a public balance into the confidential one
//   node live/agent.mjs allow-withdraw <chain> <address>   owner signs: withdrawals only to this address
//   node live/agent.mjs withdraw <asset> <amount> <chain> <address> [--execute]   preview, or withdraw
//   node live/agent.mjs quote <from> <to> <amount> preview a swap (dry, no funds move)
//
// Assets are full asset ids as listed by GET /v1/tokens (for example
// nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near).
import { createGrantCredential, createIdempotencyKey } from '@near-intents-agent-api/sdk';
import { agentApi, appendEnv, createOwnerKey, loadOwner, readEnv, required, runOwnerIntent, show, waitForStatus, wakelessPolicy } from './lib.mjs';
import { describeExit, exitAddressHistory } from './exit-check.mjs';

const [command, ...args] = process.argv.slice(2);

async function main() {
  const env = readEnv();
  switch (command) {
    case 'owner': {
      if (!env.AGENT_OWNER_EVM_PRIVATE_KEY) {
        appendEnv({ AGENT_OWNER_EVM_PRIVATE_KEY: createOwnerKey() }, 'Throwaway EVM owner for the Wakeless agent. Signs rules only, never holds funds.');
      }
      const { owner } = loadOwner(readEnv());
      console.log(`Owner address: ${owner.address} (the key stays in .env)`);
      return;
    }
    case 'create': {
      if (env.WAKELESS_AGENT_ID) throw new Error(`an agent already exists: ${env.WAKELESS_AGENT_ID}`);
      const api = agentApi(env);
      const { account, owner } = loadOwner(env);
      const policy = wakelessPolicy();
      console.log('Creating the agent. Policy the owner signs:');
      show(policy);
      const status = await runOwnerIntent(api, account, { type: 'agent_create', name: 'Wakeless desk', owner, policy });
      if (status.status !== 'SUCCESS' || !status.agent_id) throw new Error(`agent_create ended ${status.status}: ${status.failure_code ?? 'no failure code'}`);
      appendEnv({ WAKELESS_AGENT_ID: status.agent_id }, 'Wakeless agent on the Agent API');
      const agent = await api.getAgent(status.agent_id);
      show({ agent_id: agent.id, status: agent.status, wallet: agent.wallet, owner_account: agent.owner_account });
      return;
    }
    case 'grant': {
      if (env.WAKELESS_GRANT_TOKEN) throw new Error('a grant token is already stored in .env');
      const api = agentApi(env);
      const { account } = loadOwner(env);
      const agentId = required(env, 'WAKELESS_AGENT_ID', 'run: node live/agent.mjs create');
      const credential = createGrantCredential();
      const status = await runOwnerIntent(api, account, {
        type: 'grant_issue',
        agent_id: agentId,
        label: 'wakeless-desk',
        credential: credential.commitment,
        expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      });
      if (status.status !== 'SUCCESS' || !status.details?.grant) throw new Error(`grant_issue ended ${status.status}: ${status.failure_code ?? 'no failure code'}`);
      appendEnv({ WAKELESS_GRANT_TOKEN: credential.token }, 'Grant token for the Wakeless desk (secret)');
      const grant = status.details.grant;
      show({ grant_id: grant.grant_id, label: grant.label, expires_at: grant.expires_at, token: 'stored in .env' });
      return;
    }
    case 'status': {
      const api = agentApi(env);
      const agentId = required(env, 'WAKELESS_AGENT_ID');
      const [agent, policy, pub, conf] = await Promise.all([
        api.getAgent(agentId),
        api.getPolicy(agentId),
        api.getBalances(agentId, { source: 'public' }),
        api.getBalances(agentId, { source: 'confidential' }),
      ]);
      show({
        agent: { id: agent.id, status: agent.status, wallet: agent.wallet },
        policy: { revision: policy.revision, policy: policy.policy },
        balances: {
          public: pub.balances.map((b) => ({ asset_id: b.asset_id, balance_raw: b.balance_raw, available_raw: b.available_raw })),
          confidential: conf.balances.map((b) => ({ asset_id: b.asset_id, balance_raw: b.balance_raw, available_raw: b.available_raw })),
        },
      });
      return;
    }
    case 'deposit': {
      const api = agentApi(env);
      const agentId = required(env, 'WAKELESS_AGENT_ID');
      const [asset, amount] = args;
      if (!asset) throw new Error('usage: deposit <asset id> [amount in base units]');
      // The desk swaps in confidential form, which spends the confidential balance.
      const status = await api.deposit(
        agentId,
        { origin_asset: asset, ...(amount ? { amount } : {}), confidential: true },
        { idempotencyKey: createIdempotencyKey() },
      );
      const d = status.details;
      show({
        correlation_id: status.correlation_id,
        status: status.status,
        confidential: d.confidential ?? true,
        deposit_address: d.deposit_address,
        memo: d.memo ?? null,
        min_amount: d.min_amount,
        expires_at: d.expires_at,
        refund_to: d.refund_to,
      });
      return;
    }
    case 'shield': {
      const api = agentApi(env);
      const agentId = required(env, 'WAKELESS_AGENT_ID');
      const bot = api.forGrant(required(env, 'WAKELESS_GRANT_TOKEN', 'run: node live/agent.mjs grant'));
      const [asset, amount] = args;
      if (!asset || !amount) throw new Error('usage: shield <asset id> <amount in base units>');
      const started = await bot.shield(agentId, { asset, amount }, { idempotencyKey: createIdempotencyKey() });
      const final = await waitForStatus(api, started.correlation_id);
      show({ correlation_id: final.correlation_id, status: final.status, failure_code: final.failure_code });
      return;
    }
    case 'allow-withdraw': {
      // The owner signs a new policy revision: the agent may also withdraw, but
      // only to this one chain address. Any other recipient is refused.
      const [chain, address] = args;
      if (!chain || !address) throw new Error('usage: allow-withdraw <chain> <address>');
      // Show the owner what this exit address would link the order to before signing.
      console.log(describeExit(await exitAddressHistory({ chain, address })));
      const api = agentApi(env);
      const { account } = loadOwner(env);
      const agentId = required(env, 'WAKELESS_AGENT_ID');
      const current = await api.getPolicy(agentId);
      if (!current.policy || current.revision == null) throw new Error('the agent has no applied policy yet');
      const policy = {
        ...current.policy,
        actions: [...new Set([...current.policy.actions, 'withdraw'])],
        destinations: { mode: 'only', list: [{ action: 'withdraw', chain, address, memo: null }] },
      };
      console.log(`Policy revision ${current.revision} -> new revision. Actions ${policy.actions.join(', ')}; withdrawals only to ${chain}:${address}.`);
      const status = await runOwnerIntent(api, account, { type: 'policy_update', agent_id: agentId, expected_revision: current.revision, policy });
      if (status.status !== 'SUCCESS') throw new Error(`policy_update ended ${status.status}: ${status.failure_code ?? 'no failure code'}`);
      const after = await api.getPolicy(agentId);
      show({ revision: after.revision, provider_policy_synced: after.provider_policy_synced, actions: after.policy.actions, destinations: after.policy.destinations });
      return;
    }
    case 'withdraw': {
      // Preview by default; --execute withdraws for real, only if the preview has no warnings.
      const execute = args.includes('--execute');
      const [asset, amount, chain, recipient] = args.filter((a) => !a.startsWith('--'));
      if (!asset || !amount || !chain || !recipient) throw new Error('usage: withdraw <asset> <amount in base units> <chain> <address> [--execute]');
      const api = agentApi(env);
      const agentId = required(env, 'WAKELESS_AGENT_ID');
      const bot = api.forGrant(required(env, 'WAKELESS_GRANT_TOKEN', 'run: node live/agent.mjs grant'));
      // The desk's funds sit in the confidential balance.
      const body = { asset, amount, chain, recipient, confidential: true };
      const preview = await bot.withdraw(agentId, { ...body, dry: true });
      show({ preview: preview.quote ?? null, fee: preview.fee ?? null, warnings: (preview.warnings ?? []).map((w) => w.code) });
      if (!execute) return;
      if (preview.warnings?.length) throw new Error('the preview has warnings; nothing was withdrawn');
      const started = await bot.withdraw(agentId, { ...body, async: true }, { idempotencyKey: createIdempotencyKey() });
      const final = await waitForStatus(api, started.correlation_id, 900_000);
      const d = final.details ?? {};
      show({ correlation_id: final.correlation_id, status: final.status, failure_code: final.failure_code, amount_out: d.amount_out ?? null, tx_hash: d.tx_hash ?? null, destination_tx_hash: d.destination_tx_hash ?? null });
      return;
    }
    case 'quote': {
      const api = agentApi(env);
      const agentId = required(env, 'WAKELESS_AGENT_ID');
      const token = required(env, 'WAKELESS_GRANT_TOKEN', 'run: node live/agent.mjs grant');
      const [from, to, amount] = args;
      if (!from || !to || !amount) throw new Error('usage: quote <from asset> <to asset> <amount in base units>');
      const bot = api.forGrant(token);
      const preview = await bot.swap(agentId, { origin_asset: from, destination_asset: to, amount, confidential: true, dry: true });
      show(preview);
      return;
    }
    default:
      console.log(
        'commands: owner | create | grant | status | deposit <asset> [amount] | shield <asset> <amount> | ' +
          'allow-withdraw <chain> <address> | withdraw <asset> <amount> <chain> <address> [--execute] | quote <from> <to> <amount>',
      );
  }
}

main().catch((err) => {
  const detail = err?.body ?? err?.errors ?? err?.response ?? null;
  console.error(`error: ${err.message}`);
  if (detail) console.error(JSON.stringify(detail).slice(0, 1200));
  process.exitCode = 1;
});
