import type { IListener } from "../interfaces/IListener";
import config from "../../config";
import { logger } from "../../util/monitoring";
import { sleep } from "../../util/throttle";

export class ListenerRegistry {
  private static instance: ListenerRegistry;
  private listeners: IListener[] = [];

  private constructor() {
    this.listeners = [];
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
    this.listeners.push(listener);
  }

  public async start() {
    while (true) {
      for (const listener of this.listeners) {
        try {
          logger.info(`Running listener ${listener.id}`);
          await listener.run();
          await sleep(config.listener.intervalMs);
        } catch (error) {
          logger.error("Critical error in listener registry loop", { error, listener: listener.id });
        }
      }

      await sleep(config.listener.intervalMs);
    }
  }
}