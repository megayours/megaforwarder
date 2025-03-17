import type { IPlugin } from "../interfaces/IPlugin";
import { PluginRegistry } from "../plugin/PluginRegistry";
import config from "../../config";
import { requestPrepare, requestValidate } from "./client";
import { PluginNotFound } from "../errors/PluginNotFound";
import type { ProcessInput, ProtocolPrepareResult } from "../types/Protocol";
import { logger } from "../../util/monitoring";

export class Task<T> {
  private plugin: IPlugin<unknown, unknown, unknown, T>;
  private input: unknown;

  constructor(pluginId: string, input: unknown) {
    const plugin = PluginRegistry.getInstance().get(pluginId);
    if (!plugin) {
      throw new PluginNotFound(pluginId);
    }
    this.plugin = plugin as IPlugin<unknown, unknown, unknown, T>;
    this.input = input;
  }

  private async runPreparePhase(): Promise<{ publicKey: string; result: ProtocolPrepareResult<unknown> }[]> {
    const result = await this.plugin.prepare(this.input);
    if (result.status !== "success") {
      throw new Error(`Plugin ${this.plugin.metadata.id} returned invalid result: ${result.status}`);
    }

    const peers = config.peers;
    const peerTimeoutMs = config.peerTimeoutMs;

    const prepareResults: { publicKey: string; result: ProtocolPrepareResult<unknown> }[] = [];
    prepareResults.push({
      publicKey: config.publicKey,
      result: {
        status: "success",
        data: result.data,
        signatureData: null,
        encodedData: "<PRIMARY>"
      }
    });

    // Add ourselves to the list of peers
    const preparePromises = peers.map(async (peer) => {
      const result = await requestPrepare<unknown, unknown>(peer, {
        pluginId: this.plugin.metadata.id,
        input: this.input,
      });
      prepareResults.push({ publicKey: peer.publicKey, result });
    });

    const prepareTimeoutPromise = new Promise<void>((resolve, reject) => {
      setTimeout(() => reject(new Error("Prepare phase timed out")), peerTimeoutMs);
    });

    try {
      await Promise.race([Promise.all(preparePromises), prepareTimeoutPromise]);
    } catch (error: unknown) {
      if (error instanceof Error && error.message === "Prepare phase timed out") {
        logger.warn("Prepare phase timed out, proceeding with collected results");
      } else {
        throw error;
      }
    }

    if (prepareResults.length < config.minSignaturesRequired) {
      throw new Error(
        `Not enough peer prepares received. Got ${prepareResults.length}, required ${config.minSignaturesRequired}`
      );
    }

    return prepareResults;
  }

  private async runProcessPhase(
    prepareResults: { publicKey: string; result: ProtocolPrepareResult<unknown> }[]
  ): Promise<unknown> {
    const processInput: ProcessInput<unknown>[] = prepareResults.map((result) => ({
      pubkey: result.publicKey,
      data: result.result.data!,
    }));

    const processResult = await this.plugin.process(processInput);
    if (processResult.status !== "success") {
      throw new Error(`Plugin ${this.plugin.metadata.id} returned invalid result: ${processResult.status}`);
    }

    if (!processResult.data) {
      throw new Error("No data to validate");
    }

    return processResult.data;
  }

  private async runValidatePhase(
    processedData: unknown,
    prepareResults: { publicKey: string; result: ProtocolPrepareResult<unknown> }[]
  ): Promise<unknown> {
    const selectedPeers = prepareResults.map((result) => result.publicKey);

    if (prepareResults.length === 0) {
      throw new Error("No prepare results available for validation");
    }

    const firstPrepareResult = prepareResults[0]?.result.data;
    if (!firstPrepareResult) {
      throw new Error("First prepare result data is undefined");
    }

    const primaryValidateResult = await this.plugin.validate(processedData, firstPrepareResult);
    if (primaryValidateResult.status !== "success") {
      throw new Error(`Plugin ${this.plugin.metadata.id} returned invalid result: ${primaryValidateResult.status}`);
    } else if (!primaryValidateResult.data) {
      throw new Error("No data to validate");
    }

    // Peers from config that have been selected for validation, excluding ourselves
    const validationPeers = selectedPeers
      .map((peer) => config.peers.find((p) => p.publicKey === peer))
      .filter((peer) => peer !== undefined);

    let data = primaryValidateResult.data;
    for (const peer of validationPeers) {
      const preparedData = prepareResults.find((result) => result.publicKey === peer.publicKey)?.result.data;
      if (!preparedData) throw new Error("No prepared data received from peer");
      const signature = prepareResults.find((result) => result.publicKey === peer.publicKey)?.result.signatureData?.signature;
      if (!signature) throw new Error("No signature received from peer");

      const validationResult = await requestValidate<unknown, T>(peer, {
        pluginId: this.plugin.metadata.id,
        input: data,
        preparedData,
        signature,
      });
      if (validationResult.status !== "success") {
        throw new Error(`Plugin ${this.plugin.metadata.id} returned invalid result: ${validationResult.status}`);
      }

      if (!validationResult.data) throw new Error("No data received from peer");
      data = validationResult.data;
    }

    return data;
  }

  private async runExecutePhase(validatedData: unknown): Promise<void> {
    const executeResult = await this.plugin.execute(validatedData);
    if (executeResult.status !== "success") {
      throw new Error(`Plugin ${this.plugin.metadata.id} returned invalid result: ${executeResult.status}`);
    }
  }

  async start(): Promise<void> {
    // Run each phase in sequence
    const prepareResults = await this.runPreparePhase();
    const processedData = await this.runProcessPhase(prepareResults);
    const validatedData = await this.runValidatePhase(processedData, prepareResults);
    await this.runExecutePhase(validatedData);
  }
}
