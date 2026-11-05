#!/usr/bin/env node
// What the public chain shows for an agent: its balances on the public
// intents.near ledger, next to the confidential balances the Agent API reports
// when the agent's keys are in .env. The public half needs no keys.
//
//   node live/public-view.mjs [near account id] [asset id ...]
const RPC = 'https://rpc.mainnet.near.org';
const DEFAULT_ASSETS = [
  'nep141:base.omft.near',
  'nep141:sol.omft.near',
  'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
];

async function publicBalances(accountId, assets) {
  const args = Buffer.from(JSON.stringify({ account_id: accountId, token_ids: assets })).toString('base64');
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'query',
      params: { request_type: 'call_function', finality: 'final', account_id: 'intents.near', method_name: 'mt_batch_balance_of', args_base64: args },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = await res.json();
  if (!json.result?.result) throw new Error(`NEAR RPC: ${JSON.stringify(json.error ?? json).slice(0, 200)}`);
  const values = JSON.parse(Buffer.from(json.result.result).toString());
  return { block: json.result.block_height, balances: Object.fromEntries(assets.map((a, i) => [a, values[i]])) };
}

/** Confidential balances from the Agent API, when this checkout has the agent's keys. */
async function confidentialView() {
  try {
    const { agentApi, readEnv } = await import('./lib.mjs');
    const env = readEnv();
    if (!env.NEAR_INTENTS_AGENT_API_KEY || !env.WAKELESS_AGENT_ID) return null;
    const api = agentApi(env);
    const [agent, conf] = await Promise.all([
      api.getAgent(env.WAKELESS_AGENT_ID),
      api.getBalances(env.WAKELESS_AGENT_ID, { source: 'confidential' }),
    ]);
    return { account: agent.wallet.near_account_id, balances: Object.fromEntries(conf.balances.map((b) => [b.asset_id, b.balance_raw])) };
  } catch {
    return null; // no SDK installed or no keys: show the public side only
  }
}

async function main() {
  const [accountArg, ...assetArgs] = process.argv.slice(2);
  const confidential = await confidentialView();
  const account = accountArg ?? confidential?.account;
  if (!account) throw new Error('usage: node live/public-view.mjs <near account id> [asset id ...]');
  const assets = assetArgs.length ? assetArgs : [...new Set([...DEFAULT_ASSETS, ...Object.keys(confidential?.balances ?? {})])];
  const pub = await publicBalances(account, assets);

  console.log(`Account ${account}`);
  console.log(`Public intents.near ledger at block ${pub.block}${confidential ? ', next to the Agent API confidential balance' : ''}:\n`);
  console.log(`${'asset'.padEnd(68)} ${'public'.padStart(20)}${confidential ? ` ${'confidential'.padStart(20)}` : ''}`);
  for (const asset of assets) {
    const conf = confidential ? ` ${String(confidential.balances[asset] ?? '0').padStart(20)}` : '';
    console.log(`${asset.padEnd(68)} ${String(pub.balances[asset]).padStart(20)}${conf}`);
  }
  console.log('\nAmounts are in base units. Anyone can repeat the public column with this script and the account id alone.');
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
});
