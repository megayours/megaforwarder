import { createCache, type Cache } from "cache-manager";
import type { IListener } from "../core/interfaces/IListener";
import { Task } from "../core/task/Task";
import { Connection, PublicKey, type ConfirmedSignatureInfo, type VersionedTransactionResponse } from "@solana/web3.js";
import { Listener } from "../core/listener/Listener";
import { SolanaMegaForwarder } from "../plugins/SolanaMegaForwarder";
import { logger } from "../util/monitoring";
import { createClient } from "postchain-client";
import config from "../config";
import { minutesFromNow, secondsFromNow } from "../util/time";
import { executeThrottled } from "../util/throttle";

const BLOCK_HEIGHT_INCREMENT = 100;

export class SolanaListener extends Listener implements IListener {
  private readonly _programId: string;
  private readonly _cache: Cache;
  private readonly _rpcUrl: string;
  private readonly _blockchainRid: string;
  private readonly _directoryNodeUrlPool: string[];
  private _currentBlockHeight: number = -1;
  private _programPubkey: PublicKey | null = null;

  constructor() {
    super("solana-listener");

    this._cache = createCache({ ttl: this.config["cacheTtlMs"] as number });
    this._programId = this.config["programId"] as string;

    const solanaRpcUrl = config.rpc["solana_devnet"]?.[0];
    if (!solanaRpcUrl) throw new Error("No Solana RPC URL found");

    this._rpcUrl = solanaRpcUrl;
    this._directoryNodeUrlPool = config.abstractionChain.directoryNodeUrlPool;
    this._blockchainRid = config.abstractionChain.blockchainRid;
  }

  private async getSlot(): Promise<number> {
    const client = await createClient({
      directoryNodeUrlPool: this._directoryNodeUrlPool,
      blockchainRid: this._blockchainRid
    });

    const slot = await client.query<number | null>('solana.megadata.get_slot');
    logger.info(`Starting from indexed slot ${slot}`);
    return slot ?? 0;
  }

  private validateAndSetProgramId(): boolean {
    if (!this._programId) {
      console.error('Error: solanaProgramId is not configured in the oracle config file');
      return false;
    }

    try {
      // Validate the program ID format
      this._programPubkey = new PublicKey(this._programId);
      return true;
    } catch (error) {
      console.error('Error: Invalid Solana program ID format:', this._programId);
      console.error('Program ID must be a valid base58 encoded public key');
      return false;
    }
  }

  async run(): Promise<number> {
    const previousIndexedSlot = await executeThrottled<number>(
      "solana", 
      () => this.getSlot()
    );

    if (previousIndexedSlot.isErr()) {
      logger.error(`Failed to get slot`);
      return secondsFromNow(60);
    }

    if (previousIndexedSlot.value > this._currentBlockHeight) {
      this._currentBlockHeight = previousIndexedSlot.value;
    }

    const connection = new Connection(this._rpcUrl);
    try {
      // Validate program ID if not already validated
      if (!this._programPubkey && !this.validateAndSetProgramId()) {
        return minutesFromNow(10);
      }

      if (!this._programPubkey) {
        throw new Error('Program public key not initialized');
      }

      const currentSlot = await executeThrottled<number>("solana", () => connection.getSlot());

      if (currentSlot.isErr()) {
        logger.error(`Failed to get slot`);
        return secondsFromNow(60);
      }
      

      // Get all signatures for the program
      let signaturesResult = await executeThrottled<ConfirmedSignatureInfo[]>("solana", () => connection.getSignaturesForAddress(
        this._programPubkey!,
        {
          minContextSlot: this._currentBlockHeight,
          limit: BLOCK_HEIGHT_INCREMENT,
        },
        'confirmed'
      ));

      if (signaturesResult.isErr() || !signaturesResult.value) {
        logger.error(`Failed to get signatures`);
        return secondsFromNow(60);
      }

      let signatures = signaturesResult.value;

      // Filter out cached signatures properly
      const uncachedSignatures = [];
      for (const sig of signatures) {
        const isCached = await this._cache.get(sig.signature);
        if (!isCached) {
          uncachedSignatures.push(sig);
        }
      }
      signatures = uncachedSignatures;

      if (signatures.length === 0) {
        logger.debug(`No new transactions found for the program in this period`);
        this._currentBlockHeight = currentSlot.value;
        return minutesFromNow(1);
      }

      logger.debug(`Found ${signatures.length} new transactions for program ${this._programPubkey.toBase58()}`);
      for (const sig of signatures.reverse()) {
        this._currentBlockHeight = sig.slot + 1;
        if (await this._cache.get(sig.signature)) {
          continue;
        }

        this._cache.set(sig.signature, true);
        logger.debug(`Cached ${sig.signature}`);

        // Get the full transaction details
        const tx = await executeThrottled<VersionedTransactionResponse | null>(this._rpcUrl, () => connection.getTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0
        }));

        if (tx.isErr()) {
          logger.error(`Failed to get transaction`);
          return secondsFromNow(60);
        }

        await this._cache.set(sig.signature, tx.value);
        if (tx.value) {
          if (tx.value.meta?.logMessages?.some((log: string) => log.includes('Operation name:'))) {
            const task = new Task(SolanaMegaForwarder.pluginId, { txSignature: sig.signature });
            const result = await task.start();
            if (result.isErr()) {
              if (result.error.type === "non_error") {
                logger.info(`Skipping transaction ${sig.signature}`);
                continue;
              }
              logger.error(`Failed to handle transaction: ${sig.signature}`);
              return secondsFromNow(60);
            }
          }
        }
      }

      this._currentBlockHeight = Math.min(currentSlot.value, this._currentBlockHeight);
      return secondsFromNow(1);
    } catch (error) {
      console.error('Error in Solana listener:', error);
      return secondsFromNow(5);
    }
  }
}