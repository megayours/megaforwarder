import { err, ok, ResultAsync } from "neverthrow";
import pThrottle from "p-throttle";
import type { ThrottledFunction } from "p-throttle";
import { tryCatch } from "./try-catch";
import type { OracleError } from "./errors";
import { throttleQueueSize } from "./monitoring";

class ThrottleManager {
  private throttlers = new Map<string, ThrottledFunction<any>>();
  private queueSizes = new Map<string, number>();

  /**
   * Executes a function with rate limiting
   * @param identifier Unique identifier for this throttle group
   * @param fn Function to throttle
   * @param maxCallsPerSecond Maximum calls per second (default: 3)
   */
  async execute<T>(identifier: string, fn: () => Promise<T>, maxCallsPerSecond: number = 3): Promise<ResultAsync<T, OracleError>> {
    // Create a new throttler if one doesn't exist for this identifier
    if (!this.throttlers.has(identifier)) {
      this.throttlers.set(identifier, pThrottle({
        limit: maxCallsPerSecond,
        interval: 1000,
      }));
      this.queueSizes.set(identifier, 0);
    }

    // Update queue size metrics
    const currentQueueSize = (this.queueSizes.get(identifier) || 0) + 1;
    this.queueSizes.set(identifier, currentQueueSize);

    // Track Solana-specific metrics
    throttleQueueSize.set({ identifier }, currentQueueSize);

    const throttledFn = this.throttlers.get(identifier)!;
    const { data, error } = await tryCatch<T>(throttledFn(fn)());

    // Decrement queue size after execution
    const newQueueSize = (this.queueSizes.get(identifier) || 1) - 1;
    this.queueSizes.set(identifier, newQueueSize);

    // Update Solana-specific metrics
    throttleQueueSize.set({ identifier }, newQueueSize);

    if (error) {
      return err({ type: 'throttle_error', context: error?.message ?? 'Unknown error' });
    }

    return ok(data);
  }
}

// Singleton instance
const throttleManager = new ThrottleManager();

/**
 * Execute a function with rate limiting
 * @param identifier Unique identifier for this throttle group
 * @param fn Function to execute (use arrow functions to preserve context)
 * @param maxCallsPerSecond Maximum calls per second (default: 3)
 */
export const executeThrottled = async <T>(
  identifier: string,
  fn: (...args: any[]) => Promise<T>,
  maxCallsPerSecond: number = 3
): Promise<ResultAsync<T, OracleError>> => {
  // Using arrow function to preserve the original context
  return throttleManager.execute(identifier, () => fn(), maxCallsPerSecond);
};

export function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}