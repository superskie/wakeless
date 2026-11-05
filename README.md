# Wakeless

Works a large cross-chain swap in randomized slices through NEAR Intents, so
the order pays less price impact and leaves no pattern for wallet watchers to
trade against. A large order leaves a wake; the name is the goal.

Built at NEAR HACKATHON (1 to 14 November 2026). Tracks: Unstoppable DeFi
(`defi`), Agent Economy (`agents`), Privacy & Private AI (`privacy`).

## The problem

One large swap pays for its own size. On 5 November 2026 at 02:30 UTC, the
NEAR Intents 1Click API quoted USDC on Arbitrum to SOL on Solana like this
([raw quotes](research/impact/usdc-arb_sol-sol_2026-11-05t02-30-14-324z.json)):

| Order size | Extra cost against a $1,000 swap |
| ---: | ---: |
| $10,000 | about 0 bps |
| $100,000 | +8.9 bps |
| $500,000 | +24.5 bps |
| $1,000,000 | no quote: "No liquidity available" |

Trading desks split such orders over time (TWAP). Done from a normal wallet,
every slice is a public transaction from the same address at a regular size
and rhythm, which tells observers how much is still coming.

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

**Do** `npm test`. **See** 38 passing tests: schedule totals are exact to the
base unit, no fill is ever below the floor, oversized slices split until they
clear, the report math matches a hand-computed case, and live mode, run
against an Agent API double, submits each slice once, in confidential form,
with the floor as its minimum output, and stops when it should.

**Do** `npm run impact`. **See** live 1Click quotes for $1,000 to $1,000,000
of USDC (Arbitrum) to SOL (Solana). Cost rises with size, and the largest size
usually returns "No liquidity available". The raw responses are saved to
`research/impact/`. Liquidity changes during the day, so numbers differ from
the table above.

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
- Live mode (in progress, see below) runs on the NEAR Intents Agent API: an
  agent account whose owner-signed policy lets it swap and nothing else. The
  desk sends every swap in confidential form.

## Live mode (in progress)

Live mode runs the desk through an agent account on the NEAR Intents Agent
API. The owner signs one policy, and the API enforces it on every action the
desk's grant token asks for:

```json
{
  "actions": ["swap"],
  "confidential": true,
  "destinations": { "mode": "only", "list": [] },
  "budget": { "daily_usd": "250", "weekly_usd": null, "monthly_usd": null },
  "max_actions_per_hour": 120,
  "frozen": false
}
```

The desk can trade the deposited balance but can not send it anywhere.
`confidential: true` allows the confidential form of each action, and the
desk sends every swap in that form. A leaked grant can only swap, for at most
$250 a day, and the owner can freeze the account at any time. The owner is a
throwaway EVM key: the API derives its NEAR account and sponsors it, so it
needs no NEAR and holds no funds.

Built and checked on the hackathon demo deployment
(`https://api.demo.agentsonintents.com`, mainnet) on 5 November 2026:

- Creating the agent with this policy, and issuing the desk's grant.
- A dry swap of 10 USDC on Base to SOL through the grant returns a quote,
  a `fee` figure (0.18% at the time) and the remaining daily budget.
- A dry withdrawal through the same grant comes back with
  `policy_action_denied`.

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
public balance over. Not done yet: a funded live run.

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
| `bin/wakeless.mjs` | Command line: `check`, `impact`, `run`, `report` |
| `src/schedule.mjs` | Randomized slice schedule with an exact total |
| `src/guard.mjs` | Execute, wait, split or skip, as a pure function |
| `src/engine.mjs` | Arrival snapshot, slice loop, journal events |
| `src/oneclick.mjs` | 1Click client with retries, quote parsing |
| `src/report.mjs` | Cost report rebuilt from a journal |
| `live/agent.mjs` | Agent lifecycle on the Agent API: owner, agent, grant, deposit, preview |
| `live/run.mjs` | Works an order through the agent, preview or live |
| `live/executor.mjs` | Submits a slice as a confidential swap with the floor as minimum output |
| `live/quote-client.mjs` | The agent's swap preview as the price source |
| `examples/` | Example orders, a committed dry run and an agent preview run |
| `research/impact/` | Raw price impact snapshots |

## Related work

- [Stillwater](https://stillwater.finance): a sealed order pool on Solana.
  Orders are committed as hashes, revealed in short sessions and cleared
  together at one price against the other orders in the pool.
- [Sotto Systems](https://sottosystems.xyz): orders encrypted in the client
  stay unreadable until a drand timelock round opens their epoch, on Robinhood
  Chain.

Both protect an order inside one venue on one chain. Wakeless works across
chains on the liquidity of the NEAR Intents solvers that quote every slice,
hides the order's shape by randomizing it and, in live mode, settles inside
Confidential Intents.

## Built with

The dry run and the web desk use the Node.js standard library only, plus the
1Click API (`https://1click.chaindefuser.com`) as documented at
https://docs.near-intents.org. Live mode (`live/`) adds the
`@near-intents-agent-api/sdk` and `viem` packages for the Agent API
(https://docs.agentsonintents.com). Fonts are self-hosted under the SIL Open
Font License. All code was written during the hackathon window.

## License

MIT
