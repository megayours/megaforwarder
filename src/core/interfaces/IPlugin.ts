import type { Result } from "neverthrow";
import type { PluginMetadata } from "../types/PluginMetadata";
import type { ProcessInput } from "../types/Protocol";
import type { OracleError } from "../../util/errors";

/**
 * Interface that all plugins must implement to be compatible with the oracle network.
 */
export interface IPlugin<TPluginInput, TPrepareOutput, TValidateData, TPluginOutput> {
  metadata: PluginMetadata;
  /**
   * Validate input data and return a result
   * @param input The input data to validate
   * @returns The validation result
   */
  prepare(input: TPluginInput): Promise<Result<TPrepareOutput, OracleError>>;
  
  /**
   * Is only executed on the primary node in order to prepare data for the secondary nodes to validate.
   * 
   * @param preparedOutputs The outputs with a majority consensus to prepare a transaction for
   * @returns A Buffer representing the transaction
   */
  process(preparedOutputs: ProcessInput<TPrepareOutput>[]): Promise<Result<TValidateData, OracleError>>;

  /**
   * Is executed on all secondary nodes in order to validate the data.
   * 
   * @param dataToValidate The data to validate
   * @param myPreparedOutput The output of my previous prepare step
   * @returns The validation result
   */
  validate(dataToValidate: TValidateData, preparedData: TPrepareOutput): Promise<Result<TValidateData, OracleError>>;
  
  /**
   * Execute the final transaction after all signatures are collected
   * @param finalData The data to execute
   * @returns The execution result
   */
  execute(finalData: TValidateData): Promise<Result<TPluginOutput, OracleError>>;
}