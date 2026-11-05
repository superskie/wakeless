# Dark Algo Desk

Works a large cross-chain swap in randomized slices through NEAR Intents, so
the order pays less price impact and does not show a pattern to people who
watch wallets.

Built at NEAR HACKATHON (1 to 14 November 2026). Tracks: Unstoppable DeFi
(`defi`), Agent Economy (`agents`), Privacy & Private AI (`privacy`).

## The problem

One large swap pays for its own size. On 5 November 2026 at 02:30 UTC, the
NEAR Intents 1Click API quoted USDC on Arbitrum to SOL on Solana at these
all-in costs against the mid price
([raw quotes](research/impact/usdc-arb_sol-sol_2026-11-05t02-30-14-324z.json)):

| Order size | Cost |
| ---: | ---: |
| $10,000 | 15.9 bps |
| $100,000 | 25.6 bps |
| $500,000 | 41.1 bps |
| $1,000,000 | "No liquidity available" |

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
git clone https://github.com/superskie/dark-algo-desk && cd dark-algo-desk
```

**Do** `npm test`. **See** 28 passing tests: schedule totals are exact to the
base unit, no fill is ever below the floor, oversized slices split until they
clear, and the report math matches a hand-computed case.

**Do** `npm run impact`. **See** live 1Click quotes for $1,000 to $1,000,000
of USDC (Arbitrum) to SOL (Solana). Cost rises with size, and the largest size
usually returns "No liquidity available". The raw responses are saved to
`research/impact/`. Liquidity changes during the day, so numbers differ from
the table above.

**Do** `npm run demo`. **See** a $500,000 order worked in 16 slices: one line
per slice with its live quote and decision, then the report. The 30-minute
schedule runs 60 times faster (about 45 seconds); every quote is live. The
line "Execution cost avoided, market move excluded" compares the slices with
one swap of the whole order quoted at the same moment.

**Do** `node bin/desk.mjs report examples/sample-run.jsonl`. **See** the
report in [examples/sample-run.md](examples/sample-run.md) rebuilt offline from
the committed journal of a run on 5 November 2026: 16 fills at 26.2 bps
against 49.2 bps for one swap, 23.0 bps less execution cost, about $1,150 more
SOL on $500,000.

Your own order: copy `examples/usdc-arb-to-sol.json`, change `sell`, `buy`
and `amount` (assets are `symbol:chain`, such as `usdc:arb`, `eth:eth`,
`sol:sol`), then `node bin/desk.mjs run your-order.json --speed 60`.

## How the report measures cost

All costs are in basis points of the input value.

- Execution cost: each fill's cost against the USD mid prices 1Click returns
  with that quote, weighted by size. Fees, spread and price impact.
- Implementation shortfall: realized rate against the mid at arrival.
  Execution cost plus whatever the market did while the order was worked.
- One-shot alternative: the whole order quoted as a single swap at arrival.

## What is specific to NEAR

- NEAR Intents 1Click quotes 215 tokens on 38 chains through one API
  (`GET /v0/tokens`, 5 November 2026), so the same desk works any pair.
- Slices settle between NEAR Intents balances instead of as separate
  cross-chain transfers: one deposit in, one withdrawal out.
- Live mode (in progress, see below) runs on the NEAR Intents Agent API with
  Confidential Intents.

## Live mode (in progress)

Not built yet. The plan uses the NEAR Intents Agent API: the owner signs one
policy for an agent account, with `actions: ["swap", "withdraw"]`, the
owner's own address as the only withdrawal destination, and
`confidential: true`. The desk can then trade the deposited balance but cannot
send it anywhere except back to the owner, the owner can freeze it at any
time, and balances and slices between deposit and withdrawal are not public.

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
| `bin/desk.mjs` | Command line: `impact`, `run`, `report` |
| `src/schedule.mjs` | Randomized slice schedule with an exact total |
| `src/guard.mjs` | Execute, wait, split or skip, as a pure function |
| `src/engine.mjs` | Arrival snapshot, slice loop, journal events |
| `src/oneclick.mjs` | 1Click client with retries, quote parsing |
| `src/report.mjs` | Cost report rebuilt from a journal |
| `examples/` | Example order and a committed run |
| `research/impact/` | Raw price impact snapshots |

## Built with

Node.js standard library only. The 1Click API (`https://1click.chaindefuser.com`)
as documented at https://docs.near-intents.org. All code was written during the
hackathon window.

## License

MIT
