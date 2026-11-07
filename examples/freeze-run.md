# Execution report: live-eth-base-sol (agent preview, no funds moved)

Sold 0.000581 ETH (base) for 0.014458 SOL (sol) in 1 fills over 2m 27s of order time. Filled 23.25% of 0.00250 ETH.

Stopped early at 2m 27s on slice 2 (REFUSED): The owner froze this agent. Only an agent_unfreeze intent resumes executions. (wallet_frozen).

Wallet cap (policy revision 4): the wallet refuses any swap above 0.000956 ETH and sales above 0.00250 ETH a day; this run's largest slice was 0.000701 ETH.

| Cost in bps of the input | bps |
| --- | ---: |
| Execution cost: fees, spread and impact at each fill | 28.0 |
| Market move while the order was worked | +0.0 |
| Implementation shortfall against arrival | 28.0 |
| Reference: one slice-sized swap at arrival | 27.9 |

Costs are measured against the USD token prices the Agent API publishes, read with each quote, and include the Agent API fee. Those prices can lag the market by a few bps, so compare numbers taken at the same moment, as the one-shot comparison below does.

The USD reference prices did not change while this order was worked, so this report can not split a market move from execution cost: the market-move line reads 0 and execution cost includes any move. The one-shot comparison below compares SOL received directly and does not depend on those prices.

One-shot alternative at arrival: 0.00250 ETH in a single swap.

- Quoted cost 18.0 bps, 0.014473 SOL for the filled amount.
- Slicing received -0.000015 SOL (-10.1 bps, about -$0.00 at the arrival price), market move included.

| Slice | Order time | Sold | Received | Rate | Cost bps | Status |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| 1 | 0m 42s | 0.000581 | 0.014458 | 24.8646 | 28.0 | PREVIEW |

Preview warnings on 1 of 1 fills: insufficient_balance. A live run stops at the first warning.

Decisions: at_or_above_floor 1, refused_wallet_frozen 1. Seed: 2026.

Agent preview: every price above is the agent's own swap preview, requested through its grant and checked against its signed policy. Nothing was submitted and no funds moved; each fill is shown at its previewed amount.
