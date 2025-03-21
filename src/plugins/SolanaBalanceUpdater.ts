import { Plugin } from "../core/plugin/Plugin";
import type { ProcessInput } from "../core/types/Protocol";
import { logger } from "../util/monitoring";
import config from "../config";
import { ChainConfirmationLevel, createClient, getDigestToSignFromRawGtxBody, gtx, type GTX, type RawGtxBody } from "postchain-client";
import { ecdsaSign } from "secp256k1";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddress } from "@solana/spl-token";
import { Throttler } from "../util/throttle";
import { err, ok, ResultAsync, type Result } from "neverthrow";
import type { PluginError } from "../util/errors";

type SolanaBalanceUpdaterInput = {
  tokenMint: string;
  userAccount: string;
  decimals: number;
};

type BalanceUpdateEvent = {
  operation: string;
  args: any[];
};

type SolanaBalanceUpdaterOutput = {
  message?: string;
};

export class SolanaBalanceUpdater extends Plugin<SolanaBalanceUpdaterInput, BalanceUpdateEvent, GTX, SolanaBalanceUpdaterOutput> {
  static readonly pluginId = "solana-balance-updater";
  private readonly _connection: Connection;
  private readonly _directoryNodeUrlPool: string[];
  private readonly _megaYoursBlockchainRid: Buffer;
  private readonly _throttler = Throttler.getInstance("solana", 1);

  constructor() {
    super({ id: SolanaBalanceUpdater.pluginId });

    const solanaRpcUrl = config.rpc["solana"]?.[0];
    if (!solanaRpcUrl) throw new Error("No Solana RPC URL found");

    this._connection = new Connection(solanaRpcUrl);
    this._directoryNodeUrlPool = config.abstractionChain.directoryNodeUrlPool;
    this._megaYoursBlockchainRid = Buffer.from(config.abstractionChain.blockchainRid, "hex");
  }

  async prepare(input: SolanaBalanceUpdaterInput): Promise<Result<BalanceUpdateEvent, PluginError>> {
    logger.info(`Preparing balance update for user account`, {
      tokenMint: input.tokenMint,
      decimals: input.decimals,
      userAccount: input.userAccount
    });

    // Convert string addresses to PublicKeys
    const mintPubkey = new PublicKey(input.tokenMint);
    const userPubkey = new PublicKey(input.userAccount);

    logger.debug(`Looking up token account for mint ${mintPubkey.toString()} and user ${userPubkey.toString()}`);

    // Get the associated token address for this user and token mint
    const tokenAddress = await this._throttler.execute(() =>
      ResultAsync.fromPromise(
        getAssociatedTokenAddress(
          mintPubkey,
          userPubkey,
          true // Allow owner off curve
        ),
        (error): PluginError => ({ type: "permanent_error", context: `Error getting associated token address: ${error}` })
      )
    );

    if (tokenAddress.isErr()) {
      return err({ type: "permanent_error", context: `Error getting associated token address: ${tokenAddress.error}` });
    }

    logger.debug(`Looking up token balance for address ${tokenAddress.value.toString()}`);

    // Get the token account info to fetch balance
    let balance = "0";

    // First, try to find all token accounts using getParsedTokenAccountsByOwner
    // This is more reliable but potentially more expensive
    try {
      const tokenAccounts = await this._throttler.execute(() => 
        ResultAsync.fromPromise(
          this._connection.getParsedTokenAccountsByOwner(
            userPubkey,
            { mint: mintPubkey }
          ),
          (error: any): PluginError => ({ type: "prepare_error", context: `Error getting parsed token accounts: ${JSON.stringify(error)}` })
        )
      );
      
      if (tokenAccounts.isOk() && tokenAccounts.value.value.length > 0) {
        const accountInfo = tokenAccounts.value.value[0];
        if (accountInfo && accountInfo.account.data.parsed.info) {
          const parsedInfo = accountInfo.account.data.parsed.info;
          balance = parsedInfo.tokenAmount.amount;
          logger.debug(`Retrieved token balance from parsed account: ${balance} at address ${accountInfo.pubkey.toString()}`);
        } else {
          logger.info(`Retrieved account info structure is invalid`);
        }
      } else if (tokenAccounts.isErr()) {
        logger.warn(`Error getting parsed token accounts, falling back to ATA: ${JSON.stringify(tokenAccounts.error)}`);
        
        // Fallback to the ATA method
        const tokenAccountResult = await this._throttler.execute(() =>
          ResultAsync.fromPromise(
            getAccount(this._connection, tokenAddress.value),
            (error: any): PluginError => {
              // If token account doesn't exist, this is not an error - the balance is just 0
              if (error.name === "TokenAccountNotFoundError") {
                logger.info(`Token account not found for ${tokenAddress.value.toString()}, using 0 balance`);
                return { type: "non_error", context: "Token account not found" };
              }
              return { type: "prepare_error", context: `Error getting token account: ${JSON.stringify(error)}` };
            }
          )
        );

        if (tokenAccountResult.isOk()) {
          balance = tokenAccountResult.value.amount.toString();
          logger.debug(`Retrieved token balance from getAccount: ${balance}`);
        } else if (tokenAccountResult.error.type !== "non_error") {
          logger.warn(`Failed to get token balance via both methods: ${JSON.stringify(tokenAccountResult.error)}`);
        }
      } else {
        logger.info(`No token accounts found for mint ${mintPubkey.toString()}`);
      }
    } catch (error: any) {
      logger.error(`Error in token account lookup: ${JSON.stringify(error)}`);
    }

    logger.debug(`Final retrieved token balance: ${balance}`);

    // For a balance update, pass the token mint, user account, and current balance to the Chromia blockchain
    return ok({
      operation: "solana.spl.balance_update",
      args: [
        input.tokenMint,
        input.userAccount,
        BigInt(balance),
        input.decimals
      ]
    });
  }

