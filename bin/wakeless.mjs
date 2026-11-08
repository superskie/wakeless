#!/usr/bin/env node
// Wakeless command line: key check, price-impact ladder, dry-run orders, reports.
import fs from 'node:fs';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createOneClick, intentsQuoteBody, normalizeQuote, safeErrorText } from '../src/oneclick.mjs';
import { checkSecret } from '../src/env.mjs';
import { resolveAsset } from '../src/assets.mjs';
import { prepareOrder } from '../src/order.mjs';
import { runOrder } from '../src/engine.mjs';
import { dryExecutor } from '../src/executors/dry.mjs';
import { realClock } from '../src/clock.mjs';
import { fileJournal, readJournal, reportPathFor } from '../src/journal.mjs';
import { buildReport, renderReport } from '../src/report.mjs';
import { mulberry32 } from '../src/rng.mjs';
import { fromUnits, toUnits } from '../src/units.mjs';
import { describeEvent, fmt, printable } from '../src/describe.mjs';
import { adviceText, precheck } from '../src/precheck.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `Usage:
  wakeless check
  wakeless impact --from <asset> --to <asset> [--usd 100,1000,10000] [--no-save]
  wakeless plan <order.json> [--tolerance <bps>] [--json]
  wakeless run <order.json> [--speed <n>] [--seed <n>] [--journal <file>]
  wakeless report <journal.jsonl> [--json]

