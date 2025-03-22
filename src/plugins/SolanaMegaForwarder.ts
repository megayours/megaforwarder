import { Connection, type VersionedTransactionResponse } from "@solana/web3.js";
import type { ProcessInput } from "../core/types/Protocol";
import { ChainConfirmationLevel, createClient, getDigestToSignFromRawGtxBody, gtx, type GTX, type RawGtxBody } from "postchain-client";
import config from "../config";
import { ecdsaSign } from "secp256k1";
import { Plugin } from "../core/plugin/Plugin";
import { logger, rpcCallsTotal, txProcessedTotal } from "../util/monitoring";
import { err, ok, type Result } from "neverthrow";
import type { OracleError } from "../util/errors";
import { executeThrottled } from "../util/throttle";
import { SOLANA_THROTTLE_LIMIT } from "../util/constants";

type SolanaMegaForwarderInput = {
  txSignature: string;
}

type Event = {
  operation: string;
  args: any[];
}

type TokenRegistration = {
  address: string;
  properties: any;
}

export class SolanaMegaForwarder extends Plugin<SolanaMegaForwarderInput, Event, GTX, boolean> {
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

  handleTokenRegistration(signature: string, transaction: VersionedTransactionResponse, data: TokenRegistration): Result<Event, OracleError> {
    const { address, properties } = data;

    logger.info(`New token Registration`, address);

    return ok({
      operation: "solana.megadata.register_token",
      args: [
          transaction.slot,
          signature,
          address,
          0,
        JSON.stringify(properties)
      ]
    });
  }

  handleTokenUpdate(signature: string, transaction: VersionedTransactionResponse, data: TokenRegistration): Result<Event, OracleError> {
    const { address, properties } = data;

    logger.info(`New token Update`, address);
    
    return ok({
      operation: "solana.megadata.update_metadata",
      args: [transaction.slot, signature, address, JSON.stringify(properties)]
    });
  }

  async prepare(input: SolanaMegaForwarderInput): Promise<Result<Event, OracleError>> {
    const transaction = await executeThrottled<VersionedTransactionResponse | null>(
      "solana",
      () => this._connection.getTransaction(input.txSignature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      }),
      SOLANA_THROTTLE_LIMIT
    );
    rpcCallsTotal.inc({ chain: "solana", chain_code: this._programId, rpc_url: this._connection.rpcEndpoint }, 1);

    if (transaction.isErr()) {
      return err({ type: "prepare_error", context: `Transaction not found` });
    }

    const logs = transaction.value?.meta?.logMessages;

    if (!logs) {
      return err({ type: "prepare_error", context: `No logs found` });
    }

    // Find signer, operation name and parameter from logs
    const signerLog = logs.find(log => log.includes('Signer:'));
    const operationLog = logs.find(log => log.includes('Operation name:'));
    const paramLog = logs.find(log => log.includes('Parameter:'));

    if (!signerLog || !operationLog || !paramLog) {
      return err({ type: "prepare_error", context: `No logs found` });
    }

    // Extract values from logs
    const operationParts = operationLog.split('Operation name:');
    const paramParts = paramLog.split('Parameter:');

    logger.info(`Operation: ${operationParts[1]?.trim()}`);
    logger.info(`Param: ${paramParts[1]?.trim()}`);

    if (operationParts.length < 2 || paramParts.length < 2) {
      return err({ type: "prepare_error", context: `No logs found` });
    }

    const operation = operationParts[1]!.trim();
    const param = paramParts[1]!.trim();

    if (operation === 'solana.megadata.register_token') {
      return this.handleTokenRegistration(input.txSignature, transaction.value!, JSON.parse(param));
    } else if (operation === 'solana.megadata.update_metadata') {
      return this.handleTokenUpdate(input.txSignature, transaction.value!, JSON.parse(param));
    } else {
      const args = [param];
      logger.info(`Misc operation`, operation);
      return ok({ operation, args });
    }
  }

  async process(input: ProcessInput<Event>[]): Promise<Result<GTX, OracleError>> {
    const selectedData = input[0];
    if (!selectedData) return err({ type: "process_error", context: `No input data` });
    const { operation, args }: Event = selectedData.data;

    const emptyGtx = gtx.emptyGtx(this._megaYoursBlockchainRid);
    const tx = gtx.addTransactionToGtx(operation, args, emptyGtx);
    tx.signers = input.map((i) => Buffer.from(i.pubkey, 'hex'));
    return ok(tx);
  }

  async validate(gtx: GTX, preparedData: Event): Promise<Result<GTX, OracleError>> {
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

  async execute(_gtx: GTX): Promise<Result<boolean, OracleError>> {
    logger.debug(`Executing GTX`);
    const client = await createClient({
      directoryNodeUrlPool: this._directoryNodeUrlPool,
      blockchainRid: this._megaYoursBlockchainRid.toString('hex')
    })

    try {
      await client.sendTransaction(gtx.serialize(_gtx), true, undefined, ChainConfirmationLevel.Dapp);
      logger.info(`Executed successfully`);
      txProcessedTotal.inc({ type: "solana_mega_forwarder" });
    } catch (error: any) {
      if (error.status >= 400 && error.status < 500) {
        logger.info(`Transaction already in database, considering as success`);
      } else {
        return err({ type: "execute_error", context: error?.message ?? "Unknown error" });
      }
    }

    return ok(true);
  }
}