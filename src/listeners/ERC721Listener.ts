import { Contract } from "ethers";
import { Listener } from "../core/listener/Listener";
import { logger } from "../util/monitoring";
import { createClient } from "postchain-client";
import { bufferToHex } from "../util/hex";
import type { Log } from "ethers";
import type { EventLog } from "ethers";
import { ERC721Forwarder, type ERC721ForwarderInput } from "../plugins/ERC721Forwarder";
import { Task } from "../core/task/Task";
import config from "../config";
import { err, ok, Result, ResultAsync } from "neverthrow";
import { createCache, type Cache } from "cache-manager";
import { millisecondsFromNow, secondsFromNow } from "../util/time";
import type { OracleError } from "../util/errors";
import { createRandomProvider } from "../util/create-provider";
import type { Rpc } from "../core/types/config/Rpc";
import type { ContractInfo } from "../core/types/abstraction-chain/contract-info";
import erc721 from "../util/abis/erc721";
import cache from "../core/cache";

export class ERC721Listener extends Listener {
  private readonly _directoryNodeUrlPool: string[];
  private readonly _blockchainRid: string;
  private readonly _blockHeightIncrement: number;
  private readonly _throttleOnSuccessMs: number;
  
  constructor() {
    super(`erc721-listener`);
    this._directoryNodeUrlPool = config.abstractionChain.directoryNodeUrlPool;
    this._blockchainRid = config.abstractionChain.blockchainRid;
    this._blockHeightIncrement = this.config["blockHeightIncrement"] as number;
    this._throttleOnSuccessMs = this.config["throttleOnSuccessMs"] as number;
  }
  
  async run() {
    const contracts = await this.getContracts();
    logger.info(`ERC721Listener: Found ${contracts.length} contracts to index`);
    for (const contract of contracts) {
      const { provider } = createRandomProvider(config.rpc[contract.chain] as unknown as Rpc[]);
      const contractAddress = `0x${bufferToHex(contract.contract)}`;
      const ethersContract = new Contract(contractAddress, erc721, provider);
      logger.info(`ERC721Listener: Created contract`, { ethersContract });

      const cacheKey = this.getBlockNumberCacheKey(contract.chain);
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

      logger.info(`ERC721Listener: Current block number`, { currentBlockNumber });

      const numberOfBlocksToLagBehind = 10;
      if (contract.block_number + numberOfBlocksToLagBehind > currentBlockNumber) {
        logger.info(`Skipping contract ${contractAddress} because it is already indexed`, { contract });
        continue;
      }

      const startBlock = contract.block_number;
      const endBlock = Math.min(startBlock + this._blockHeightIncrement, currentBlockNumber);

      const filter = ethersContract.filters!.Transfer!();
      const events = await ethersContract.queryFilter(filter, startBlock, endBlock);
      for (const event of this.sortEvents(events)) {
        const result = await this.handleEvent(contract.chain, contract.collection, event);
        if (result.isErr()) {
          logger.error(`Failed to handle event`, { contract, error: result.error });
          return secondsFromNow(60);
        }
      }
    }

    return millisecondsFromNow(this._throttleOnSuccessMs);
  }

  private getBlockNumberCacheKey(chain: string) {
    return `${chain}-block-number`;
  }

  private async getContracts() {
    const client = await createClient({
      directoryNodeUrlPool: this._directoryNodeUrlPool,
      blockchainRid: this._blockchainRid
    });

    return client.query<ContractInfo[]>('evm.get_contracts_info', { type: "erc721" });
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

  private async handleEvent(chain: string, collection: string, event: Log | EventLog): Promise<Result<boolean, OracleError>> {
    logger.info(`ERC721Listener: Handling event`, { event });
    const input: ERC721ForwarderInput = { chain, collection, event };
    const task = new Task(ERC721Forwarder.pluginId, input);
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