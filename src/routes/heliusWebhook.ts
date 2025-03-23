import { Result } from "neverthrow";
import config from "../config";
import { Task } from "../core/task/Task";
import { SolanaBalanceUpdater } from "../plugins/SolanaBalanceUpdater";
import { logger } from "../util/monitoring";
import type { OracleError } from "../util/errors";
import { createCache } from "cache-manager";

type RawTokenAmount = {
  decimals: number;
  tokenAmount: string;
}

type TokenBalanceChange = {
  mint: string;
  rawTokenAmount: RawTokenAmount;
  tokenAccount: string;
  userAccount: string;
}

type AccountData = {
  account: string;
  nativeBalanceChange: bigint;
  tokenBalanceChanges: TokenBalanceChange[];
}

type TransferData = {
  accountData: AccountData[];
}

const cache = createCache({
  ttl: 1000 * 60 * 60 * 24,
  nonBlocking: false,
});

const heliusWebhook = async (req: Request) => {
  const transferData = await req.json() as TransferData[];

  const header = req.headers;
  const authToken = header.get("Authorization");

  if (authToken !== config.webhooks.helius.apiKey) {
    return new Response("Unauthorized", { status: 401 });
  }

  const tokenTransfers = transferData
    .flatMap((transfer) => transfer.accountData)
    .flatMap((accountData) => accountData.tokenBalanceChanges)
    .filter((balance) => balance.mint === "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv")
    .filter((balance) => balance.tokenAccount !== balance.userAccount)
    .filter((balance) => balance.rawTokenAmount.tokenAmount !== "0");

  logger.info(`Found ${tokenTransfers.length} token transfers`, { tokenTransfers });

  for (const tokenTransfer of tokenTransfers) {
    const cacheKey = `solana_balance_updater_${tokenTransfer.userAccount}`;
    const cachedResult = await cache.get(cacheKey);
    if (cachedResult) {
      logger.debug(`Using cached result for ${tokenTransfer.userAccount}`);
      continue;
    }

    await cache.set(cacheKey, true);

    const task = Result.fromThrowable(
      () => new Task(SolanaBalanceUpdater.pluginId, {
        tokenMint: tokenTransfer.mint,
        userAccount: tokenTransfer.userAccount,
        decimals: tokenTransfer.rawTokenAmount.decimals
      }),
      (error): OracleError => ({
        type: 'plugin_error',
        context: `Failed to create task: ${error}`
      })
    )();
    if (task.isErr()) {
      logger.error(`Failed to create task`, { error: task.error });
      return new Response(JSON.stringify({ error: task.error.type, context: task.error.context }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    const result = await task.value.start();
    if (result.isErr()) {
      logger.error(`Failed to start task`, { error: result.error });
      return new Response(JSON.stringify({ error: result.error.type, context: result.error.context }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  return new Response("OK");
};

export default heliusWebhook;