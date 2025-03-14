import { Connection } from "@solana/web3.js";
import bs58 from "bs58";
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
  args: string[];
}

type SolanaMegaForwarderOutput = {
  status: "success" | "failure";
}

export class SolanaMegaForwarder extends Plugin<SolanaMegaForwarderInput, Event, GTX, SolanaMegaForwarderOutput> {
  static readonly pluginId = "solana-mega-forwarder";

  protected readonly _connection: Connection;
  protected readonly _programId: string;
  private readonly _directoryNodeUrlPool: string[];
  private readonly _megaYoursBlockchainRid: Buffer;

  constructor() {
    super({ id: SolanaMegaForwarder.pluginId });

    this._connection = new Connection(this.config["solanaRpcUrl"] as string, "confirmed");
    this._programId = this.config["solanaProgramId"] as string;
    this._directoryNodeUrlPool = (this.config["directoryNodeUrlPool"] as string).split(',');
    this._megaYoursBlockchainRid = Buffer.from((this.config["blockchainRid"] as string), "hex");
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

    const event = logs.find((log) => log.includes('MEGATX:'));

    if (!event) {
      return { status: "failure" }
    }

    // Extract the base58 encoded data
    const base58Data = event.split('MEGATX:')?.[1]?.trim();
    if (!base58Data) {
      return { status: "failure" }
    }
    // Decode from base58
    const binaryData = bs58.decode(base58Data);

    // Create a buffer reader for manual deserialization
    const buffer = Buffer.from(binaryData);
    let offset = 0;

    // Read operation string
    const operationLength = buffer.readUInt32LE(offset);
    offset += 4;
    const operation = buffer.toString('utf8', offset, offset + operationLength);
    offset += operationLength;

    // Read args array
    const argsLength = buffer.readUInt32LE(offset);
    offset += 4;
    const args = [];

    for (let i = 0; i < argsLength; i++) {
      const argLength = buffer.readUInt32LE(offset);
      offset += 4;
      const arg = buffer.toString('utf8', offset, offset + argLength);
      offset += argLength;
      args.push(arg);
    }

    return { status: "success", data: { operation, args } };
  }

  async process(input: ProcessInput<Event>[]): Promise<ProcessResult<GTX>> {
    const selectedData = input[0];
    if (!selectedData) return { status: "failure" };
    const { operation, args }: Event = selectedData.data;

    const emptyGtx = gtx.emptyGtx(this._megaYoursBlockchainRid);
    const tx = gtx.addTransactionToGtx(operation, args, emptyGtx);
    tx.signers = [Buffer.from(config.publicKey, 'hex'), ...input.map((i) => Buffer.from(i.pubkey, 'hex'))];
    return { status: "success", data: tx };
  }

  async validate(gtx: GTX, preparedData: Event): Promise<ValidateResult<GTX>> {
    console.log("Validating", preparedData);
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

    await client.sendTransaction(gtx.serialize(_gtx));

    logger.info(`Executed successfully`);
    return { status: "success" };
  }
}