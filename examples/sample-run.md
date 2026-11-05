# Execution report: usdc-arb-to-sol (dry run)

Sold 500,000.00 USDC (arb) for 5,184.628696 SOL (sol) in 16 fills over 29m 01s of order time. Filled 100.00% of 500,000.00 USDC.

| Cost in bps of the input | bps |
| --- | ---: |
| Execution cost: fees, spread and impact against the mid at each fill | 26.2 |
| Market move while the order was worked | +0.0 |
| Implementation shortfall against the arrival mid | 26.2 |
| Reference: one slice-sized swap at arrival | 26.6 |

One-shot alternative at arrival: 500,000.00 USDC in a single swap.

- Quoted cost 49.2 bps, 5,172.671860 SOL for the filled amount.
- Slicing received +11.956836 SOL (+23.1 bps, about $1,149.77 at the arrival price), market move included.
- Execution cost avoided, market move excluded: +23.0 bps.

| Slice | Order time | Sold | Received | Rate | Cost bps | Status |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| 1 | 0m 20s | 35,569.41 | 368.849901 | 0.0103699 | 25.6 | SIMULATED |
| 2 | 2m 24s | 31,674.99 | 328.499364 | 0.0103709 | 24.6 | SIMULATED |
| 3 | 4m 23s | 34,507.21 | 357.872191 | 0.0103709 | 24.6 | SIMULATED |
| 4 | 6m 12s | 41,472.62 | 429.975897 | 0.0103677 | 27.7 | SIMULATED |
| 5 | 7m 56s | 28,650.55 | 297.071351 | 0.0103688 | 26.6 | SIMULATED |
| 6 | 10m 58s | 23,913.82 | 247.990083 | 0.0103702 | 25.3 | SIMULATED |
| 7 | 12m 17s | 29,420.39 | 305.085375 | 0.0103699 | 25.6 | SIMULATED |
| 8 | 14m 24s | 25,737.77 | 266.904743 | 0.0103702 | 25.3 | SIMULATED |
| 9 | 15m 53s | 39,685.70 | 411.535234 | 0.0103699 | 25.6 | SIMULATED |
| 10 | 17m 14s | 31,437.32 | 326.000689 | 0.0103699 | 25.6 | SIMULATED |
| 11 | 19m 39s | 34,501.11 | 357.771700 | 0.0103699 | 25.6 | SIMULATED |
| 12 | 21m 43s | 23,729.12 | 246.074768 | 0.0103702 | 25.3 | SIMULATED |
| 13 | 23m 15s | 28,065.85 | 291.069279 | 0.0103709 | 24.6 | SIMULATED |
| 14 | 25m 06s | 25,431.72 | 263.758402 | 0.0103712 | 24.3 | SIMULATED |
| 15 | 26m 59s | 30,937.91 | 320.481498 | 0.0103589 | 36.2 | SIMULATED |
| 16 | 29m 01s | 35,264.52 | 365.688222 | 0.0103699 | 25.6 | SIMULATED |

Decisions: at_or_above_floor 16. Seed: 20261105.

Dry run: every price above is a real 1Click quote taken at that moment, and each fill is simulated at its quoted amount. It assumes liquidity refills between slices; only a live run measures that.
