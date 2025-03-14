import type { IListener } from "../interfaces/IListener";

export class ListenerRegistry {
  private static instance: ListenerRegistry;
  private listeners: IListener[] = [];

  private constructor() {
    this.listeners = [];
  }

  public static getInstance(): ListenerRegistry {
    if (!ListenerRegistry.instance) {
      ListenerRegistry.instance = new ListenerRegistry();
      ListenerRegistry.instance.start();
    }
    return ListenerRegistry.instance; 
  }

  public register(listener: IListener) {
    this.listeners.push(listener);
  }

  public async start() {
    while (true) {
      for (const listener of this.listeners) {
        await listener.run();
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}