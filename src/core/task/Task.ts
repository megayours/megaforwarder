import type { IPlugin } from "../interfaces/IPlugin";
import { PluginRegistry } from "../plugin/PluginRegistry";
import config from "../../config";
import { requestPrepare, requestValidate } from "./client";
import { PluginNotFound } from "../errors/PluginNotFound";
import type { ProcessInput, ProtocolPrepareResult } from "../types/Protocol";
import { completedTasksTotal, logger, taskDurationTotal } from "../../util/monitoring";
import { tryCatch } from "../../util/try-catch";
import { err, ok, Result } from "neverthrow";
import type { OracleError } from "../../util/errors";

export class Task<T> {
  private plugin: IPlugin<unknown, unknown, unknown, T>;
  private input: unknown;
  private startTime: number;

  constructor(pluginId: string, input: unknown) {
    const plugin = PluginRegistry.getInstance().get(pluginId);
    if (!plugin) {
      logger.error(`Plugin ${pluginId} not found`);
      throw new PluginNotFound(pluginId);
    }
    this.plugin = plugin as IPlugin<unknown, unknown, unknown, T>;
    this.input = input;
    this.startTime = Date.now();
  }

  private async runPreparePhase(): Promise<Result<{ publicKey: string; result: ProtocolPrepareResult<unknown> }[], OracleError>> {
    const result = await this.plugin.prepare(this.input);
    if (result.isErr()) {
      return err(result.error);
    }

    const peers = config.peers;
    const peerTimeoutMs = config.peerTimeoutMs;

    const prepareResults: { publicKey: string; result: ProtocolPrepareResult<unknown> }[] = [];
    prepareResults.push({
      publicKey: config.publicKey,
      result: {
        data: result.value,
        signatureData: null,
        encodedData: "<PRIMARY>"
      }
    });

    const preparePromises = peers.map(async (peer) => {
      const result = await requestPrepare<unknown, unknown>(peer, {
        pluginId: this.plugin.metadata.id,
        input: this.input,
      });

      if (result.isErr()) {
        logger.warn(`Error during prepare phase for plugin ${this.plugin.metadata.id} from peer ${peer.publicKey}: ${result.error.type} > ${result.error.context}`);
        return err(result.error);
      }

      prepareResults.push({ publicKey: peer.publicKey, result: result.value });
    });

    const prepareTimeoutPromise = new Promise<void>((resolve, reject) => {
      setTimeout(() => reject(new Error("Prepare phase timed out")), peerTimeoutMs);
    });

    const prepareResult = await tryCatch(Promise.race([Promise.all(preparePromises), prepareTimeoutPromise]));
    if (prepareResult.error) {
      return err({ type: "timeout", context: prepareResult.error.message });
    }

    if (prepareResults.length < config.minSignaturesRequired) {
      return err({ type: "insufficient_peers", context: `Only ${prepareResults.length} peers available` });
    }

    return ok(prepareResults);
  }

  private async runProcessPhase(
    prepareResults: { publicKey: string; result: ProtocolPrepareResult<unknown> }[]
  ): Promise<Result<unknown, OracleError>> {
    const processInput: ProcessInput<unknown>[] = prepareResults.map((result) => ({
      pubkey: result.publicKey,
      data: result.result.data!,
    }));

    return this.plugin.process(processInput);
  }

  private async runValidatePhase(
    processedData: unknown,
    prepareResults: { publicKey: string; result: ProtocolPrepareResult<unknown> }[]
  ): Promise<Result<unknown, OracleError>> {
    const selectedPeers = prepareResults.map((result) => result.publicKey);

    if (prepareResults.length === 0) {
      return err({ type: "insufficient_peers" });
    }

    const firstPrepareResult = prepareResults[0]?.result.data;
    if (!firstPrepareResult) {
      return err({ type: "plugin_error", context: "No prepare result from primary peer" });
    }

    const primaryValidateResult = await this.plugin.validate(processedData, firstPrepareResult);
    if (primaryValidateResult.isErr()) {
      return err(primaryValidateResult.error);
    } else if (!primaryValidateResult.value) {
      return err({ type: "plugin_error", context: "Received no validation result from primary peer" });
    }

    // Peers from config that have been selected for validation, excluding ourselves
    const validationPeers = selectedPeers
      .map((peer) => config.peers.find((p) => p.publicKey === peer))
      .filter((peer) => peer !== undefined);

    let data: unknown = primaryValidateResult.value;
    for (const peer of validationPeers) {
      const preparedData = prepareResults.find((result) => result.publicKey === peer.publicKey)?.result.data;
      if (!preparedData) return err({ type: "plugin_error", context: "No prepared data received from peer" });
      const signature = prepareResults.find((result) => result.publicKey === peer.publicKey)?.result.signatureData?.signature;
      if (!signature) return err({ type: "plugin_error", context: "No signature received from peer" });

      const validationResult = await requestValidate(peer, {
        pluginId: this.plugin.metadata.id,
        input: data,
        preparedData,
        signature,
      });
      if (validationResult.isErr()) {
        return err(validationResult.error);
      }

      data = validationResult.value;
    }

    return ok(data);
  }

  private async runExecutePhase(validatedData: unknown): Promise<Result<unknown, OracleError>> {
    return this.plugin.execute(validatedData);
  }

  async start(): Promise<Result<T, OracleError>> {
    // Run each phase in sequence
    const prepareResultsRes = await this.runPreparePhase();

    if (prepareResultsRes.isErr()) {
      if (prepareResultsRes.error.type === "permanent_error") {
        logger.warn(`Permanent error during prepare phase for plugin ${this.plugin.metadata.id}`);
        return ok(undefined as T);
      }
      logger.error(`Error during prepare phase: ${prepareResultsRes.error.type} > ${prepareResultsRes.error.context}`);
      return err(prepareResultsRes.error);
    }

    const prepareResults = prepareResultsRes.value;
    const processedData = await this.runProcessPhase(prepareResults);
    if (processedData.isErr()) {
      logger.error(`Error during process phase: ${processedData.error.type} > ${processedData.error.context}`);
      return err(processedData.error);
    }

    const validatedData = await this.runValidatePhase(processedData.value, prepareResults);
    if (validatedData.isErr()) {
      logger.error(`Error during validate phase: ${validatedData.error.type} > ${validatedData.error.context}`);
      return err(validatedData.error);
    }

    const executeResult = await this.runExecutePhase(validatedData.value);
    if (executeResult.isErr()) {
      logger.error(`Error during execute phase: ${executeResult.error.type} > ${executeResult.error.context}`);
      return err(executeResult.error);
    }

    completedTasksTotal.inc({ plugin_id: this.plugin.metadata.id });
    taskDurationTotal.observe({ plugin_id: this.plugin.metadata.id }, Date.now() - this.startTime);
    return ok(executeResult.value as T);
  }
}
