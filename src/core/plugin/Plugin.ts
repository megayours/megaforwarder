import type { Result } from "neverthrow";
import config from "../../config";
import type { IPlugin } from "../interfaces/IPlugin";
import type { PluginMetadata } from "../types/PluginMetadata";
import type { ProcessInput } from "../types/Protocol";
import type { PluginError } from "../../util/errors";

export abstract class Plugin<TPluginInput, TPrepareOutput, TValidateData, TPluginOutput> implements IPlugin<TPluginInput, TPrepareOutput, TValidateData, TPluginOutput> {
  private _metadata: PluginMetadata;
  private _config: Record<string, unknown>;
  constructor(metadata: PluginMetadata) {
    this._metadata = metadata;

    if (!config?.plugins?.[metadata.id]) {
      this._config = {};
    } else {
      this._config = config.plugins[metadata.id] as Record<string, unknown>;
    }
  }

  get metadata(): PluginMetadata {
    return this._metadata;
  }

  get config(): Record<string, unknown> {
    return this._config;
  }

  abstract prepare(input: TPluginInput): Promise<Result<TPrepareOutput, PluginError>>;
  abstract process(preparedOutputs: ProcessInput<TPrepareOutput>[]): Promise<Result<TValidateData, PluginError>>;
  abstract validate(dataToValidate: TValidateData, preparedData: TPrepareOutput): Promise<Result<TValidateData, PluginError>>;
  abstract execute(finalData: TValidateData): Promise<Result<TPluginOutput, PluginError>>;
}