import config from "../config";
import { PluginNotFound } from "../core/errors/PluginNotFound";
import { Task } from "../core/task/Task";
import type { TaskCreationRequest } from "../core/types/requests/TaskCreationRequest";
import { SolanaBalanceUpdater } from "../plugins/SolanaBalanceUpdater";
import { logger } from "../util/monitoring";

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

const heliusWebhook = async (req: Request) => {
  try {
    const transferData = await req.json() as TransferData[];

    logger.info(`Received Helius webhook`, { transferData });
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
      const task = new Task(SolanaBalanceUpdater.pluginId, {
        tokenMint: tokenTransfer.mint,
        userAccount: tokenTransfer.userAccount,
        decimals: tokenTransfer.rawTokenAmount.decimals
      });
      await task.start();
    }

    return new Response("OK");
  } catch (error: any) {
    if (error instanceof PluginNotFound) {
      return new Response(JSON.stringify({ error: error.message }), { 
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }
    console.error("Error processing task:", error);
    return new Response(JSON.stringify({ error: error.message }), { 
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
};

export default heliusWebhook;