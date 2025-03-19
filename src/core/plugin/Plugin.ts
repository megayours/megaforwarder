import config from "../../config";
import type { IPlugin } from "../interfaces/IPlugin";
import type { PluginMetadata } from "../types/PluginMetadata";
import type { PrepareResult, ProcessInput, ProcessResult, ValidateResult, ExecuteResult } from "../types/Protocol";

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

  abstract prepare(input: TPluginInput): Promise<PrepareResult<TPrepareOutput>>;
  abstract process(preparedOutputs: ProcessInput<TPrepareOutput>[]): Promise<ProcessResult<TValidateData>>;
  abstract validate(dataToValidate: TValidateData, preparedData: TPrepareOutput): Promise<ValidateResult<TValidateData>>;
  abstract execute(finalData: TValidateData): Promise<ExecuteResult<TPluginOutput>>;
}