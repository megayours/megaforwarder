import { Contract } from "ethers";
import { Listener } from "../core/listener/Listener";
import { logger } from "../util/monitoring";
import { createClient } from "postchain-client";
import { bufferToHex } from "../util/hex";
import type { Log } from "ethers";
import type { EventLog } from "ethers";
import { Task } from "../core/task/Task";
import config from "../config";
import { ok, err, Result, ResultAsync } from "neverthrow";
import { millisecondsFromNow, secondsFromNow } from "../util/time";
import type { OracleError } from "../util/errors";
import { createRandomProvider } from "../util/create-provider";
import type { Rpc } from "../core/types/config/Rpc";
import type { AssetInfo } from "../core/types/abstraction-chain/contract-info";
import erc20 from "../util/abis/erc20";
import { ERC20Forwarder } from "../plugins/ERC20Forwarder";
import type { ERC20ForwarderInput } from "../plugins/ERC20Forwarder";
import cache from "../core/cache";
import { getBlockNumberCacheKey } from "../util/cache-keys";

// Define the structure for a single event input
type SingleERC20ForwarderInput = {
  chain: string;
  event: Log | EventLog;
};

// Define the batched input structure
type BatchedERC20ForwarderInput = SingleERC20ForwarderInput[];

export class ERC20Listener extends Listener {
  private readonly _directoryNodeUrlPool: string[];
  private readonly _blockchainRid: string;
  private readonly _blockHeightIncrement: number;
  private readonly _throttleOnSuccessMs: number;
  private readonly _searchedBlockNumbers: Map<string, number>;
  private readonly _batchSize: number; // New property for batch size

  constructor() {
    super(`erc20-listener`);
    this._directoryNodeUrlPool = config.abstractionChain.directoryNodeUrlPool;
    this._blockchainRid = config.abstractionChain.blockchainRid;
    // Access listener-specific config
    const listenerConfig = config.listeners[this.id] ?? {};
    this._blockHeightIncrement = (listenerConfig["blockHeightIncrement"] as number) ?? 100; // Default value
    this._throttleOnSuccessMs = (listenerConfig["throttleOnSuccessMs"] as number) ?? 5000; // Default value
    this._batchSize = (listenerConfig["batchSize"] as number) ?? 1; // Default batch size is 1
    this._searchedBlockNumbers = new Map();
    logger.info(`ERC20Listener initialized with batch size ${this._batchSize}`);
  }
  
