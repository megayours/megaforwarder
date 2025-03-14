import type { IPlugin } from "../interfaces/IPlugin";
import { PluginRegistry } from "../plugin/PluginRegistry";
import config from "../../config";
import { requestPrepare, requestValidate } from "./client";
import { PluginNotFound } from "../errors/PluginNotFound";
import type { ProcessInput, ProtocolPrepareResult } from "../types/Protocol";
import type { Peer } from "../types/Peer";
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

  async start() {
    // Prepare phase
    const result = await this.plugin.prepare(this.input);
    if (result.status !== "success") {
      throw new Error(`Plugin ${this.plugin.metadata.id} returned invalid result: ${result.status}`);
    }

    const peers = config.peers;
    const peerTimeoutMs = config.peerTimeoutMs;

    const prepareResults: { peer: Peer, result: ProtocolPrepareResult<unknown> }[] = [];
    const preparePromises = peers.map(async (peer) => { 
      const result = await requestPrepare<unknown, unknown>(peer, { pluginId: this.plugin.metadata.id, input: this.input });
      prepareResults.push({ peer, result });
    });

    const prepareTimeoutPromise = new Promise<void>((resolve, reject) => {
      setTimeout(() => reject(new Error('Prepare phase timed out')), peerTimeoutMs);
    });

    try {
      await Promise.race([
        Promise.all(preparePromises),
        prepareTimeoutPromise
      ]);
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'Prepare phase timed out') {
        logger.warn('Prepare phase timed out, proceeding with collected results');
      } else {
        throw error;
      }
    }

    if (prepareResults.length < config.minSignaturesRequired) {
      throw new Error(`Not enough peer prepares received. Got ${prepareResults.length}, required ${config.minSignaturesRequired}`);
    }

    // Process phase
    const processInput: ProcessInput<unknown>[] = prepareResults.map((result) => ({
      pubkey: result.peer.publicKey,
      data: result.result.data!, // TODO: Handle undefined
    }));

    const processResult = await this.plugin.process(processInput);
    if (processResult.status !== "success") {
      throw new Error(`Plugin ${this.plugin.metadata.id} returned invalid result: ${processResult.status}`);
    }

    // Validate phase
    const selectedPeers = prepareResults.map((result) => result.peer);
    if (!processResult.data) throw new Error("No data to validate");

    const primaryValidateResult = await this.plugin.validate(processResult.data, result.data);
    if (primaryValidateResult.status !== "success") {
      throw new Error(`Plugin ${this.plugin.metadata.id} returned invalid result: ${primaryValidateResult.status}`);
    } else if (!primaryValidateResult.data) {
      throw new Error("No data to validate");
    }

    let data = primaryValidateResult.data;
    for (const peer of selectedPeers) {
      const preparedData = prepareResults.find((result) => result.peer.publicKey === peer.publicKey)?.result.data;
      if (!preparedData) throw new Error("No prepared data received from peer");
      const signature = prepareResults.find((result) => result.peer.publicKey === peer.publicKey)?.result.signatureData?.signature;
      if (!signature) throw new Error("No signature received from peer");

      const validationResult = await requestValidate<unknown, T>(peer, {
        pluginId: this.plugin.metadata.id,
        input: data,
        preparedData,
        signature
      });
      if (validationResult.status !== "success") {
        throw new Error(`Plugin ${this.plugin.metadata.id} returned invalid result: ${validationResult.status}`);
      }

      if (!validationResult.data) throw new Error("No data received from peer");
      data = validationResult.data;
    }

    // Execute phase
    const executeResult = await this.plugin.execute(data);
    if (executeResult.status !== "success") {
      throw new Error(`Plugin ${this.plugin.metadata.id} returned invalid result: ${executeResult.status}`);
    }
  }
}
