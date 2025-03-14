import { createCache, type Cache } from "cache-manager";
import type { IListener } from "../core/interfaces/IListener";
import { Task } from "../core/task/Task";
import { Connection, PublicKey } from "@solana/web3.js";
import { Listener } from "../core/listener/Listener";
import { SolanaMegaForwarder } from "../plugins/SolanaMegaForwarder";
import { logger } from "../util/monitoring";
import { createClient } from "postchain-client";

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
    this._rpcUrl = this.config["rpcUrl"] as string;
    this._directoryNodeUrlPool = (this.config["directoryNodeUrlPool"] as string)?.split(',') ?? [];
    this._blockchainRid = this.config["blockchainRid"] as string;
  }

  private async getSlot(): Promise<number> {
    const client = await createClient({
      directoryNodeUrlPool: this._directoryNodeUrlPool,
      blockchainRid: this._blockchainRid
    });

    const slot = await client.query<number | null>('solana.get_slot');
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

  async run(): Promise<void> {
    if (this._currentBlockHeight === -1) {
      this._currentBlockHeight = await this.getSlot();
    }

    const connection = new Connection(this._rpcUrl);
    try {
      // Validate program ID if not already validated
      if (!this._programPubkey && !this.validateAndSetProgramId()) {
        return;
      }

      if (!this._programPubkey) {
        throw new Error('Program public key not initialized');
      }

      const currentSlot = await connection.getSlot();

      // Get all signatures for the program
      let signatures = await connection.getSignaturesForAddress(
        this._programPubkey,
        {
          minContextSlot: this._currentBlockHeight,
          limit: BLOCK_HEIGHT_INCREMENT,
        },
        'confirmed'
      );

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
        this._currentBlockHeight = currentSlot;
        return;
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
        const tx = await connection.getTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0
        });
        await this._cache.set(sig.signature, tx);
        if (tx) {
          if (tx.meta?.logMessages?.some(log => log.includes('Operation name:'))) {
            const task = new Task(SolanaMegaForwarder.pluginId, { txSignature: sig.signature });
            await task.start();
          }
        }
      }

      this._currentBlockHeight = Math.min(currentSlot, this._currentBlockHeight);
    } catch (error) {
      console.error('Error in Solana listener:', error);
    }
  }
}