  async process(input: ProcessInput<BalanceUpdateEvent>[]): Promise<Result<GTX, PluginError>> {
    const selectedData = input[0];
    if (!selectedData) return err({ type: "process_error", context: `No input data` });

    const { operation, args }: BalanceUpdateEvent = selectedData.data;

    const emptyGtx = gtx.emptyGtx(this._megaYoursBlockchainRid);
    let tx = gtx.addTransactionToGtx(operation, args, emptyGtx);
    tx = gtx.addTransactionToGtx('nop', [Math.floor(Math.random() * 1000000)], tx);
    tx.signers = input.map((i) => Buffer.from(i.pubkey, 'hex'));
    return ok(tx);
  }

  async validate(gtx: GTX, preparedData: BalanceUpdateEvent): Promise<Result<GTX, PluginError>> {
    const gtxBody = [gtx.blockchainRid, gtx.operations.map((op) => [op.opName, op.args]), gtx.signers] as RawGtxBody;
    const digest = getDigestToSignFromRawGtxBody(gtxBody);
    const signature = Buffer.from(ecdsaSign(digest, Buffer.from(config.privateKey, 'hex')).signature);

    if (gtx.signatures) {
      gtx.signatures.push(signature);
    } else {
      gtx.signatures = [signature];
    }

    return ok(gtx);
  }

  async execute(_gtx: GTX): Promise<Result<SolanaBalanceUpdaterOutput, PluginError>> {
    logger.debug(`Executing GTX for balance update`);
    const client = await createClient({
      directoryNodeUrlPool: this._directoryNodeUrlPool,
      blockchainRid: this._megaYoursBlockchainRid.toString('hex')
    });

    try {
      await client.sendTransaction(gtx.serialize(_gtx), true, undefined, ChainConfirmationLevel.ClusterAnchoring);
      logger.info(`Balance update forwarded successfully`);
    } catch (error: any) {
      // Check if this is a 409 error (Transaction already in database)
      if (error.status === 409) {
        logger.info(`Transaction already in database, considering as success`);
      } else {
        // Log and return failure for any other error
        logger.error(`Failed to update balance:`, error);
        return err({ type: "execute_error", context: `Error: ${error}` });
      }
    }

    return ok({
      message: "Balance update forwarded successfully"
    });
  }
} 