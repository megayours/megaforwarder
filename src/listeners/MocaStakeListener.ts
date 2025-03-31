import { Contract } from "ethers";
import { Listener } from "../core/listener/Listener";
import { logger } from "../util/monitoring";
import { createClient } from "postchain-client";
import { bufferToHex } from "../util/hex";
import type { Log } from "ethers";
import type { EventLog } from "ethers";
import { Task } from "../core/task/Task";
import config from "../config";
import { ok, Result, ResultAsync } from "neverthrow";
import { millisecondsFromNow, secondsFromNow } from "../util/time";
import type { OracleError } from "../util/errors";
import { createRandomProvider } from "../util/create-provider";
import type { Rpc } from "../core/types/config/Rpc";
import type { AssetInfo } from "../core/types/abstraction-chain/contract-info";
import mocaStakeAbi from "../util/abis/moca-staking";
import { MocaStakeForwarder } from "../plugins/MocaStakeForwarder";
import type { MocaStakeForwarderInput } from "../plugins/MocaStakeForwarder";
import cache from "../core/cache";
import { getBlockNumberCacheKey } from "../util/cache-keys";

type EventWrapper = {
  event: Log | EventLog;
  eventName: string;
}

export class MocaStakeListener extends Listener {
  private readonly _directoryNodeUrlPool: string[];
  private readonly _blockchainRid: string;
  private readonly _blockHeightIncrement: number;
  private readonly _throttleOnSuccessMs: number;
  private readonly _searchedBlockNumbers: Map<string, number>;
  constructor() {
    super(`moca-stake-listener`);
    this._directoryNodeUrlPool = config.abstractionChain.directoryNodeUrlPool;
    this._blockchainRid = config.abstractionChain.blockchainRid;
    this._blockHeightIncrement = this.config["blockHeightIncrement"] as number;
    this._throttleOnSuccessMs = this.config["throttleOnSuccessMs"] as number;
    this._searchedBlockNumbers = new Map();
  }

  async run() {
    const contracts = await this.getContracts();
    logger.info(`MocaStakeListener: Found ${contracts.length} contracts to index`);
    for (const contract of contracts) {
      const { provider } = createRandomProvider(config.rpc[contract.source] as unknown as Rpc[]);
      const contractAddress = `0x${contract.id}`;
      const ethersContract = new Contract(contractAddress, mocaStakeAbi, provider);

      const cacheKey = getBlockNumberCacheKey(contract.source);
      let currentBlockNumber: number = await cache.get(cacheKey) as number;
      if (!currentBlockNumber) {
        const result = await ResultAsync.fromPromise<number, Error>(
          provider.getBlockNumber(),
          (error) => error as Error
        );
        
        if (result.isErr()) {
          logger.error(`Failed to get current block number`, { contract, error: result.error });
          return secondsFromNow(60);
        }

        currentBlockNumber = result.value;
        cache.set(cacheKey, currentBlockNumber, 1000 * 60);
      }

      const numberOfBlocksToLagBehind = 10;
      if (contract.unit + numberOfBlocksToLagBehind > currentBlockNumber) {
        logger.info(`Skipping contract ${contractAddress} because it is already indexed`, { contract });
        continue;
      }

      const lastSearchedBlockNumber = this._searchedBlockNumbers.get(contractAddress);

      const startBlock = lastSearchedBlockNumber && lastSearchedBlockNumber > contract.unit ? lastSearchedBlockNumber : contract.unit;
      const endBlock = Math.min(startBlock + this._blockHeightIncrement, currentBlockNumber);

      const stakedFilter = ethersContract.filters!.Staked!();
      const stakedEvents = await ethersContract.queryFilter(stakedFilter, startBlock, endBlock);
      const stakedBehalfFilter = ethersContract.filters!.StakedBehalf!();
      const stakedBehalfEvents = await ethersContract.queryFilter(stakedBehalfFilter, startBlock, endBlock);
      const unstakedFilter = ethersContract.filters!.Unstaked!();
      const unstakedEvents = await ethersContract.queryFilter(unstakedFilter, startBlock, endBlock);
      const events = [
        ...stakedEvents.map((event) => ({ event, eventName: "Staked" })),
        ...stakedBehalfEvents.map((event) => ({ event, eventName: "StakedBehalf" })),
        ...unstakedEvents.map((event) => ({ event, eventName: "Unstaked" }))
      ];

      for (const event of this.sortEvents(events)) {
        const result = await this.handleEvent(contract.source, event);
        if (result.isErr()) {
          logger.error(`Failed to handle event`, { contract, error: result.error });
          return secondsFromNow(60);
        }
      }

      this._searchedBlockNumbers.set(contractAddress, endBlock);
    }

    return millisecondsFromNow(this._throttleOnSuccessMs);
  }

  private async getContracts() {
    const client = await createClient({
      directoryNodeUrlPool: this._directoryNodeUrlPool,
      blockchainRid: this._blockchainRid
    });

    return client.query<AssetInfo[]>('assets.get_assets_info', { source: null, type: "custom_moca_stake" });
  }

  private uniqueId(event: Log | EventLog) {
    return `${event.transactionHash}-${event.index}`;
  }

  private sortEvents(events: EventWrapper[]) {
    return events.sort((a, b) => {
      if (a.event.blockNumber !== b.event.blockNumber) {
        return a.event.blockNumber - b.event.blockNumber;
      }
      return a.event.index - b.event.index;
    });
  }

  private async handleEvent(chain: string, event: EventWrapper): Promise<Result<boolean, OracleError>> {
    const input: MocaStakeForwarderInput = { chain, eventName: event.eventName, event: event.event };
    const task = new Task(MocaStakeForwarder.pluginId, input);
    const result = await task.start();
    if (result.isErr()) {
      if (result.error.type === "non_error") {
        logger.info(`Skipping event ${this.uniqueId(event.event)} because it was marked as a non-error`, { event });
        return ok(true);
      }

      return result;
    }
    return ok(result.value);
  }
}