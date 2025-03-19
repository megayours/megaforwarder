import { Connection, type VersionedTransactionResponse } from "@solana/web3.js";
import type { PrepareResult, ProcessInput, ProcessResult, ValidateResult } from "../core/types/Protocol";
import { createClient, getDigestToSignFromRawGtxBody, gtx, type GTX, type RawGtxBody } from "postchain-client";
import config from "../config";
import { ecdsaSign } from "secp256k1";
import { Plugin } from "../core/plugin/Plugin";
import { logger } from "../util/monitoring";

type SolanaMegaForwarderInput = {
  txSignature: string;
}

type Event = {
  operation: string;
  args: any[];
}

type SolanaMegaForwarderOutput = {
  status: "success" | "failure";
}

type TokenRegistration = {
  address: string;
  properties: any;
}

export class SolanaMegaForwarder extends Plugin<SolanaMegaForwarderInput, Event, GTX, SolanaMegaForwarderOutput> {
  static readonly pluginId = "solana-mega-forwarder";

  protected readonly _connection: Connection;
  protected readonly _programId: string;
  private readonly _directoryNodeUrlPool: string[];
  private readonly _megaYoursBlockchainRid: Buffer;

  constructor() {
    super({ id: SolanaMegaForwarder.pluginId });

    const solanaRpcUrl = config.rpc["solana_devnet"]?.[0];
    if (!solanaRpcUrl) throw new Error("No Solana RPC URL found");

    this._connection = new Connection(solanaRpcUrl, "confirmed");
    this._programId = this.config.solanaProgramId as string;
    if (!this._programId) throw new Error("No Solana Program ID found");
    this._directoryNodeUrlPool = config.abstractionChain.directoryNodeUrlPool;
    this._megaYoursBlockchainRid = Buffer.from(config.abstractionChain.blockchainRid, "hex");
  }

  handleTokenRegistration(signature: string, transaction: VersionedTransactionResponse, data: TokenRegistration): PrepareResult<Event> {
    const { address, properties } = data;

    logger.info(`New token Registration`, address);

    return { 
      status: "success",
      data: {
        operation: "solana.megadata.register_token", 
        args: [
          transaction.slot,
          signature,
          address,
          0,
          JSON.stringify(properties)
        ] 
      } };
  }

  handleTokenUpdate(signature: string, transaction: VersionedTransactionResponse, data: TokenRegistration): PrepareResult<Event> {
    const { address, properties } = data;

    logger.info(`New token Update`, address);
    
    return {
      status: "success",
      data: {
        operation: "solana.megadata.update_metadata",
        args: [transaction.slot, signature, address, JSON.stringify(properties)]
      }
    }
  }

  async prepare(input: SolanaMegaForwarderInput): Promise<PrepareResult<Event>> {
    const transaction = await this._connection.getTransaction(input.txSignature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });

    if (!transaction) {
      return { status: "failure" }
    }

    const logs = transaction.meta?.logMessages;

    if (!logs) {
      return { status: "failure" }
    }

    // Find signer, operation name and parameter from logs
    const signerLog = logs.find(log => log.includes('Signer:'));
    const operationLog = logs.find(log => log.includes('Operation name:'));
    const paramLog = logs.find(log => log.includes('Parameter:'));

    if (!signerLog || !operationLog || !paramLog) {
      return { status: "failure" }
    }

    // Extract values from logs
    const operationParts = operationLog.split('Operation name:');
    const paramParts = paramLog.split('Parameter:');

    logger.info(`Operation: ${operationParts[1]?.trim()}`);
    logger.info(`Param: ${paramParts[1]?.trim()}`);

    if (operationParts.length < 2 || paramParts.length < 2) {
      return { status: "failure" }
    }

    const operation = operationParts[1]!.trim();
    const param = paramParts[1]!.trim();

    if (operation === 'solana.megadata.register_token') {
      return this.handleTokenRegistration(input.txSignature, transaction, JSON.parse(param));
    } else if (operation === 'solana.megadata.update_metadata') {
      return this.handleTokenUpdate(input.txSignature, transaction, JSON.parse(param));
    } else {
      const args = [param];
      logger.info(`Misc operation`, operation);
      return { status: "success", data: { operation, args } };
    }
  }

  async process(input: ProcessInput<Event>[]): Promise<ProcessResult<GTX>> {
    const selectedData = input[0];
    if (!selectedData) return { status: "failure" };
    const { operation, args }: Event = selectedData.data;

    const emptyGtx = gtx.emptyGtx(this._megaYoursBlockchainRid);
    const tx = gtx.addTransactionToGtx(operation, args, emptyGtx);
    tx.signers = input.map((i) => Buffer.from(i.pubkey, 'hex'));
    return { status: "success", data: tx };
  }

  async validate(gtx: GTX, preparedData: Event): Promise<ValidateResult<GTX>> {
    const gtxBody = [gtx.blockchainRid, gtx.operations.map((op) => [op.opName, op.args]), gtx.signers] as RawGtxBody;
    const digest = getDigestToSignFromRawGtxBody(gtxBody);
    const signature = Buffer.from(ecdsaSign(digest, Buffer.from(config.privateKey, 'hex')).signature);

    if (gtx.signatures) {
      gtx.signatures.push(signature);
    } else {
      gtx.signatures = [signature];
    }

    return { status: "success", data: gtx }
  }

  async execute(_gtx: GTX): Promise<SolanaMegaForwarderOutput> {
    logger.info(`Executing GTX`);
    const client = await createClient({
      directoryNodeUrlPool: this._directoryNodeUrlPool,
      blockchainRid: this._megaYoursBlockchainRid.toString('hex')
    })

    try {
      await client.sendTransaction(gtx.serialize(_gtx));
      logger.info(`Executed successfully`);
    } catch (error: any) {
      // Check if this is a 409 error (Transaction already in database)
      if (error.status >= 400 && error.status < 500) {
        logger.info(`Ignoring transaction, considering as success`);
      } else {
        logger.error(`Error executing transaction`, error);
      }
    }
    
    return { status: "success" };
  }
}