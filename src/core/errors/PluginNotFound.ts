export class PluginNotFound extends Error {
  constructor(pluginId: string) {
    super(`Plugin ${pluginId} not found`);
    this.name = 'PluginNotFound';
  }
}
