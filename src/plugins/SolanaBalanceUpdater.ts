import { Plugin } from "../core/plugin/Plugin";
import type { ProcessInput } from "../core/types/Protocol";
import { logger } from "../util/monitoring";
import config from "../config";
import { createClient, getDigestToSignFromRawGtxBody, gtx, type GTX, type RawGtxBody } from "postchain-client";
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

    // Get the associated token address for this user and token mint
    const tokenAddress = await this._throttler.execute(() =>
      ResultAsync.fromPromise(
        getAssociatedTokenAddress(
          mintPubkey,
          userPubkey,
          true // Allow owner off curve
        ),
        (error): PluginError => ({ type: "prepare_error", context: `Error getting associated token address: ${error}` })
      )
    );

    if (tokenAddress.isErr()) {
      return err({ type: "prepare_error", context: `Error getting associated token address: ${tokenAddress.error}` });
    }

    logger.info(`Looking up token balance for address ${tokenAddress.toString()}`);

    // Get the token account info to fetch balance
    let balance = "0";

    // Use throttler to avoid rate limiting
    const tokenAccount = await this._throttler.execute(() =>
      ResultAsync.fromPromise(
        getAccount(this._connection, tokenAddress.value),
        (error): PluginError => ({ type: "prepare_error", context: `Error getting token account: ${error}` })
      )
    );

    if (tokenAccount.isErr()) {
      return err({ type: "prepare_error", context: `Error getting token account: ${tokenAccount.error}` });
    }

    // Extract balance from token account
    balance = tokenAccount.value.amount.toString();

    logger.info(`Retrieved token balance: ${balance}`);

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
    const tx = gtx.addTransactionToGtx(operation, args, emptyGtx);
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
    logger.info(`Executing GTX for balance update`);
    const client = await createClient({
      directoryNodeUrlPool: this._directoryNodeUrlPool,
      blockchainRid: this._megaYoursBlockchainRid.toString('hex')
    });

    try {
      await client.sendTransaction(gtx.serialize(_gtx));
      logger.info(`Balance update forwarded successfully`);
      return ok({
        message: "Balance update forwarded successfully"
      });
    } catch (error: any) {
      // Check if this is a 409 error (Transaction already in database)
      if (error.status === 409) {
        logger.info(`Transaction already in database, considering as success`);
        return ok({
          message: "Balance update forwarded successfully"
        });
      } else {
        // Log and return failure for any other error
        logger.error(`Failed to update balance:`, error);
        return err({ type: "execute_error", context: `Error: ${error}` });
      }
    }
  }
} 