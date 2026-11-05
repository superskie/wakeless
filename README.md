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

**Do** `node bin/wakeless.mjs report examples/sample-run.jsonl`. **See** the
report in [examples/sample-run.md](examples/sample-run.md) rebuilt offline from
the committed journal of a run on 5 November 2026: the 16 slices cost 23.0 bps
less than one swap of the whole $500,000 quoted at the same moment, about
$1,150 more SOL.

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
| `bin/wakeless.mjs` | Command line: `check`, `impact`, `run`, `report` |
| `src/schedule.mjs` | Randomized slice schedule with an exact total |
| `src/guard.mjs` | Execute, wait, split or skip, as a pure function |
| `src/engine.mjs` | Arrival snapshot, slice loop, journal events |
| `src/oneclick.mjs` | 1Click client with retries, quote parsing |
| `src/report.mjs` | Cost report rebuilt from a journal |
| `examples/` | Example order and a committed run |
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

Node.js standard library only. The 1Click API (`https://1click.chaindefuser.com`)
as documented at https://docs.near-intents.org. All code was written during the
hackathon window.

## License

MIT
