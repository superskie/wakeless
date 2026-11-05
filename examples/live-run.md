# Execution report: live-eth-base-sol (live)

Sold 0.00250 ETH (base) for 0.062710 SOL (sol) in 4 fills over 5m 28s of order time. Filled 100.00% of 0.00250 ETH.

| Cost in bps of the input | bps |
| --- | ---: |
| Execution cost: fees, spread and impact at each fill | 43.8 |
| Market move while the order was worked | -1.8 |
| Implementation shortfall against arrival | 42.1 |
| Reference: one slice-sized swap at arrival | 27.0 |

Costs are measured against the USD token prices the Agent API publishes, read with each quote, and include the Agent API fee. Those prices can lag the market by a few bps, so compare numbers taken at the same moment, as the one-shot comparison below does.

One-shot alternative at arrival: 0.00250 ETH in a single swap.

- Quoted cost 26.6 bps, 0.062807 SOL for the filled amount.
- Slicing received -0.000097 SOL (-15.5 bps, about -$0.01 at the arrival price), market move included.
- Execution cost avoided, market move excluded: -17.2 bps.
- In a live run each fill is a settlement while the one-shot alternative is only a quote, and settlements can land below their quotes inside the slippage tolerance ("vs quote" below), so this comparison leans against slicing.

| Slice | Order time | Sold | Received | Rate | Cost bps | vs quote bps | Status |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 0m 42s | 0.000580 | 0.014539 | 25.0774 | 44.7 | -23.0 | SUCCESS |
| 2 | 2m 27s | 0.000658 | 0.016521 | 25.1042 | 39.1 | +0.9 | SUCCESS |
| 3 | 3m 20s | 0.000558 | 0.013999 | 25.0936 | 42.0 | -2.3 | SUCCESS |
| 4 | 5m 28s | 0.000704 | 0.017652 | 25.0631 | 49.0 | -12.1 | SUCCESS |

Settlement references:

- Slice 1: 6hZ7nj62K2Dehk7VGk7wrS4awD5hnjhzq6eK7HAHfowh
- Slice 2: 9My2uBoSNSu4KzwCAH7bfWnTTrTUuUFztarbChjYbrQQ
- Slice 3: BQyutYefVVEnoZacDibajM7zzbbgioTdEp34zGEPErvR
- Slice 4: 231rrF66haGwJCNaFAxfafTykzzRQ5fuSECWmo7Ff6XJ

Decisions: at_or_above_floor 4. Seed: 2026.

Live run: every fill above was submitted through the agent's grant as a swap whose minimum output is the desk's floor, and the amounts received are the settled amounts the Agent API reported.