Assets are "symbol:chain" (usdc:arb, sol:sol, btc:btc, eth:eth) or a full
nep141 id. Every price comes from a live 1Click dry quote; nothing is signed
and no funds move.`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      args._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

async function loadTokens(client) {
  const res = await client.tokens();
  if (!res.ok || !Array.isArray(res.json)) {
    throw new Error(`could not load the 1Click token list (HTTP ${res.status}): ${JSON.stringify(res.json).slice(0, 200)}`);
  }
  return res.json;
}

async function cmdImpact(args, client) {
  if (!args.from || !args.to) throw new Error('impact needs --from and --to');
  const tokens = await loadTokens(client);
  const sell = resolveAsset(tokens, args.from);
  const buy = resolveAsset(tokens, args.to);
  if (!(sell.price > 0)) throw new Error(`no USD price for ${sell.ref}`);
  const sizes = String(args.usd ?? '100,1000,10000,100000,1000000')
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((x) => x > 0);

  const takenAt = new Date().toISOString();
  console.log(`Price impact ${sell.symbol} (${sell.blockchain}) -> ${buy.symbol} (${buy.blockchain}), 1Click dry quotes at ${takenAt}`);
  console.log(`${'size USD'.padStart(12)} ${`received ${buy.symbol}`.padStart(20)} ${'cost bps'.padStart(10)} ${'vs smallest'.padStart(12)}`);
  const rows = [];
  let baseCost = null;
  for (const usd of sizes) {
    const amount = BigInt(Math.round((usd / sell.price) * 10 ** sell.decimals));
    const body = intentsQuoteBody({ sellAsset: sell.assetId, buyAsset: buy.assetId, amount, account: 'dry-run.wakeless.near' });
    const res = await client.quote(body);
    const q = normalizeQuote(res, { sellDecimals: sell.decimals, buyDecimals: buy.decimals, amountIn: amount });
    rows.push({ usd, request: body, status: res.status, latencyMs: res.latencyMs, response: res.json, q });
    if (q.ok) {
      if (baseCost == null) baseCost = q.costBps;
      const received = fmt(Number(fromUnits(q.amountOut, buy.decimals)), 6);
      const delta = q.costBps - baseCost;
      const deltaText = `${delta >= 0 ? '+' : ''}${fmt(delta, 1)}`;
      console.log(`${fmt(usd, 0).padStart(12)} ${received.padStart(20)} ${fmt(q.costBps, 1).padStart(10)} ${deltaText.padStart(12)}`);
    } else {
      console.log(`${fmt(usd, 0).padStart(12)}   ${printable(q.message)} (HTTP ${q.status})`);
    }
  }
  console.log(
    `\nCost is measured against the USD prices 1Click returns with each quote and includes its platform fee ` +
      `(${client.hasKey ? 'partner schedule' : '25 bps without an API key'}). "vs smallest" isolates the effect of size.`,
  );
  if (!args['no-save']) {
    const file = path.join(ROOT, 'research', 'impact', `${sell.symbol}-${sell.blockchain}_${buy.symbol}-${buy.blockchain}_${stamp()}.json`.toLowerCase());
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const encode = (_k, v) => (typeof v === 'bigint' ? v.toString() : v);
    fs.writeFileSync(file, JSON.stringify({ takenAt, sell, buy, rows }, encode, 1) + '\n');
    console.log(`\nSnapshot with the raw quotes: ${path.relative(process.cwd(), file)}`);
  }
}

/** Pre-trade check: should this order be sliced, into how many, and what will the chain show? */
async function cmdPlan(args, client) {
  const file = args._[1];
  if (!file) throw new Error('plan needs an order file');
  const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  const tokens = await loadTokens(client);
  const order = prepareOrder(spec, tokens);
  const options = args.tolerance !== undefined ? { toleranceBps: Number(args.tolerance) } : {};
  const r = await precheck({ order, client, ...options });
  if (args.json) {
    const encode = (_k, v) => (typeof v === 'bigint' ? v.toString() : v);
    console.log(JSON.stringify(r, encode, 2));
    return;
  }
  const { sell, buy } = order;
  const signedBps = (v) => (v == null ? '-' : Math.abs(v) < 0.05 ? '+0.0' : `${v >= 0 ? '+' : ''}${fmt(v, 1)}`);
  console.log(`Pre-trade check: ${fmt(Number(order.amount), 2)} ${sell.symbol} (${sell.blockchain}) -> ${buy.symbol} (${buy.blockchain}), 1Click dry quotes at ${r.takenAt}`);
  console.log(`Size penalty: how much less ${buy.symbol} per ${sell.symbol} a slice receives than a $${fmt(r.referenceUsd, 0)} swap quoted the same minute.\n`);
  console.log(`${'slices'.padStart(8)} ${`slice ${sell.symbol}`.padStart(16)} ${'penalty bps'.padStart(13)} ${'vs one swap'.padStart(13)}`);
  for (const row of r.rows) {
    const size = fmt(Number(fromUnits(row.amount, sell.decimals)), 2);
    const cells = row.q.ok
      ? `${signedBps(row.penaltyBps).padStart(13)} ${signedBps(row.vsOneSwapBps).padStart(13)}`
      : `   ${printable(row.q.message)} (HTTP ${row.q.status})`;
    const mark = row.slices === r.recommendedSlices ? '  <' : '';
    console.log(`${String(row.slices).padStart(8)} ${size.padStart(16)} ${cells}${mark}`);
  }
  console.log(`\nAdvice: ${adviceText(r)}`);
  if (r.recommendedSlices && r.recommendedSlices !== order.slices) {
    console.log(`The order file asks for ${order.slices} slices; set "slices": ${r.recommendedSlices} to follow the advice.`);
  }

  const outAbout = r.pick?.q.ok ? fmt(Number(fromUnits(r.pick.q.amountOut, buy.decimals)) * r.pick.slices, 4) : null;
  console.log('\nWhat the public chain shows when this order runs live (node live/run.mjs):');
  console.log(`  start   one deposit of ${fmt(Number(order.amount), 2)} ${sell.symbol} on ${sell.blockchain}, to the agent's deposit address`);
  console.log(`  during  nothing on the public intents.near ledger: the slices settle in Confidential Intents balances`);
  console.log(`  end     one withdrawal of ${outAbout ? `about ${outAbout}` : 'the'} ${buy.symbol} to the one address the agent's policy allows`);
  console.log('          (an address with no history keeps the way out from pointing at the wallet that paid in;');
  console.log('           node live/agent.mjs allow-withdraw checks it before the owner signs)');
  console.log(`A public TWAP of the same order from one wallet would show every slice as a swap with its size and time.`);
}

