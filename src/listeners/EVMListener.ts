import { Contract, JsonRpcProvider } from "ethers";
import type { ContractEventName, InterfaceAbi } from "ethers";
import { Listener } from "../core/listener/Listener";
import { logger } from "../util/monitoring";
import { createClient } from "postchain-client";
import { hexToBuffer } from "../util/hex";
import type { Log } from "ethers";
import type { EventLog } from "ethers";
import { ERC721Forwarder, type ERC721ForwarderInput } from "../plugins/ERC721Forwarder";
import { Task } from "../core/task/Task";
import { ERC20Forwarder, type ERC20ForwarderInput } from "../plugins/ERC20Forwarder";
import { MocaStakeForwarder, type MocaStakeForwarderInput } from "../plugins/MocaStakeForwarder";
import { Throttler } from "../util/throttle";
import config from "../config";
import type { ListenerError } from "../util/errors";
import { err, ok, Result, ResultAsync } from "neverthrow";
import { createCache, type Cache } from "cache-manager";
import { secondsFromNow } from "../util/time";

export type ContractInfo = {
  chain: "ethereum";
  contract: string;
  startBlock: number;
  abi: InterfaceAbi;
  type: "erc721" | "erc20" | "moca_stake";
  filters: {
    name: string;
    filter: (contract: Contract) => ContractEventName;
  }[];
  collection?: string;
}

type EventWrapper = {
  name: string;
  event: Log | EventLog;
}

export class EVMListener extends Listener {
  private readonly _cache: Cache;
  private readonly _contractInfo: ContractInfo;
  private readonly _directoryNodeUrlPool: string[];
  private readonly _blockchainRid: string;
  private readonly _blockHeightIncrement: number;
  private readonly _throttler: Throttler;
  
  private _currentBlockNumber: number;
  
  constructor(contractInfo: ContractInfo) {
    super(`evm-listener`);
    this._contractInfo = contractInfo;
    this._directoryNodeUrlPool = config.abstractionChain.directoryNodeUrlPool;
    this._blockchainRid = config.abstractionChain.blockchainRid;
    this._blockHeightIncrement = this.config["blockHeightIncrement"] as number;
    this._currentBlockNumber = -1;
    this._cache = createCache({ ttl: this.config["cacheTtlMs"] as number });
    // Get throttler instance specific to this chain
    this._throttler = Throttler.getInstance(this._contractInfo.chain);
  }
  
  async run() {
    const rpcUrl = this.getRpcUrl();
    const provider = new JsonRpcProvider(rpcUrl);
    const contract = new Contract(this._contractInfo.contract, this._contractInfo.abi, provider);

    const previousIndexedBlockNumber = await this.initializeCurrentBlockNumber();
    if (previousIndexedBlockNumber > this._currentBlockNumber) {
      this._currentBlockNumber = previousIndexedBlockNumber;
    }

    let startBlock = this._currentBlockNumber;

    const currentBlockNumber = await this._throttler
      .execute(() => ResultAsync.fromPromise(provider.getBlockNumber(), (error) => error));

    if (currentBlockNumber.isErr()) {
      logger.error(`Failed to get current block number`, this.logMetadata());
      return secondsFromNow(15);
    }

    const blockNumber = Math.min(startBlock + this._blockHeightIncrement, currentBlockNumber.value);
    logger.info(`Fetching events from block ${startBlock} to ${blockNumber}`, this.logMetadata());

    const events: EventWrapper[] = [];
    for (const filter of this._contractInfo.filters) {
      const contractFilter = filter.filter(contract);
      const foundEvents = await this._throttler.execute(() => 
        ResultAsync.fromPromise(contract.queryFilter(contractFilter, startBlock, blockNumber), (error) => error)
      );

      if (foundEvents.isErr()) {
        logger.error(`Failed to get events`, this.logMetadata());
        return secondsFromNow(15);
      }

      events.push(...foundEvents.value.map(event => ({ name: filter.name, event })));
    }

    for (const event of this.sortEvents(events)) {
      const cachedSuccess = await this._cache.get(this.uniqueId(event));
      if (cachedSuccess) {
        logger.info(`Skipping event ${this.uniqueId(event)} because it was already processed`, this.logMetadata());
        continue;
      }

      const result = await this.handleEvent(event);
      if (result.isErr()) {
        if (result.error.type === "non_error") {
          logger.info(`Skipping event ${this.uniqueId(event)} because it was already processed`, this.logMetadata());
          continue;
        }
        logger.error(`Failed to handle event: ${event.event.transactionHash}, error: ${JSON.stringify(result)}`, this.logMetadata());
        return secondsFromNow(15);
      }

      this._cache.set(this.uniqueId(event), result);
    }

    this._currentBlockNumber = blockNumber;
    logger.info(`Processed to block ${blockNumber}`, this.logMetadata());
    return secondsFromNow(1);
  }

