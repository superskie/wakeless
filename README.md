# Wakeless

Works a large cross-chain swap in randomized slices through NEAR Intents, so
the order pays less price impact and leaves no pattern for wallet watchers to
trade against. A large order leaves a wake; the name is the goal.

Built at NEAR HACKATHON (1 to 14 November 2026). Tracks: Unstoppable DeFi
(`defi`), Agent Economy (`agents`), Privacy & Private AI (`privacy`).

## The problem

One large swap pays for its own size. Extra cost of one swap against a $1,000
swap of the same pair, both quoted by the NEAR Intents 1Click API at the same
moment ([raw quotes](research/impact/), one file per pair and time):

| Pair | Taken (UTC) | $100,000 | $500,000 | $1,000,000 |
| --- | --- | ---: | ---: | ---: |
| USDC (Arbitrum) to SOL | 5 Nov 2026, 02:30 | +8.9 bps | +24.5 bps | no quote |
| USDC (Arbitrum) to SOL | 7 Nov 2026, 07:51 | +5.7 bps | +8.7 bps | no quote |
| ETH (Ethereum) to SOL | 7 Nov 2026, 07:51 | +9.4 bps | +13.0 bps | no quote |
| USDC (Solana) to ETH (Ethereum) | 7 Nov 2026, 07:51 | +4.1 bps | +7.3 bps | +18.1 bps |

"No quote" is 1Click answering "No liquidity available": above what the
solvers fill at once, one swap does not happen at all. The penalty moves with
the day's liquidity. The same pair cost 24.5 bps extra at $500,000 on
5 November and 8.7 bps two days later.

