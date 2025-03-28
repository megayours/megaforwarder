import type { IListener } from "../interfaces/IListener";
import { logger } from "../../util/monitoring";
import { sleep } from "../../util/throttle";
import { minutesFromNow } from "../../util/time";

interface ScheduledListener {
  listener: IListener;
  nextRunTime: number;
  running: boolean;
}

export class ListenerRegistry {
  private static instance: ListenerRegistry;
  private scheduledListeners: ScheduledListener[] = [];
  private running = false;

  private constructor() {
    this.scheduledListeners = [];
  }

  public static getInstance(): ListenerRegistry {
    if (!ListenerRegistry.instance) {
      ListenerRegistry.instance = new ListenerRegistry();
      setTimeout(() => ListenerRegistry.instance.start(), 0);
    }
    return ListenerRegistry.instance;
  }

  public register(listener: IListener) {
    logger.info(`Registering listener`, { listener: listener.id });
    this.scheduledListeners.push({
      listener,
      nextRunTime: Date.now(), // Schedule to run immediately
      running: false
    });
  }

  private async runListener(scheduledListener: ScheduledListener) {
    if (scheduledListener.running) return;
    
    scheduledListener.running = true;
    
    try {
      const { listener } = scheduledListener;
      logger.info(`Running listener ${listener.id}`);
      const nextRunTime = await listener.run();
      
      // Update next run time
      scheduledListener.nextRunTime = nextRunTime;
    } catch (error: any) {
      logger.error("Critical error in listener", { error: error.message ?? error, listener: scheduledListener.listener.id });
      
      // Schedule for a minute later on failure
      scheduledListener.nextRunTime = minutesFromNow(1);
    } finally {
      scheduledListener.running = false;
    }
  }

  public async start() {
    if (this.running) return;
    this.running = true;
    
    // Start a separate monitoring loop for each listener
    for (const scheduledListener of this.scheduledListeners) {
      this.monitorAndRunListener(scheduledListener);
    }
  }
  
  private async monitorAndRunListener(scheduledListener: ScheduledListener) {
    // Create a dedicated monitoring loop for this listener
    (async () => {
      while (true) {
        const now = Date.now();
        
        // Check if it's time to run this listener
        if (now >= scheduledListener.nextRunTime && !scheduledListener.running) {
          // Run the listener in the background without awaiting it
          this.runListener(scheduledListener).catch(error => {
            logger.error("Unhandled error in listener runner", { 
              error, 
              listener: scheduledListener.listener.id 
            });
          });
        }
        
        // Sleep a short time before checking again
        await sleep(100);
      }
    })();
  }
}