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
import erc20 from "../util/abis/erc20";
import { ERC20Forwarder } from "../plugins/ERC20Forwarder";
import type { ERC20ForwarderInput } from "../plugins/ERC20Forwarder";
import cache from "../core/cache";
import { getBlockNumberCacheKey } from "../util/cache-keys";

export class ERC20Listener extends Listener {
  private readonly _directoryNodeUrlPool: string[];
  private readonly _blockchainRid: string;
  private readonly _blockHeightIncrement: bigint;
  private readonly _throttleOnSuccessMs: number;
  private readonly _searchedBlockNumbers: Map<string, bigint>;
  constructor() {
    super(`erc20-listener`);
    this._directoryNodeUrlPool = config.abstractionChain.directoryNodeUrlPool;
    this._blockchainRid = config.abstractionChain.blockchainRid;
    this._blockHeightIncrement = BigInt(this.config["blockHeightIncrement"] as number);
    this._throttleOnSuccessMs = this.config["throttleOnSuccessMs"] as number;
    this._searchedBlockNumbers = new Map();
  }
  
  async run() {
    const contracts = await this.getContracts();
    logger.info(`ERC20Listener: Found ${contracts.length} contracts to index`);
    for (const contract of contracts) {
      const { provider } = createRandomProvider(config.rpc[contract.source] as unknown as Rpc[]);
      const contractAddress = `0x${contract.id}`;
      const ethersContract = new Contract(contractAddress, erc20, provider);

      const cacheKey = getBlockNumberCacheKey(contract.source);
      let currentBlockNumber: bigint = await cache.get(cacheKey) as bigint;
      if (!currentBlockNumber) {
        const result = await ResultAsync.fromPromise<number, Error>(
          provider.getBlockNumber(),
          (error) => error as Error
        );
        
        if (result.isErr()) {
          logger.error(`Failed to get current block number`, { contract, error: result.error });
          return secondsFromNow(60);
        }

        currentBlockNumber = BigInt(result.value);
        cache.set(cacheKey, currentBlockNumber, 1000 * 60);
      }

      const numberOfBlocksToLagBehind = BigInt(10);
      if (contract.unit + numberOfBlocksToLagBehind > currentBlockNumber) {
        logger.info(`Skipping contract ${contractAddress} because it is already indexed`, { contract });
        continue;
      }

      const lastSearchedBlockNumber = this._searchedBlockNumbers.get(contractAddress);

      const startBlock = lastSearchedBlockNumber && lastSearchedBlockNumber > contract.unit ? lastSearchedBlockNumber : contract.unit;
      const endBlock = BigInt(Math.min(Number(startBlock) + Number(this._blockHeightIncrement), Number(currentBlockNumber)));

      const filter = ethersContract.filters!.Transfer!();
      const events = await ethersContract.queryFilter(filter, startBlock, endBlock);
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

    return client.query<AssetInfo[]>('assets.get_assets_info', { type: "erc20" });
  }

  private uniqueId(event: Log | EventLog) {
    return `${event.transactionHash}-${event.index}`;
  }

  private sortEvents(events: Log[] | EventLog[]) {
    return events.sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) {
        return a.blockNumber - b.blockNumber;
      }
      return a.index - b.index;
    });
  }

  private async handleEvent(chain: string, event: Log | EventLog): Promise<Result<boolean, OracleError>> {
    const input: ERC20ForwarderInput = { chain, event };
    const task = new Task(ERC20Forwarder.pluginId, input);
    const result = await task.start();
    if (result.isErr()) {
      if (result.error.type === "non_error") {
        logger.info(`Skipping event ${this.uniqueId(event)} because it was marked as a non-error`, { event });
        return ok(true);
      }
      
      return result;
    }
    return ok(result.value);
  }
}