Trading desks split such orders over time (TWAP). Done in public, the schedule
itself leaks. On Hyperliquid a TWAP is an on-chain action that carries the
wallet, market, side, total size and duration. On 7 November 2026 at 08:28 UTC
a public tracker listed 416 running TWAPs with about $40M ordered, including
ones flagged as randomized ([vike.io](https://vike.io/hyperliquid/twaps)), and
an open-source library reports each slice of a tracked TWAP within about half
a second
([hyperliquid-twap-watcher](https://github.com/LoveBloodAndDiamonds/hyperliquid-twap-watcher)).
Random slice sizes do not hide an order whose total is public. From a normal
wallet on any chain, every slice is a public transaction from the same
address, which tells observers how much is still coming.

## What it does

1. Splits the order into slices with random sizes and random times inside
   their own time slots. The schedule comes from a seed, so it can be replayed.
2. Quotes each slice live through 1Click with every leg inside NEAR Intents
   (`depositType`, `refundType` and `recipientType` are all `INTENTS`), so a
   slice pays no bridge or withdrawal fee.
3. Executes a slice only when its quote is at or above a floor: the price at
   arrival minus the move the client accepts (`maxAdverseBps`). Below the
   floor the slice waits for a later slot, then is left unfilled. The floor is
   never lowered to finish an order. A slice that finds no liquidity is split
   in two.
4. Writes every decision with the raw quote to a JSONL journal and builds the
   execution report from that journal alone.

## Try it

Needs Node 22 or later. No keys, no funds, no dependencies to install.

```sh
git clone https://github.com/superskie/wakeless && cd wakeless
```

**Do** `npm test`. **See** 51 passing tests: schedule totals are exact to the
base unit, no fill is ever below the floor, oversized slices split until they
clear, the report math matches a hand-computed case, and live mode, run
against an Agent API double, submits each slice once, in confidential form,
with the floor as its minimum output, and stops when it should. The
pre-trade check picks the fewest slices that fit and is not fooled by one
lucky quote, and the exit check flags an address with history.

**Do** `npm run impact`. **See** live 1Click quotes for $1,000 to $1,000,000
of USDC (Arbitrum) to SOL (Solana). Cost rises with size, and the largest size
usually returns "No liquidity available". The raw responses are saved to
`research/impact/`. Liquidity changes during the day, so numbers differ from
the table above.

**Do** `node bin/wakeless.mjs plan examples/usdc-arb-to-sol.json`. **See** a
pre-trade check with live quotes: the order cut into 1 to 64 slices, the size
penalty of each slice size against a $1,000 swap quoted the same minute, and
advice. The advice is the fewest slices from which every larger count tried
stays within 2 bps of the $1,000 swap, or one swap when the whole order
already does. One quote per size is noisy (on 7 November the same 16-slice
size read +1.8 bps and, a minute later, +17.4 bps), which is why one lucky
reading cannot set the advice. Last, the three things the public chain shows
when the order runs live: one deposit, nothing during, one withdrawal.

**Do** `npm run demo`. **See** a $500,000 order worked in 16 slices: one line
per slice with its live quote and decision, then the report. The 30-minute
schedule runs 60 times faster (about 45 seconds); every quote is live. The
report compares the SOL the slices received with one swap of the whole order
quoted at arrival.

**Do** `node bin/wakeless.mjs report examples/sample-run.jsonl`. **See** the
report in [examples/sample-run.md](examples/sample-run.md) rebuilt offline from
the committed journal of a run on 5 November 2026: the 16 slices received
23.1 bps more SOL than one swap of the whole $500,000 quoted at arrival, about
$1,150. The run was compressed, so the market had little time to move, and at
arrival a slice-sized quote already cost 22.6 bps less than the one-swap quote
taken at the same moment.

**Do** `node bin/wakeless.mjs report examples/sample-run-2026-11-07.jsonl`.
**See** the same order run again on 7 November 2026, when the pair was deeper:
+4.5 bps more SOL than one swap, about $224. At arrival the slice-sized quote
cost 7.0 bps less than the one-swap quote, and later slices were quoted
worse rates than the first (20.7 bps rising to 25.0 bps). The saving is the
size penalty the slices avoid, so it follows the day's liquidity, and
`npm run demo` will print its own number for the market you run it in.

**Do** open https://wakeless.pages.dev, or run `npm run web` and open
`http://localhost:8787/web/`. **See** the web desk: a live price-impact chart
for the order size, a ticket that works an order as a dry run in the browser
against live 1Click quotes (no wallet, no key) after an optional pre-trade
check, replays of the two committed
$500,000 runs, what a public TWAP and Wakeless
each leave on the chain, and the mainnet run below with links to its Base
transactions.

**Do** `node bin/wakeless.mjs check`. **See** whether a partner key is set and the
HTTP status of a public and a confidential dry quote. Without a key the
confidential quote returns 401; the key is never printed.

Your own order: copy `examples/usdc-arb-to-sol.json`, change `sell`, `buy`
and `amount` (assets are `symbol:chain`, such as `usdc:arb`, `eth:eth`,
`sol:sol`), then `node bin/wakeless.mjs run your-order.json --speed 60`.

## How the report measures cost

All costs are in basis points of the input value, measured against the USD
prices 1Click returns with each quote.

- Execution cost: each fill's cost, weighted by size. Fees, spread and price
  impact.
- Implementation shortfall: realized rate against the price at arrival.
  Execution cost plus whatever the market did while the order was worked.
- One-shot alternative: the whole order quoted as a single swap at arrival.
  The comparison uses the amounts received, not USD prices.
- When the USD prices did not change while the order was worked (they update
  every few minutes), the report says so and does not split a market move
  from execution cost.

Every cost includes the 1Click platform fee: 25 bps without an API key, and
with one 20 bps, or 1 bp on stablecoin pairs
([fees](https://docs.near-intents.org/resources/fees)). The fee is a
percentage, so slicing does not add fees, and it cancels out of the
comparison with one swap. The USD prices can lag the market by a few bps, so
only numbers taken at the same moment are compared.

## What is specific to NEAR

- NEAR Intents 1Click quotes 215 tokens on 38 chains through one API
  (`GET /v0/tokens`, 5 November 2026), so the same desk works any pair.
- Slices settle between NEAR Intents balances instead of as separate
  cross-chain transfers: one deposit in, one withdrawal out.
- Confidential Intents settlement has no measured price premium. On
  5 November 2026 at 03:37 UTC, confidential dry quotes (`basic` and
  `advanced`) for USDC on Arbitrum to SOL on Solana returned the same or up to
  4.4 bps more SOL than public quotes taken at the same moment, from $1,000 to
  $250,000
  ([raw quotes](research/confidential/usdc-arb_sol-sol_2026-11-05t03-37-19-519z.json)).
- Live mode runs on the NEAR Intents Agent API: an agent account whose
  owner-signed policy lets it swap and pay the owner's wallet, nothing else.
  The Agent API enforces that policy, not Wakeless. Wakeless adds the floor
  as each swap's minimum output and the rules that stop the desk (see
  [Working an order through the agent](#working-an-order-through-the-agent)).
  The desk sends every swap in confidential form. In the live run below, four
  slices settled while the public `intents.near` ledger showed a zero balance
  for the agent.

## Live mode

Live mode runs the desk through an agent account on the NEAR Intents Agent
API. The owner signs one policy, and the API enforces it on every action the
desk's grant token asks for:

```json
{
  "actions": ["swap", "withdraw"],
  "confidential": true,
  "destinations": {
    "mode": "only",
    "list": [{ "action": "withdraw", "chain": "base", "address": "<your own wallet>", "memo": null }]
  },
  "budget": { "daily_usd": "250", "weekly_usd": null, "monthly_usd": null },
  "max_actions_per_hour": 120,
  "frozen": false
}
```

The desk can trade the deposited balance and send it to one place only: the
wallet the owner named. `confidential: true` allows the confidential form of
each action, and the desk sends every swap in that form. A leaked grant can
only swap, within $250 a day, or pay that wallet back, and the owner can
freeze the account at any time. The owner is a throwaway EVM key that only
signs these rules: the API derives its NEAR account and sponsors it, so it
needs no NEAR and holds no funds.

The agent starts swap-only (`create`); `allow-withdraw` is the owner's signed
policy update that adds the one withdrawal address, replacing any earlier one.
Before the owner signs it, `allow-withdraw` reads that address through a
public RPC (Base, Ethereum, Arbitrum) and says what a withdrawal to it would
link the order to. An address that has sent transactions, such as the wallet
that paid in, ties the way out to its history; one with no outgoing
transactions and no ETH has none the RPC can see. It warns and does not
refuse. The live run below withdrew to the wallet that made the deposit, and
the check flags that wallet: it has sent 2 transactions on Base.

Built and checked on the hackathon demo deployment
(`https://api.demo.agentsonintents.com`, mainnet) on 5 November 2026:

- Creating the agent swap-only, and issuing the desk's grant. A dry
  withdrawal through that grant came back with `policy_action_denied`.
- A dry swap of 10 USDC on Base to SOL through the grant returns a quote,
  a `fee` figure (0.18% at the time) and the remaining daily budget.
- The owner's policy update to revision 2, adding `withdraw` to one Base
  address, applied and synced with no gas from the owner. A dry withdrawal of
  0.001 ETH to that address then previewed a 0.11% fee and no policy warning;
  to any other address it came back with `policy_destination_denied`.

To reproduce, you need a demo partner key from
`https://partners.demo.agentsonintents.com/dashboard`. Put it in `.env` as
`NEAR_INTENTS_AGENT_API_KEY`, with
`NEAR_INTENTS_AGENT_API_URL=https://api.demo.agentsonintents.com`, then:

```sh
cd live && npm install && cd ..
node live/agent.mjs owner     # throwaway owner key, written to .env
node live/agent.mjs create    # agent with the policy above
node live/agent.mjs grant     # the desk's grant token, written to .env
node live/agent.mjs quote nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near nep141:sol.omft.near 10000000
node live/agent.mjs allow-withdraw base <your address>   # owner signs: withdrawals only there
node live/agent.mjs withdraw nep141:base.omft.near 1000000000000000 base <your address>   # dry preview
```

### Working an order through the agent

`live/run.mjs` runs the same engine with two parts swapped in:

- Prices come from the agent's own swap preview (`dry: true`, confidential
  form) through its grant, so the floor is checked against the route the swap
  will really take, under the agent's policy and budget.
- Each slice that clears the floor is submitted as a confidential swap whose
  `min_amount_out` is the floor, so the floor holds at settlement too, not
  only in the desk's own check. Then the desk follows the swap to a settled
  status and journals the settled amount and the intent hash.

The desk stops instead of guessing: a preview warning (such as
`insufficient_balance` or `spend_budget_exceeded`), a hard refusal, a status
that needs a person (`UNCERTAIN`, `NEEDS_REVIEW`, `PENDING_*`), a swap with
no settled status after 3 minutes, or 3 unfilled attempts in a row. A refunded
or failed swap is tried again later under a new idempotency key, like a slice
below the floor; a network error is retried under the same key, so it can not
trade twice.

**Do** `node live/run.mjs examples/live-usdc-base-to-sol.json --speed 3`.
**See** 12 USDC (Base) to SOL worked in 4 slices through the agent, each priced
by its own preview. Nothing is submitted and no funds move; with an unfunded
agent every preview carries `insufficient_balance`, and the report lists it.
[examples/agent-preview-run.md](examples/agent-preview-run.md) is such a run
from 5 November 2026. In it the preview's `fee` field tracked the quoted cost,
from 0.25% on the first slice to 0.10% on the last two minutes later, so it
reads as the all-in cost against the API's USD prices rather than a fixed fee.

Live: `node live/run.mjs <order.json> --live --confirm`. It refuses to start
unless the agent's confidential balance covers the order. To fund it,
`node live/agent.mjs deposit <asset> <amount>` asks for a deposit address with
`confidential: true`, and `node live/agent.mjs shield <asset> <amount>` moves a
public balance over.

### The live run, 5 November 2026

0.0025 ETH on Base (about $6) went to the agent's confidential deposit address
and was worked into SOL with
`node live/run.mjs examples/live-eth-base-to-sol.json --live --confirm --speed 2`:

- All 4 slices settled (`SUCCESS`), each at or above its floor, for
  0.062710 SOL in total. Each settlement landed between -23.0 and +0.9 bps of
  the agent's own preview for that slice, inside the 1% slippage tolerance.
- [examples/live-run.md](examples/live-run.md) is the report and
  `examples/live-run.jsonl` the journal, with the four intent hashes.
  [examples/live-run-chain.json](examples/live-run-chain.json) lists the
  public facts around it, such as the `intents.near` block where the agent
  showed 0.
- At $6 there is no price impact to avoid, so the slices received 15.5 bps
  less SOL than one swap was quoted at arrival. The run shows the live path
  working; the $500,000 dry run above is the size where slicing pays.
- Then the owner pointed the withdrawal rule at the wallet that made the
  deposit (policy revision 3), the desk swapped the SOL back to ETH, and
  `node live/agent.mjs withdraw ... --execute` paid it out to that wallet on
  Base. The deposit and withdrawal transactions are left out of this repo on
  purpose: they would name the owner's wallet.

What the chain showed while the agent held the SOL:

**Do** `node live/public-view.mjs 0d54a875b32c4ad1668c3e86e807ab28905133c93e1daae19653decaedea079f --block 223137273`.
**See** the agent's balances on the public `intents.near` ledger at that block,
read through an archival node: 0 SOL and 0 ETH, while the Agent API reported
62,710,076 base units of SOL (0.062710076) in the agent's confidential
balance at the same time. It needs no keys. nearblocks.io listed no transactions for the
account, and the API returned no public transaction hash for the four swaps,
only intent hashes. What is public is the way in, the ETH transfer on Base to
the deposit address, and later the way out to the owner's wallet.

## Limits of the dry run

- A dry fill is the amount its quote promised. A real fill can differ inside
  the slippage tolerance (1% by default).
- Dry slices do not use up liquidity, so every slice sees a fresh market. A
  real slice sees that only if market makers refill between slices; only a
  live run measures it.
- With `--speed` above 1 the market has little time to move, so "market move"
  is close to zero. At real speed it is the main risk of slicing, which is
  what the floor is for.
- `run` and `impact` need the 1Click API to be reachable; `report` works
  offline.

## Files

| Path | What it is |
| --- | --- |
| `bin/wakeless.mjs` | Command line: `check`, `impact`, `plan`, `run`, `report` |
| `src/schedule.mjs` | Randomized slice schedule with an exact total |
| `src/guard.mjs` | Execute, wait, split or skip, as a pure function |
| `src/engine.mjs` | Arrival snapshot, slice loop, journal events |
| `src/oneclick.mjs` | 1Click client with retries, quote parsing |
| `src/report.mjs` | Cost report rebuilt from a journal |
| `src/precheck.mjs` | Pre-trade check: size penalty by slice count, advice |
| `live/agent.mjs` | Agent lifecycle on the Agent API: owner, agent, grant, deposit, withdrawal rule, withdraw |
| `live/run.mjs` | Works an order through the agent, preview or live |
| `live/executor.mjs` | Submits a slice as a confidential swap with the floor as minimum output |
| `live/quote-client.mjs` | The agent's swap preview as the price source |
| `live/public-view.mjs` | The agent's public `intents.near` balances, next to its confidential ones |
| `live/exit-check.mjs` | What a withdrawal address would link the order to, read from a public RPC |
| `examples/` | Example orders, a committed dry run, an agent preview run and the live run |
| `research/impact/` | Raw price impact snapshots |

## Related work

Splitting an order over time and executing privately both exist on their
own. Searching GitHub and the web on 5 November 2026, we did not find the two
combined across chains on NEAR Intents.

- Public TWAP: CoW Swap TWAP orders, Jupiter Recurring on Solana and
  Hyperliquid's native TWAP split an order over time inside their own venue,
  and every child order is public. On Hyperliquid the parent order is public
  too, and trackers list it live (see [The problem](#the-problem)).
- Private TWAP: [`Sednaoui/private-twap`](https://github.com/Sednaoui/private-twap)
  (2021) prototyped TWAP swaps through Aztec Connect on Ethereum.
  [Meridian](https://ethglobal.com/showcase/meridian-1x2ef) (ETHGlobal) is a
  treasury agent that converts USDC to EURC on Base in TWAP chunks, with
  Unlink's ZK privacy pool hiding the treasury's identity in its private mode.
  Both work on one chain.
- Sealed orders: [Stillwater](https://stillwater.finance) (a sealed order pool
  on Solana), [Sotto Systems](https://sottosystems.xyz) (drand-timelocked
  orders cleared in uniform-price batch auctions on an EVM chain) and
  [Orcus](https://github.com/HoomanBuilds/orcus) (intents decrypted only inside
  a TEE, settled on EVM testnets and Sui) protect one order at a time inside
  their own venue.
- NEAR Intents itself offers confidential limit orders through 1Click; on
  5 November 2026 its `orderType` accepted `LIMIT` only.
- The DeFi track brief suggests a cross-chain DCA vault: swaps on a schedule,
  each delivered to the user's address on the target chain, to average a
  price. Wakeless works one large order over minutes to hours to cut its price
  impact, randomizes the slices and settles them confidentially, so the
  schedule leaves no public trail.

Wakeless works across chains on the liquidity of the NEAR Intents solvers,
hides the order's shape by randomizing it, settles every slice confidentially,
and runs as an agent whose policy lets it only swap and pay its owner back.

## Built with

The dry run and the web desk use the Node.js standard library only, plus the
1Click API (`https://1click.chaindefuser.com`) as documented at
https://docs.near-intents.org. Live mode (`live/`) adds the
`@near-intents-agent-api/sdk` and `viem` packages for the Agent API
(https://docs.agentsonintents.com). Fonts are self-hosted under the SIL Open
Font License. All code was written during the hackathon window.

## License

MIT
