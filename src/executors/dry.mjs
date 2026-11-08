// Dry-run executor: fills each slice at the amount its fresh quote promised.
// No funds move. The live executor (Agent API) replaces this with a real swap.

export function dryExecutor() {
  return {
    mode: 'dry',
    async execute({ slice, quote, floorRate }) {
      // Like the live executor: no fill without a positive floor, even a simulated one.
      if (!(floorRate > 0)) {
        return {
          status: 'NO_FLOOR',
          amountIn: 0n,
          amountOut: 0n,
          txHashes: [],
          next: 'halt',
          message: `slice ${slice?.id} has no usable price floor (floor rate ${floorRate}); nothing was simulated`,
        };
      }
      return {
        status: 'SIMULATED',
        amountIn: quote.amountIn,
        amountOut: quote.amountOut,
        txHashes: [],
      };
    },
  };
}
