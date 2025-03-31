import { Result } from "neverthrow";
import config from "../config";
import { Task } from "../core/task/Task";
import { SolanaBalanceUpdater } from "../plugins/SolanaBalanceUpdater";
import { logger } from "../util/monitoring";
import type { OracleError } from "../util/errors";
import cache from "../core/cache";
import type { AssetInfo } from "../core/types/abstraction-chain/contract-info";
import { createClient } from "postchain-client";

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

const CACHE_KEY_TOKEN_MINTS = "solana_token_mints";
const TOKEN_MINTS_CACHE_TTL = 60; // 60 seconds

const getCachedTokenMints = async (): Promise<AssetInfo[]> => {
  const cachedMints = await cache.get<AssetInfo[]>(CACHE_KEY_TOKEN_MINTS);
  if (cachedMints) {
    return cachedMints;
  }

  const mints = await getTokenMints();
  await cache.set(CACHE_KEY_TOKEN_MINTS, mints, TOKEN_MINTS_CACHE_TTL);
  return mints;
};

const heliusWebhook = async (req: Request) => {
  const transferData = await req.json() as TransferData[];

  const header = req.headers;
  const authToken = header.get("Authorization");

  if (authToken !== config.webhooks.helius.authKey) {
    return new Response("Unauthorized", { status: 401 });
  }

  const trackedTokenMints = await getCachedTokenMints();
  const trackedMintAddresses = trackedTokenMints.map(mint => mint.id.toLowerCase());

  const tokenTransfers = transferData
    .flatMap((transfer) => transfer.accountData)
    .flatMap((accountData) => accountData.tokenBalanceChanges)
    .filter((balance) => trackedMintAddresses.includes(balance.mint.toLowerCase()))
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

const getTokenMints = async (): Promise<AssetInfo[]> => {
  try {
    const client = await createClient({
      directoryNodeUrlPool: config.abstractionChain.directoryNodeUrlPool,
      blockchainRid: config.abstractionChain.blockchainRid
    });
    const assets = await client.query<AssetInfo[]>('assets.get_assets_info', { source: "solana", type: "spl" });

    const webhookConfigRes = await fetch(`${config.webhooks.helius.url}/v0/webhooks/${config.webhooks.helius.webhookId}?api-key=${config.webhooks.helius.apiKey}`);

    if (!webhookConfigRes.ok) {
      logger.error(`Helius webhook: Failed to get config`, { 
        status: webhookConfigRes.status,
        body: await webhookConfigRes.text()
      });
      return [];
    }

    const heliusWebhookConfig = await webhookConfigRes.json() as { accountAddresses: string[] };

    logger.info(`Helius webhook: Config`, { heliusWebhookConfig });

    const accountAddresses = heliusWebhookConfig.accountAddresses;

    // Check for assets that exist in our blockchain but not in the webhook config
    const missingAssets = assets.filter(asset => 
      !accountAddresses.some(addr => addr.toLowerCase() === asset.id.toLowerCase())
    );

    if (missingAssets.length > 0) {
      logger.info(`Helius webhook: Found assets not in webhook config`, { 
        missingAssets: missingAssets.map(asset => asset.id) 
      });
      
      // Update webhook with all assets from our blockchain
      const res = await fetch(`${config.webhooks.helius.url}/v0/webhooks/${config.webhooks.helius.webhookId}?api-key=${config.webhooks.helius.apiKey}`, {
        method: "PUT",
        body: JSON.stringify({ accountAddresses: assets.map(asset => asset.id) })
      });

      if (!res.ok) {
        logger.error(`Helius webhook: Failed to update webhook with all assets`, { 
          status: res.status,
          body: await res.text()
        });
      } else {
        logger.info(`Helius webhook: Updated webhook with all assets`, { 
          totalAssets: assets.length 
        });
      }
    }

    return assets;
  } catch (error) {
    logger.error(`Helius webhook: Failed to get contracts from directory chain`, error);
    console.error(error);
    return []; // Return empty array on error
  }
}

export default heliusWebhook;