  async run() {
    const contracts = await this.getContracts();
    if (contracts.length === 0) {
      logger.info(`ERC20Listener: No ERC20 contracts found to index`);
      return secondsFromNow(60); // Wait longer if no contracts
    }
    logger.info(`ERC20Listener: Found ${contracts.length} contracts to index`);
    
    for (const contract of contracts) {
      const { provider } = createRandomProvider(config.rpc[contract.source] as unknown as Rpc[]);
      const contractAddress = `0x${contract.id}`;
      const ethersContract = new Contract(contractAddress, erc20, provider);

      // --- Block Number Management ---
      const cacheKey = getBlockNumberCacheKey(contract.source);
      let currentBlockNumber: number | undefined = await cache.get(cacheKey) as number | undefined;
      if (!currentBlockNumber) {
        const result = await ResultAsync.fromPromise<number, Error>(
          provider.getBlockNumber(),
          (error) => error as Error
        );
        
        if (result.isErr()) {
          logger.error(`Failed to get current block number`, { contract: contractAddress, chain: contract.source, error: result.error });
          // Continue to next contract if block number fetch fails for one
          continue;
        }

        currentBlockNumber = result.value;
        // Cache for 1 minute
        await cache.set(cacheKey, currentBlockNumber, 60);
      }

      logger.info(`ERC20Listener: Current block number for chain ${contract.source}`, { currentBlockNumber });

      const numberOfBlocksToLagBehind = 10; // Configurable?
      const effectiveCurrentBlock = currentBlockNumber - numberOfBlocksToLagBehind;

      if (contract.unit >= effectiveCurrentBlock) {
        logger.info(`Skipping contract ${contractAddress} on chain ${contract.source} as it is already indexed up to or beyond the safe lag block`, { contractUnit: contract.unit, effectiveCurrentBlock });
        continue;
      }

      const lastSearchedBlockNumber = this._searchedBlockNumbers.get(contractAddress);
      const startBlock = Math.max(
        lastSearchedBlockNumber ? lastSearchedBlockNumber + 1 : 0, // Start from next block if previously searched
        contract.unit // Don't search before the contract's starting unit
      );
      const endBlock = Math.min(startBlock + this._blockHeightIncrement -1, effectiveCurrentBlock); // -1 because query is inclusive

      if (startBlock > endBlock) {
        logger.info(`Skipping contract ${contractAddress} on chain ${contract.source} as startBlock ${startBlock} is greater than endBlock ${endBlock}. Likely caught up.`, { lastSearchedBlockNumber, contractUnit: contract.unit, effectiveCurrentBlock });
        continue;
      }

      // --- Event Fetching and Batching ---
      logger.info(`ERC20Listener: Querying events for ${contractAddress} between blocks ${startBlock} and ${endBlock}`);
      const filter = ethersContract.filters!.Transfer!();
      let events: Array<Log | EventLog> = [];
      try {
        events = await ethersContract.queryFilter(filter, startBlock, endBlock);
      } catch (error) {
        logger.error(`ERC20Listener: Failed to query events for ${contractAddress}`, { error, startBlock, endBlock });
        // Potentially add retry logic or just continue to next contract
        continue; // Skip this contract for this run if query fails
      }

      logger.info(`ERC20Listener: Found ${events.length} events for ${contractAddress} between blocks ${startBlock} and ${endBlock}`);

      if (events.length > 0) {
        const sortedEvents = this.sortEvents(events);
        const eventBatch: SingleERC20ForwarderInput[] = [];

        for (const event of sortedEvents) {
          eventBatch.push({ chain: contract.source, event });

          if (eventBatch.length >= this._batchSize) {
            const result = await this.handleBatch(eventBatch);
            if (result.isErr()) {
              logger.error(`Failed to handle batch`, { contract: contractAddress, error: result.error });
              // Decide how to handle partial failure: Stop processing this contract? Return error?
              // For now, log error and stop processing this contract for this run.
              this._searchedBlockNumbers.set(contractAddress, event.blockNumber -1); // Record up to the block *before* the failed batch started
              return secondsFromNow(60); // Retry sooner on error
            }
            eventBatch.length = 0; // Clear the batch
          }
        }

        // Handle any remaining events in the last partial batch
        if (eventBatch.length > 0) {
          const result = await this.handleBatch(eventBatch);
          if (result.isErr()) {
            logger.error(`Failed to handle final batch`, { contract: contractAddress, error: result.error });
            this._searchedBlockNumbers.set(contractAddress, startBlock -1); // Record up to the block *before* this range if final batch fails
            return secondsFromNow(60); // Retry sooner on error
          }
        }
      }

      // Update last searched block number only if all batches were handled successfully for this range
      this._searchedBlockNumbers.set(contractAddress, endBlock);
    }

    return millisecondsFromNow(this._throttleOnSuccessMs);
  }

  private async getContracts(): Promise<AssetInfo[]> {
    try {
      const client = await createClient({
        directoryNodeUrlPool: this._directoryNodeUrlPool,
        blockchainRid: this._blockchainRid
      });
      return await client.query<AssetInfo[]>('assets.get_assets_info', { source: null, type: "erc20" });
    } catch (error) {
      logger.error(`ERC20Listener: Failed to get contracts from directory chain`, { error });
      return []; // Return empty array on error
    }
  }

  private uniqueId(event: Log | EventLog): string {
    return `${event.transactionHash}-${event.index}`;
  }

  private sortEvents(events: Log[] | EventLog[]): (Log | EventLog)[] {
    return events.sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) {
        return a.blockNumber - b.blockNumber;
      }
      return a.index - b.index;
    });
  }

  // New method to handle a batch of events
  private async handleBatch(batch: BatchedERC20ForwarderInput): Promise<Result<boolean, OracleError>> {
    if (batch.length === 0) {
      return ok(true); // Nothing to process
    }
    
    // Add null checks for the first and last items in the batch
    const firstEvent = batch[0];
    const lastEvent = batch[batch.length - 1];
    
    if (!firstEvent || !lastEvent) {
      logger.error(`ERC20Listener: Invalid batch with missing events`);
      return err({ type: "prepare_error", context: "Invalid batch with missing events" });
    }
    
    const firstEventId = this.uniqueId(firstEvent.event);
    const lastEventId = this.uniqueId(lastEvent.event);
    
    logger.info(`ERC20Listener: Handling batch of ${batch.length} events (from ${firstEventId} to ${lastEventId})`);

    // The Task now takes the entire batch as input
    const task = new Task<BatchedERC20ForwarderInput>(ERC20Forwarder.pluginId, batch);
    const result = await task.start();

    if (result.isErr()) {
      // Check for non-error (e.g., all events in batch already processed)
      if (result.error.type === "non_error") {
        logger.info(`Skipping batch (from ${firstEventId} to ${lastEventId}) because it was marked as a non-error`, { count: batch.length });
        return ok(true);
      }
      // Return the actual error
      return result;
    }
    return ok(result.value);
  }
}