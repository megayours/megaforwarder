import config from "../../config";

export abstract class Listener {
  public readonly id: string;
  private _config: Record<string, unknown>;

  constructor(listenerId: string) {
    this.id = listenerId;

    if (!config?.listeners?.[listenerId]) {
      throw new Error(`Listener configuration for ${listenerId} not found in config`);
    }

    this._config = config.listeners[listenerId] as Record<string, unknown>;
  }

  get config(): Record<string, unknown> {
    return this._config;
  }

  abstract run(): Promise<void>;
}