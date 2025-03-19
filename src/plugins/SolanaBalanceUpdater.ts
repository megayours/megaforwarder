import { Plugin } from "../core/plugin/Plugin";
import type { PrepareResult, ProcessInput, ProcessResult, ValidateResult, ExecuteResult } from "../core/types/Protocol";
import { logger } from "../util/monitoring";
import config from "../config";
import { createClient, getDigestToSignFromRawGtxBody, gtx, type GTX, type RawGtxBody } from "postchain-client";
import { ecdsaSign } from "secp256k1";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddress } from "@solana/spl-token";
import { Throttler } from "../util/throttle";

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
  status: "success" | "failure";
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

  async prepare(input: SolanaBalanceUpdaterInput): Promise<PrepareResult<BalanceUpdateEvent>> {
    logger.info(`Preparing balance update for user account`, {
      tokenMint: input.tokenMint,
      decimals: input.decimals,
      userAccount: input.userAccount
    });

    try {
      // Convert string addresses to PublicKeys
      const mintPubkey = new PublicKey(input.tokenMint);
      const userPubkey = new PublicKey(input.userAccount);
      
      // Get the associated token address for this user and token mint
      let tokenAddress;
      try {
        tokenAddress = await getAssociatedTokenAddress(
          mintPubkey,
          userPubkey,
          true // Allow owner off curve
        );
      } catch (err: any) {
        logger.warn(`Error getting associated token address: ${err.message}`, {
          tokenMint: input.tokenMint,
          userAccount: input.userAccount,
          error: err
        });
        
        return { status: "failure" };
      }
      
      logger.info(`Looking up token balance for address ${tokenAddress.toString()}`);
      
      // Get the token account info to fetch balance
      let balance = "0";
      
      try {
        // Use throttler to avoid rate limiting
        const tokenAccount = await this._throttler.execute(() => 
          getAccount(this._connection, tokenAddress)
        );
        
        // Extract balance from token account
        balance = tokenAccount.amount.toString();
        
        logger.info(`Retrieved token balance: ${balance}`);
      } catch (error: any) {
        // If the user doesn't have a token account yet, the balance is 0
        logger.info(`Could not find token account, assuming balance is 0: ${error.message || 'Unknown error'}`);
      }
      
      // For a balance update, pass the token mint, user account, and current balance to the Chromia blockchain
      return {
        status: "success",
        data: {
          operation: "solana.spl.balance_update",
          args: [
            input.tokenMint,
            input.userAccount,
            BigInt(balance),
            input.decimals
          ]
        }
      };
    } catch (error: any) {
      logger.error(`Error in SolanaBalanceUpdater:`, {
        error,
        message: error.message,
        stack: error.stack,
        tokenMint: input.tokenMint,
        userAccount: input.userAccount
      });
      return { status: "failure" };
    }
  }

  async process(input: ProcessInput<BalanceUpdateEvent>[]): Promise<ProcessResult<GTX>> {
    const selectedData = input[0];
    if (!selectedData) return { status: "failure" };
    const { operation, args }: BalanceUpdateEvent = selectedData.data;

    const emptyGtx = gtx.emptyGtx(this._megaYoursBlockchainRid);
    const tx = gtx.addTransactionToGtx(operation, args, emptyGtx);
    tx.signers = input.map((i) => Buffer.from(i.pubkey, 'hex'));
    return { status: "success", data: tx };
  }

  async validate(gtx: GTX, preparedData: BalanceUpdateEvent): Promise<ValidateResult<GTX>> {
    const gtxBody = [gtx.blockchainRid, gtx.operations.map((op) => [op.opName, op.args]), gtx.signers] as RawGtxBody;
    const digest = getDigestToSignFromRawGtxBody(gtxBody);
    const signature = Buffer.from(ecdsaSign(digest, Buffer.from(config.privateKey, 'hex')).signature);

    if (gtx.signatures) {
      gtx.signatures.push(signature);
    } else {
      gtx.signatures = [signature];
    }

    return { status: "success", data: gtx };
  }

  async execute(_gtx: GTX): Promise<ExecuteResult<SolanaBalanceUpdaterOutput>> {
    logger.info(`Executing GTX for balance update`);
    const client = await createClient({
      directoryNodeUrlPool: this._directoryNodeUrlPool,
      blockchainRid: this._megaYoursBlockchainRid.toString('hex')
    });

    try {
      await client.sendTransaction(gtx.serialize(_gtx));
      logger.info(`Balance update forwarded successfully`);
      return { 
        status: "success",
        data: {
          status: "success"
        }
      };
    } catch (error: any) {
      // Check if this is a 409 error (Transaction already in database)
      if (error.status === 409) {
        logger.info(`Transaction already in database, considering as success`);
        return { 
          status: "success",
          data: {
            status: "success"
          }
        };
      } else {
        // Log and return failure for any other error
        logger.error(`Failed to update balance:`, error);
        return { 
          status: "failure",
          data: {
            status: "failure",
            message: `Error: ${error}`
          }
        };
      }
    }
  }
} 