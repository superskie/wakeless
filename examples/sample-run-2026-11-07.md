# Execution report: usdc-arb-to-sol (dry run)

Sold 500,000.00 USDC (arb) for 5,533.518717 SOL (sol) in 16 fills over 29m 44s of order time. Filled 100.00% of 500,000.00 USDC.

| Cost in bps of the input | bps |
| --- | ---: |
| Execution cost: fees, spread and impact at each fill | 24.2 |
| Market move while the order was worked | -0.0 |
| Implementation shortfall against arrival | 24.2 |
| Reference: one slice-sized swap at arrival | 21.7 |

Costs are measured against the USD prices 1Click returns with each quote and include its platform fee (25 bps without an API key; with one, 20 bps, or 1 bp on stablecoin pairs). Those prices can lag the market by a few bps, so compare numbers taken at the same moment, as the one-shot comparison below does.

The USD reference prices did not change while this order was worked, so this report can not split a market move from execution cost: the market-move line reads 0 and execution cost includes any move. The one-shot comparison below compares SOL received directly and does not depend on those prices.

One-shot alternative at arrival: 500,000.00 USDC in a single swap.

- Quoted cost 28.7 bps, 5,531.028701 SOL for the filled amount.
- Slicing received +2.490016 SOL (+4.5 bps, about $224.38 at the arrival price), market move included.

| Slice | Order time | Sold | Received | Rate | Cost bps | Status |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| 1 | 0m 34s | 22,353.56 | 247.474719 | 0.0110709 | 20.7 | SIMULATED |
| 2 | 3m 04s | 28,493.77 | 315.420840 | 0.0110698 | 21.7 | SIMULATED |
| 3 | 5m 11s | 30,150.83 | 333.764174 | 0.0110698 | 21.7 | SIMULATED |
| 4 | 7m 02s | 30,333.08 | 335.707206 | 0.0110674 | 23.9 | SIMULATED |
| 5 | 8m 14s | 33,850.48 | 374.635490 | 0.0110674 | 23.9 | SIMULATED |
| 6 | 9m 55s | 32,064.02 | 354.824706 | 0.0110661 | 25.0 | SIMULATED |
| 7 | 11m 33s | 35,199.34 | 389.520568 | 0.0110661 | 25.0 | SIMULATED |
| 8 | 14m 40s | 34,814.61 | 385.263161 | 0.0110661 | 25.0 | SIMULATED |
| 9 | 15m 34s | 35,893.67 | 397.204114 | 0.0110661 | 25.0 | SIMULATED |
| 10 | 17m 10s | 27,097.54 | 299.865046 | 0.0110661 | 25.0 | SIMULATED |
| 11 | 20m 08s | 25,559.11 | 282.890219 | 0.0110681 | 23.3 | SIMULATED |
| 12 | 21m 47s | 30,031.91 | 332.337118 | 0.0110661 | 25.0 | SIMULATED |
| 13 | 23m 14s | 33,008.26 | 365.273862 | 0.0110661 | 25.0 | SIMULATED |
| 14 | 24m 55s | 34,410.65 | 380.792854 | 0.0110661 | 25.0 | SIMULATED |
| 15 | 27m 17s | 35,788.01 | 396.034957 | 0.0110661 | 25.0 | SIMULATED |
| 16 | 29m 44s | 30,951.16 | 342.509683 | 0.0110661 | 25.0 | SIMULATED |

Decisions: at_or_above_floor 16. Seed: 510299588.

Dry run: every price above is a real 1Click quote taken at that moment, and each fill is simulated at its quoted amount. It assumes liquidity refills between slices; only a live run measures that.
