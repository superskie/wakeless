#!/usr/bin/env node
// Work an order through the Wakeless agent on the NEAR Intents Agent API.
import fs from 'node:fs';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { prepareOrder } from '../src/order.mjs';
import { runOrder, scheduleFor } from '../src/engine.mjs';
import { realClock } from '../src/clock.mjs';
import { fileJournal, readJournal, reportPathFor } from '../src/journal.mjs';
import { buildReport, renderReport } from '../src/report.mjs';
import { mulberry32 } from '../src/rng.mjs';
import { fromUnits } from '../src/units.mjs';
import { describeEvent, printable } from '../src/describe.mjs';
import { safeErrorText } from '../src/oneclick.mjs';
import { agentApi, readEnv, required, ROOT } from './lib.mjs';
import { agentQuoteClient, priceBook } from '../src/agent/quotes.mjs';
import { agentExecutor } from '../src/executors/agent.mjs';
import { checkSliceCap } from '../src/agent/cap.mjs';

const USAGE = `Usage:
  node live/run.mjs <order.json> [--speed <n>] [--seed <n>] [--journal <file>]
      Preview (default). Every price is the agent's own swap preview, requested
      through its grant and checked against its signed policy. Nothing is
      submitted and no funds move.
  node live/run.mjs <order.json> --live --confirm [--speed <n>] [--seed <n>]
      Live. Each slice that clears the floor is submitted as a confidential
      swap whose minimum output is the floor. Spends the agent's balance.
      Runs only when the wallet's policy caps the swap size at one slice
      (node live/agent.mjs cap <order.json>).

Needs NEAR_INTENTS_AGENT_API_KEY, WAKELESS_AGENT_ID and WAKELESS_GRANT_TOKEN
in .env (node live/agent.mjs owner, create, grant).`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      args._.push(a);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[a.slice(2)] = true;
    else {
      args[a.slice(2)] = next;
      i++;
    }
  }
  return args;
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = args._[0];
  if (!file || args.help) {
    console.log(USAGE);
    process.exitCode = file ? 0 : 1;
    return;
  }
  const live = Boolean(args.live);
  if (live && !args.confirm) throw new Error("live mode spends the agent's balance; add --confirm to go ahead");

  const env = readEnv();
  const api = agentApi(env);
  const agentId = required(env, 'WAKELESS_AGENT_ID', 'run: node live/agent.mjs create');
  const bot = api.forGrant(required(env, 'WAKELESS_GRANT_TOKEN', 'run: node live/agent.mjs grant'));

  const [agent, policyView] = await Promise.all([api.getAgent(agentId), api.getPolicy(agentId)]);
  if (agent.status !== 'ACTIVE') throw new Error(`agent ${agentId} is ${agent.status}`);
  const policy = policyView.policy;
  if (policy.frozen) throw new Error('the agent is frozen by its owner');

  const prices = priceBook(api);
  const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  const order = prepareOrder({ ...spec, deskAccount: agent.wallet.near_account_id }, await prices.tokens());

  console.log(
    `Agent ${agentId.slice(0, 8)}... policy revision ${policyView.revision}: actions ${policy.actions.join(', ')}, ` +
      `confidential ${policy.confidential ? 'allowed' : 'not allowed'}, budget $${policy.budget?.daily_usd ?? '-'} a day.`,
  );

  const speed = args.speed ? Number(args.speed) : 1;
  const seed = args.seed !== undefined ? Number(args.seed) : randomInt(2 ** 31);
  // The same seed draws the same schedule inside runOrder.
  const schedule = scheduleFor(order, mulberry32(seed));
  const cap = checkSliceCap(policy, { assetId: order.sell.assetId, schedule, total: order.totalUnits });
  const sym = order.sell.symbol;
  const units = (v) => `${fromUnits(v, order.sell.decimals)} ${sym}`;
  const capLine = {
    capped: `Wallet cap: no swap above ${units(cap.perSwap ?? 0n)}${cap.perDay != null ? `, at most ${units(cap.perDay)} a day` : ''}; this run's largest slice is ${units(cap.largest)}.`,
    no_cap: `Wallet cap: none. The wallet would accept all ${order.amount} ${sym} as one swap.`,
    cap_allows_whole_order: `Wallet cap: ${units(cap.perSwap ?? 0n)} per swap, which lets the whole order through as one swap.`,
    cap_below_slice: `Wallet cap: ${units(cap.perSwap ?? 0n)} per swap, below this run's largest slice of ${units(cap.largest)}.`,
    no_daily_cap: `Wallet cap: ${units(cap.perSwap ?? 0n)} per swap, but no daily limit, so a slice sent twice could sell more than the order.`,
    daily_above_order: `Wallet cap: ${units(cap.perSwap ?? 0n)} per swap, but up to ${units(cap.perDay ?? 0n)} a day, more than the order.`,
    daily_below_order: `Wallet cap: at most ${units(cap.perDay ?? 0n)} a day, less than the order.`,
  }[cap.reason];
  console.log(capLine);
  if (live && !cap.ok) {
    throw new Error(
      `the desk trades live only from a wallet that refuses any swap larger than one slice and any sale beyond the order in a day; ` +
        `have the owner sign the cap first: node live/agent.mjs cap ${file}`,
    );
  }

  if (live) {
    const { balances } = await api.getBalances(agentId, { source: 'confidential' });
    const entry = balances.find((b) => b.asset_id === order.sell.assetId);
    const available = BigInt(entry?.available_raw ?? 0);
    if (available < order.totalUnits) {
      throw new Error(
        `the agent's confidential balance holds ${fromUnits(available, order.sell.decimals)} ${order.sell.symbol} and the order needs ${order.amount}; ` +
          'fund it first with node live/agent.mjs deposit <asset> <amount>, or shield a public balance',
      );
    }
    console.log(`LIVE: up to ${order.amount} ${order.sell.symbol} of the agent's confidential balance will be swapped.`);
  } else {
    console.log('Preview: quotes come from the agent; nothing is submitted and no funds move.');
  }

  const mode = live ? 'live' : 'preview';
  const journalFile = args.journal ?? path.join(ROOT, 'journals', `${order.id}_${mode}_${stamp()}.jsonl`);
  // The journal is the only record of idempotency keys and correlation ids: never overwrite or append to one.
  const reportFile = reportPathFor(journalFile);
  const journal = fileJournal(journalFile);

  const result = await runOrder({
    order,
    client: agentQuoteClient({ bot, agentId, prices, confidential: true }),
    executor: agentExecutor({ api, bot, agentId, mode, confidential: true }),
    clock: realClock({ speed }),
    journal,
    rand: mulberry32(seed),
    seed,
    walletCap: {
      revision: policyView.revision,
      reason: cap.reason,
      perSwap: cap.perSwap?.toString() ?? null,
      perDay: cap.perDay?.toString() ?? null,
      largestSlice: cap.largest.toString(),
    },
    onEvent: (event) => {
      const line = describeEvent(event, order, speed);
      if (line) console.log(line);
    },
  });

  journal.close();
  const report = renderReport(buildReport(readJournal(journalFile)));
  fs.writeFileSync(reportFile, report, { flag: 'wx' });
  console.log(`\n${report}`);
  console.log(`Journal: ${path.relative(process.cwd(), journalFile)}\nReport:  ${path.relative(process.cwd(), reportFile)}`);
  // An aborted or stopped run needs a person (an UNKNOWN or TIMEOUT slice above all): say so in the exit code.
  if (result.aborted || result.halted) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`error: ${printable(safeErrorText(err))}`);
  process.exitCode = 1;
});
