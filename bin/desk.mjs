#!/usr/bin/env node
// Command line for the desk: price-impact ladder, dry-run orders, reports.
import fs from 'node:fs';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createOneClick, intentsQuoteBody, normalizeQuote } from '../src/oneclick.mjs';
import { resolveAsset } from '../src/assets.mjs';
import { prepareOrder } from '../src/order.mjs';
import { runOrder } from '../src/engine.mjs';
import { dryExecutor } from '../src/executors/dry.mjs';
import { realClock } from '../src/clock.mjs';
import { fileJournal, readJournal } from '../src/journal.mjs';
import { buildReport, renderReport } from '../src/report.mjs';
import { mulberry32 } from '../src/rng.mjs';
import { fromUnits, toUnits } from '../src/units.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `Usage:
  desk check
  desk impact --from <asset> --to <asset> [--usd 100,1000,10000] [--no-save]
  desk run <order.json> [--speed <n>] [--seed <n>] [--journal <file>]
  desk report <journal.jsonl> [--json]

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

const fmt = (value, digits = 2) =>
  value == null ? '-' : value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const orderClock = (ms) => {
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
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
    const body = intentsQuoteBody({ sellAsset: sell.assetId, buyAsset: buy.assetId, amount, account: 'dry-run.desk.near' });
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
      console.log(`${fmt(usd, 0).padStart(12)}   ${q.message} (HTTP ${q.status})`);
    }
  }
  if (!args['no-save']) {
    const file = path.join(ROOT, 'research', 'impact', `${sell.symbol}-${sell.blockchain}_${buy.symbol}-${buy.blockchain}_${stamp()}.json`.toLowerCase());
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const encode = (_k, v) => (typeof v === 'bigint' ? v.toString() : v);
    fs.writeFileSync(file, JSON.stringify({ takenAt, sell, buy, rows }, encode, 1) + '\n');
    console.log(`\nSnapshot with the raw quotes: ${path.relative(process.cwd(), file)}`);
  }
}

function describe(event, order, speed) {
  switch (event.type) {
    case 'order':
      return `Order ${order.id}: sell ${fmt(Number(order.amount), 2)} ${order.sell.symbol} (${order.sell.blockchain}) for ${order.buy.symbol} (${order.buy.blockchain}) ` +
        `in ${order.slices} slices over ${orderClock(order.horizonMs)} of order time. Seed ${event.seed}, ${event.mode} run, speed x${speed}.`;
    case 'arrival': {
      const p = event.probe.q;
      const o = event.oneShot.q;
      const probeText = p.ok
        ? `slice-size quote ${p.rate.toPrecision(6)} ${order.buy.symbol}/${order.sell.symbol}, cost ${fmt(p.costBps, 1)} bps`
        : `slice-size quote failed: ${p.message}`;
      const oneShotText = o.ok ? `whole order in one swap: cost ${fmt(o.costBps, 1)} bps` : `whole order in one swap: not executable (${o.message})`;
      return `Arrival: ${probeText}; ${oneShotText}.`;
    }
    case 'slice': {
      const q = event.quote.q;
      const size = `${fmt(Number(fromUnits(BigInt(event.slice.amount), order.sell.decimals)), 2)} ${order.sell.symbol}`;
      const price = q.ok ? `rate ${q.rate.toPrecision(6)}, cost ${fmt(q.costBps, 1)} bps` : q.message;
      return `[${orderClock(event.t)}] slice ${event.slice.id.padEnd(4)} ${size.padStart(18)}  ${price}  -> ${event.decision.action} (${event.decision.reason})`;
    }
    case 'skip':
      return `[${orderClock(event.t)}] slice ${event.sliceId} left unfilled (${event.reason})`;
    case 'abort':
      return `Aborted: ${event.message}`;
    default:
      return null;
  }
}

async function cmdRun(args, client) {
  const file = args._[1];
  if (!file) throw new Error('run needs an order file');
  if (args.live) {
    throw new Error('live mode needs the Agent API setup described in README.md; this build only runs dry');
  }
  const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  const tokens = await loadTokens(client);
  const order = prepareOrder(spec, tokens);
  const speed = args.speed ? Number(args.speed) : 1;
  const seed = args.seed !== undefined ? Number(args.seed) : randomInt(2 ** 31);
  const journalFile = args.journal ?? path.join(ROOT, 'journals', `${order.id}_${stamp()}.jsonl`);
  const journal = fileJournal(journalFile);

  await runOrder({
    order,
    client,
    executor: dryExecutor(),
    clock: realClock({ speed }),
    journal,
    rand: mulberry32(seed),
    seed,
    onEvent: (event) => {
      const line = describe(event, order, speed);
      if (line) console.log(line);
    },
  });

  const report = renderReport(buildReport(readJournal(journalFile)));
  const reportFile = journalFile.replace(/\.jsonl$/, '.md');
  fs.writeFileSync(reportFile, report);
  console.log(`\n${report}`);
  console.log(`Journal: ${path.relative(process.cwd(), journalFile)}\nReport:  ${path.relative(process.cwd(), reportFile)}`);
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
  const cases = [
    ['public swap inside NEAR Intents', {}],
    ['confidential swap inside NEAR Intents', {
      depositType: 'CONFIDENTIAL_INTENTS',
      refundType: 'CONFIDENTIAL_INTENTS',
      recipientType: 'CONFIDENTIAL_INTENTS',
    }],
  ];
  for (const [label, extra] of cases) {
    const body = { ...intentsQuoteBody({ sellAsset: sell.assetId, buyAsset: buy.assetId, amount, account: 'dry-run.desk.near' }), ...extra };
    const res = await client.quote(body);
    const q = normalizeQuote(res, { sellDecimals: sell.decimals, buyDecimals: buy.decimals, amountIn: amount });
    const detail = q.ok ? `ok, $1,000 USDC to SOL costs ${fmt(q.costBps, 1)} bps` : q.message;
    console.log(`${label.padEnd(40)} HTTP ${res.status}  ${detail}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadDotEnv(path.join(ROOT, '.env'));
  const apiKey = process.env.ONECLICK_API_KEY?.trim() || undefined;
  const client = createOneClick({ apiKey });
  switch (args._[0]) {
    case 'check':
      return cmdCheck(client, Boolean(apiKey));
    case 'impact':
      return cmdImpact(args, client);
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
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
});
