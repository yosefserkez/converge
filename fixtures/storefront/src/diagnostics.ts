// Protected diagnostic instrumentation. The server wraps the pricing function
// with countCalls() before it hands the function to the cache. The count thus
// reflects real pricing computations, whatever the cache module does.
let computeCount = 0;

export function countCalls<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args: A): R => {
    computeCount += 1;
    return fn(...args);
  };
}

export function getComputeCount(): number {
  return computeCount;
}
