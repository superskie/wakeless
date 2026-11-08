# Execution report: web-live-mw7nfskk (live)

Sold 25.00 USDC (base) for 0.011165 ETH (arb) in 4 fills over 9m 00s of order time. Filled 100.00% of 25.00 USDC.

Wallet cap (policy revision 1): the wallet refuses any swap above 9.56 USDC and sales above 25.00 USDC a day; this run's largest slice was 7.56 USDC.

| Cost in bps of the input | bps |
| --- | ---: |
| Execution cost: fees, spread and impact at each fill | 13.2 |
| Market move while the order was worked | -1.1 |
| Implementation shortfall against arrival | 12.1 |
| Reference: one slice-sized swap at arrival | 15.4 |

Costs are measured against the USD token prices the Agent API publishes, read with each quote, and include the Agent API fee. Those prices can lag the market by a few bps, so compare numbers taken at the same moment, as the one-shot comparison below does.

One-shot alternative at arrival: 25.00 USDC in a single swap.

- Quoted cost 15.4 bps, 0.011162 ETH for the filled amount.
- Slicing received +0.000004 ETH (+3.3 bps, about $0.01 at the arrival price), market move included.
- Execution cost avoided, market move excluded: +2.2 bps.
- In a live run each fill is a settlement while the one-shot alternative is only a quote, and settlements can land below their quotes inside the slippage tolerance ("vs quote" below), so this comparison leans against slicing.

| Slice | Order time | Sold | Received | Rate | Cost bps | vs quote bps | Status |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 1m 28s | 6.98 | 0.003114 | 0.000446459 | 15.7 | +0.0 | SUCCESS |
| 2 | 4m 09s | 5.12 | 0.002285 | 0.000446634 | 12.0 | +0.0 | SUCCESS |
| 3 | 6m 04s | 7.56 | 0.003379 | 0.000446677 | 10.7 | -0.0 | SUCCESS |
| 4 | 9m 00s | 5.34 | 0.002387 | 0.000446678 | 14.6 | -0.0 | SUCCESS |

Settlement references:

- Slice 1: 74g2Srugg4VpVyGtL8RPfQ7uFXzXYMLa6cF3yCQeFmK8
- Slice 2: A9ANRHx78opkqxXjWfzGLvC8SWvSAF3CcAW472NU3kKV
- Slice 3: 8pGcHWPz6rnZx8kyBczqwykrTyMKrtMnaBEmqYWVSkxi
- Slice 4: FhANqqBPLrD5Wd7rdZ9Mn3bi2Q4BNPtqeSGFBzfMAxj5

Decisions: at_or_above_floor 4. Seed: 1761470149.

Live run: every fill above was submitted through the agent's grant as a swap whose minimum output is the desk's floor, and the amounts received are the settled amounts the Agent API reported.