  private uniqueId(event: EventWrapper) {
    return `${event.event.transactionHash}-${event.event.index}`;
  }

  private getRpcUrl() {
    const rpcs = config.rpc[this._contractInfo.chain];
    if (!rpcs) throw new Error(`No RPC URL found for chain ${this._contractInfo.chain}`,);

    const rpcUrl = rpcs?.[Math.floor(Math.random() * rpcs.length)];
    if (!rpcUrl) throw new Error(`No RPC URL found for chain ${this._contractInfo.chain}`);

    logger.debug(`Selected RPC URL: ${rpcUrl}`);
    return rpcUrl;
  }

  private async initializeCurrentBlockNumber() {
    const indexedBlockNumber = await this.getIndexedBlockNumber();
    return indexedBlockNumber > 0 
      ? indexedBlockNumber 
      : this._contractInfo.startBlock - 1;
  }

  private async getIndexedBlockNumber(): Promise<number> {
    const client = await createClient({
      directoryNodeUrlPool: this._directoryNodeUrlPool,
      blockchainRid: this._blockchainRid
    });

    const blockNumber = await client
      .query<number | null>('evm.get_block_number', { 
        chain: this._contractInfo.chain,
        contract: hexToBuffer(this._contractInfo.contract)
      });

    logger.info(`Found indexed block ${blockNumber}`, this.logMetadata());
    return blockNumber ?? -1;
  }

  private sortEvents(events: EventWrapper[]) {
    return events.sort((a, b) => {
      if (a.event.blockNumber !== b.event.blockNumber) {
        return a.event.blockNumber - b.event.blockNumber;
      }
      return a.event.index - b.event.index;
    });
  }

  private async handleEvent(event: EventWrapper): Promise<Result<boolean, ListenerError>> {
    if (this._contractInfo.type === "erc721") {
      const input: ERC721ForwarderInput = {
        chain: this._contractInfo.chain,
        collection: this._contractInfo.collection!,
        event: event.event
      }
      const task = new Task(ERC721Forwarder.pluginId, input);
      const result = await task.start();
      if (result.isErr()) {
        if (result.error.type === "non_error") {
          logger.info(`Skipping event ${this.uniqueId(event)} because it was marked as a non-error`, this.logMetadata());
          return ok(true);
        }
        return err({ type: "task_error", context: result.error.context });
      }
      return ok(result.value);
    } 
    
    else if (this._contractInfo.type === "erc20") {
      const input: ERC20ForwarderInput = {
        chain: this._contractInfo.chain,
        event: event.event
      }
      const task = new Task(ERC20Forwarder.pluginId, input);
      const result = await task.start();
      if (result.isErr()) {
        return err({ type: "task_error", context: result.error.context });
      }
      return ok(result.value);
    } 
    
    else if (this._contractInfo.type === "moca_stake") {
      const input: MocaStakeForwarderInput = {
        chain: this._contractInfo.chain,
        eventName: event.name,
        event: event.event
      }
      const task = new Task(MocaStakeForwarder.pluginId, input);
      const result = await task.start();
      if (result.isErr()) {
        return err({ type: "task_error", context: result.error.context });
      }
      return ok(result.value);
    } 
    
    else {
      logger.error(`Unsupported contract type: ${this._contractInfo.type}`, this.logMetadata());
      return err({ 
        type: "unsupported_contract_type",
        context: `Unsupported contract type: ${this._contractInfo.type}` 
      });
    }
  }

  private logMetadata() {
    return {
      listener: this.id,
      contract: this._contractInfo.contract,
      chain: this._contractInfo.chain,
      type: this._contractInfo.type,
      collection: this._contractInfo.collection,
    }
  }
}