async function cmdRun(args, client) {
  const file = args._[1];
  if (!file) throw new Error('run needs an order file');
  if (args.live) {
    throw new Error('live mode runs through the Agent API: node live/run.mjs <order.json> (see README.md)');
  }
  const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  const tokens = await loadTokens(client);
  const order = prepareOrder(spec, tokens);
  const speed = args.speed ? Number(args.speed) : 1;
  const seed = args.seed !== undefined ? Number(args.seed) : randomInt(2 ** 31);
  const journalFile = args.journal ?? path.join(ROOT, 'journals', `${order.id}_${stamp()}.jsonl`);
  // Both names are checked before the run: neither the journal nor its report may overwrite a file.
  const reportFile = reportPathFor(journalFile);
  const journal = fileJournal(journalFile);

  const result = await runOrder({
    order,
    client,
    executor: dryExecutor(),
    clock: realClock({ speed }),
    journal,
    rand: mulberry32(seed),
    seed,
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
  // A run that aborted or stopped early did not do what was asked: scripts see it in the exit code.
  if (result.aborted || result.halted) process.exitCode = 1;
}

function cmdReport(args) {
  const file = args._[1];
  if (!file) throw new Error('report needs a journal file');
  const report = buildReport(readJournal(file));
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else process.stdout.write(renderReport(report));
}

/**
 * Load KEY=value lines from a .env file without overriding the environment.
 * Accepts UTF-8 with or without BOM and UTF-16 LE, which Windows editors
 * sometimes write.
 */
function loadDotEnv(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8');
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/** Does the partner key work? Prints statuses only, never the key. */
async function cmdCheck(client, hasKey) {
  console.log(`Partner key: ${hasKey ? 'set (ONECLICK_API_KEY)' : 'not set; add it to .env for confidential quotes'}`);
  const tokens = await loadTokens(client);
  const sell = resolveAsset(tokens, 'usdc:arb');
  const buy = resolveAsset(tokens, 'sol:sol');
  const amount = toUnits('1000', sell.decimals);
  // Dry quotes never move funds, but 1Click still validates addresses. The
  // refund address is a hash of a fixed string, so nobody holds its key; the
  // recipient is the Solana incinerator.
  const placeholders = {
    depositType: 'ORIGIN_CHAIN',
    refundType: 'ORIGIN_CHAIN',
    refundTo: '0xc8832de6afbdb1ffd086302a9b24703ee61fb27c',
    recipientType: 'DESTINATION_CHAIN',
    recipient: '1nc1nerator11111111111111111111111111111111',
  };
  const cases = [
    ['public swap inside NEAR Intents', {}],
    // The foreign-to-foreign path from the Confidential Swaps quickstart: a
    // partner key is enough. Swaps between Confidential Intents balances also
    // need a signed user intent, which live mode gets through the Agent API.
    ['confidential swap, Arbitrum to Solana', { ...placeholders, confidentiality: 'basic' }],
  ];
  let rejected = false;
  for (const [label, extra] of cases) {
    const body = { ...intentsQuoteBody({ sellAsset: sell.assetId, buyAsset: buy.assetId, amount, account: 'dry-run.wakeless.near' }), ...extra };
    const res = await client.quote(body);
    const q = normalizeQuote(res, { sellDecimals: sell.decimals, buyDecimals: buy.decimals, amountIn: amount });
    const detail = q.ok ? `ok, ${fmt(Number(fromUnits(q.amountOut, buy.decimals)), 6)} SOL for $1,000 USDC` : printable(q.message);
    console.log(`${label.padEnd(40)} HTTP ${res.status}  ${detail}`);
    if (hasKey && res.status === 401 && /invalid token/i.test(q.message)) rejected = true;
  }
  if (rejected) {
    console.log(
      '\n1Click rejected ONECLICK_API_KEY, so every quote fails while it is set. Partner keys are JWTs from ' +
        'https://partners.near-intents.org/home. A key starting with sk- is a NEAR AI Cloud key. ' +
        'Clear the variable to run dry quotes without a key.',
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadDotEnv(path.join(ROOT, '.env'));
  const apiKey = process.env.ONECLICK_API_KEY?.trim() || undefined;
  // A key with a stray control character would be quoted in full by fetch's error.
  if (apiKey) checkSecret('ONECLICK_API_KEY', apiKey);
  const client = createOneClick({ apiKey });
  switch (args._[0]) {
    case 'check':
      return cmdCheck(client, Boolean(apiKey));
    case 'impact':
      return cmdImpact(args, client);
    case 'plan':
      return cmdPlan(args, client);
    case 'run':
      return cmdRun(args, client);
    case 'report':
      return cmdReport(args);
    default:
      console.log(USAGE);
      process.exitCode = args._[0] ? 1 : 0;
  }
}

main().catch((err) => {
  console.error(`error: ${printable(safeErrorText(err, [process.env.ONECLICK_API_KEY?.trim()]))}`);
  process.exitCode = 1;
});
