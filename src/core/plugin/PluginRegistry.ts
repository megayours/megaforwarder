import type { IPlugin } from "../interfaces/IPlugin";

export class PluginRegistry {
  private plugins: Map<string, IPlugin<unknown, unknown, unknown, unknown>>;

  private static instance: PluginRegistry;

  private constructor() {
    this.plugins = new Map();
  }

  static getInstance() {
    if (!PluginRegistry.instance) {
      PluginRegistry.instance = new PluginRegistry();
    }
    return PluginRegistry.instance;
  }

  register(plugin: IPlugin<unknown, unknown, unknown, unknown>) {
    this.plugins.set(plugin.metadata.id, plugin);
  }

  get(id: string) {
    return this.plugins.get(id);
  }

  list(): IPlugin<unknown, unknown, unknown, unknown>[] {
    return Array.from(this.plugins.values());
  }

  has(id: string) {
    return this.plugins.has(id);
  }
}