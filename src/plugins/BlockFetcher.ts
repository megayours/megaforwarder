import { Plugin } from "../core/plugin/Plugin";
import type { Result } from "neverthrow";
import { ok, err } from "neverthrow";
import type { OracleError } from "../util/errors";
import type { ProcessInput } from "../core/types/Protocol";
import { logger } from "../util/monitoring";
import cache from "../core/cache";
import { getBlockNumberCacheKey } from "../util/cache-keys";

type BlockFetcherInput = {
  chain: string;
};

export class BlockFetcher extends Plugin<BlockFetcherInput, number, number, number> {
  static readonly pluginId = "block-fetcher";

  constructor() {
    super({ id: BlockFetcher.pluginId });
  }

  async prepare(input: BlockFetcherInput): Promise<Result<number, OracleError>> {
    const cacheKey = getBlockNumberCacheKey(input.chain);
    const blockNumber = await cache.get<number>(cacheKey);
    if (!blockNumber) {
      return err({ type: "process_error", context: "No block number" });
    }

    logger.info(`Block fetcher prepared successfully`);
    return ok(blockNumber);
  }

  async process(input: ProcessInput<number>[]): Promise<Result<number, OracleError>> {
    logger.info(`Processing block fetcher`);
    const selectedData = input[0];
    if (!selectedData) {
      return err({ type: "process_error", context: "No input data" });
    }

    const { data: blockNumber } = selectedData;
    return ok(blockNumber);
  }

  async validate(blockNumber: number, preparedData: number): Promise<Result<number, OracleError>> {
    logger.info(`Block fetcher validated successfully`);
    return ok(blockNumber);
  }

  async execute(blockNumber: number): Promise<Result<number, OracleError>> {
    return ok(blockNumber);
  }
}