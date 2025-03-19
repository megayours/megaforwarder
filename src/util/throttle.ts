export function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * A singleton throttler class that limits the rate of function executions
 * per unique identifier.
 */
export class Throttler {
  private static instances: Map<string, Throttler> = new Map();
  private readonly maxCallsPerSecond: number;
  private readonly windowMs: number;
  private callCount: number = 0;
  private lastWindowStart: number = Date.now();
  private consecutiveErrors: number = 0;
  private backoffMs: number = 500;
  private readonly maxBackoffMs: number = 15000; // 15 seconds max backoff

  /**
   * Get a throttler instance for a specific identifier
   * @param identifier Unique identifier for this throttler (e.g. chain name, API endpoint)
   * @param maxCallsPerSecond Maximum number of calls allowed per second (default: 15)
   * @returns Throttler instance for the given identifier
   */
  public static getInstance(identifier: string, maxCallsPerSecond: number = 3): Throttler {
    if (!this.instances.has(identifier)) {
      this.instances.set(identifier, new Throttler(maxCallsPerSecond));
    }
    return this.instances.get(identifier)!;
  }

  private constructor(maxCallsPerSecond: number) {
    this.maxCallsPerSecond = maxCallsPerSecond;
    this.windowMs = 1000; // 1 second window
  }

  /**
   * Throttle a function to execute at most maxCallsPerSecond times per second
   * @param fn Function to throttle
   * @returns Throttled function
   */
  public throttle<T extends (...args: any[]) => any>(fn: T): (...args: Parameters<T>) => Promise<ReturnType<T>> {
    return async (...args: Parameters<T>): Promise<ReturnType<T>> => {
      await this.acquireSlot();
      return this.executeWithRetry(fn, ...args);
    };
  }

  /**
   * Execute a function with throttling and automatic retry on rate limit errors
   * @param fn Function to execute with throttling
   * @param args Arguments to pass to the function
   * @returns Result of the function execution
   */
  public async execute<T extends (...args: any[]) => any>(
    fn: T,
    ...args: Parameters<T>
  ): Promise<ReturnType<T>> {
    await this.acquireSlot();
    return this.executeWithRetry(fn, ...args);
  }

  /**
   * Execute a function with automatic retry on rate limit errors
   * @param fn Function to execute
   * @param args Arguments to pass to the function
   * @returns Result of the function execution
   */
  private async executeWithRetry<T extends (...args: any[]) => any>(
    fn: T,
    ...args: Parameters<T>
  ): Promise<ReturnType<T>> {
    try {
      const result = await fn(...args);
      // If successful, decrease consecutive errors (with a minimum of 0)
      this.consecutiveErrors = Math.max(0, this.consecutiveErrors - 1);
      // Reset backoff if we've had several successful calls
      if (this.consecutiveErrors === 0) {
        this.backoffMs = 100;
      }
      return result;
    } catch (error: any) {
      // If we hit a rate limit error, increase backoff and retry
      if (error?.message?.includes('429') || error?.code === 429) {
        this.consecutiveErrors++;
        this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
        console.warn(`Server responded with 429 Too Many Requests. Retrying after ${this.backoffMs}ms delay...`);
        
        // Reduce our rate limit for a while after hitting 429s
        this.reduceRateLimit();
        
        await sleep(this.backoffMs);
        
        // Try again with backoff
        return this.execute(fn, ...args);
      }
      
      // For other errors, just rethrow
      throw error;
    }
  }

  /**
   * Temporarily reduce the rate limit after hitting 429s
   */
  private reduceRateLimit(): void {
    // Temporarily reduce the rate limit even further
    this.callCount = Math.max(this.maxCallsPerSecond - 1, this.callCount);
  }

  /**
   * Wait until a slot is available for execution
   */
  private async acquireSlot(): Promise<void> {
    const now = Date.now();
    
    // Reset counter if we're in a new time window
    if (now - this.lastWindowStart > this.windowMs) {
      this.callCount = 0;
      this.lastWindowStart = now;
    }
    
    // Check if we've hit the limit
    if (this.callCount >= this.maxCallsPerSecond) {
      // Wait until the next window starts
      const timeToWait = this.windowMs - (now - this.lastWindowStart) + 50; // Add a small buffer
      await sleep(timeToWait);
      
      // Reset for the new window
      this.callCount = 0;
      this.lastWindowStart = Date.now();
    }
    
    // Increment call count
    this.callCount++;
  }
}

/**
 * Legacy throttle function for backward compatibility
 * @deprecated Use Throttler.getInstance().throttle() instead
 */
export function throttle<T extends (...args: any[]) => any>(fn: T): (...args: Parameters<T>) => Promise<ReturnType<T>> {
  const throttler = Throttler.getInstance('default');
  return throttler.throttle(fn);
}


