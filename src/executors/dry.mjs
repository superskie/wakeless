// Dry-run executor: fills each slice at the amount its fresh quote promised.
// No funds move. The live executor (Agent API) replaces this with a real swap.

export function dryExecutor() {
  return {
    mode: 'dry',
    async execute({ quote }) {
      return {
        status: 'SIMULATED',
        amountIn: quote.amountIn,
        amountOut: quote.amountOut,
        txHashes: [],
      };
    },
  };
}
