# Execution report: live-usdc-base-sol (agent preview, no funds moved)

Sold 12.00 USDC (base) for 0.124482 SOL (sol) in 4 fills over 4m 45s of order time. Filled 100.00% of 12.00 USDC.

| Cost in bps of the input | bps |
| --- | ---: |
| Execution cost: fees, spread and impact at each fill | 17.3 |
| Market move while the order was worked | +0.0 |
| Implementation shortfall against arrival | 17.3 |
| Reference: one slice-sized swap at arrival | 24.0 |

Costs are measured against the USD token prices the Agent API publishes, read with each quote, and include the Agent API fee. Those prices can lag the market by a few bps, so compare numbers taken at the same moment, as the one-shot comparison below does.

The USD reference prices did not change while this order was worked, so this report can not split a market move from execution cost: the market-move line reads 0 and execution cost includes any move. The one-shot comparison below compares SOL received directly and does not depend on those prices.

One-shot alternative at arrival: 12.00 USDC in a single swap.

- Quoted cost 22.8 bps, 0.124413 SOL for the filled amount.
- Slicing received +0.000069 SOL (+5.6 bps, about $0.01 at the arrival price), market move included.

| Slice | Order time | Sold | Received | Rate | Cost bps | Status |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| 1 | 0m 46s | 2.98 | 0.030888 | 0.0103654 | 25.1 | PREVIEW |
| 2 | 2m 23s | 3.05 | 0.031639 | 0.0103730 | 17.8 | PREVIEW |
| 3 | 4m 10s | 2.99 | 0.031018 | 0.0103762 | 14.7 | PREVIEW |
| 4 | 4m 45s | 2.98 | 0.030937 | 0.0103794 | 11.6 | PREVIEW |

Preview warnings on 4 of 4 fills: insufficient_balance. A live run stops at the first warning.

Decisions: at_or_above_floor 4. Seed: 11.

Agent preview: every price above is the agent's own swap preview, requested through its grant and checked against its signed policy. Nothing was submitted and no funds moved; each fill is shown at its previewed amount.
