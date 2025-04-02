import { createClient, getDigestToSignFromRawGtxBody, gtx, type GTX, type RawGtxBody } from "postchain-client";
import { Plugin } from "../core/plugin/Plugin";
import type { Result } from "neverthrow";
import { ok, err } from "neverthrow";
import type { OracleError } from "../util/errors";
import { ecdsaSign } from "secp256k1";
import config from "../config";
import { logger } from "../util/monitoring";
import { postchainConfig } from "../util/postchain-config";
import { validateAuth, type AccountSignature } from "../util/auth";
import type { ProcessInput } from "../core/types/Protocol";
import { randomUUIDv7 } from "bun";

type ManageMegadataInput = {
  auth: AccountSignature;
  collection: string;
  items: Item[];
};

type Item = {
  tokenId: string;
  properties: Record<string, any>;
}

type ManageMegadataOutput = {
  id: string;
}

export class ManageMegadata extends Plugin<ManageMegadataInput, ManageMegadataInput, GTX, ManageMegadataOutput> {
  static readonly pluginId = "manage-megadata";

  private readonly _directoryNodeUrlPool: string[];
  private readonly _blockchainRid: Buffer;

  constructor() {
    super({ id: ManageMegadata.pluginId });

    this._directoryNodeUrlPool = config.abstractionChain.directoryNodeUrlPool as string[];
    this._blockchainRid = Buffer.from(config.abstractionChain.blockchainRid as string, "hex");
  }

  async prepare(input: ManageMegadataInput): Promise<Result<ManageMegadataInput, OracleError>> {
    logger.info(`Preparing megadata collection with ${input.items.length} items`);
    const authResult = validateAuth(input.auth, `MegaData Management`);
    if (authResult.isErr()) {
      return err(authResult.error);
    }

    return ok(input);
  }

  async process(input: ProcessInput<ManageMegadataInput>[]): Promise<Result<GTX, OracleError>> {
    logger.info(`Processing manage megadata`);
    const selectedData = input[0];
    if (!selectedData) {
      return err({ type: "process_error", context: "No input data" });
    }

    let tx = gtx.emptyGtx(this._blockchainRid);
    const id = Buffer.from(randomUUIDv7("hex"), "hex");
    tx = gtx.addTransactionToGtx("megadata.create_collection", [selectedData.data.auth.account, id, selectedData.data.collection], tx);

    for (const item of selectedData.data.items) {
      tx = gtx.addTransactionToGtx("megadata.create_item", [id, item.tokenId, JSON.stringify(item.properties)], tx);
    }

    tx = gtx.addTransactionToGtx("nop", [Math.floor(Math.random() * 1000000)], tx);
    tx.signers = input.map((i) => Buffer.from(i.pubkey, "hex"));

    return ok(tx);
  }

  async validate(gtx: GTX, preparedData: ManageMegadataInput): Promise<Result<GTX, OracleError>> {
    const gtxBody = [gtx.blockchainRid, gtx.operations.map((op) => [op.opName, op.args]), gtx.signers] as RawGtxBody;
    const digest = getDigestToSignFromRawGtxBody(gtxBody);
    const signature = Buffer.from(ecdsaSign(digest, Buffer.from(config.privateKey, 'hex')).signature);

    if (gtx.signatures) {
      gtx.signatures.push(signature);
    } else {
      gtx.signatures = [signature];
    }

    logger.info(`Manage megadata validated successfully`);
    return ok(gtx);
  }

  async execute(_gtx: GTX): Promise<Result<ManageMegadataOutput, OracleError>> {
    logger.info(`Executing GTX for manage megadata`);
    const id = (_gtx.operations[0]?.args[1] as Buffer).toString('hex');
    if (!id) {
      return err({ type: "execute_error", context: "No id found" });
    }

    const client = await createClient({
      ...postchainConfig,
      directoryNodeUrlPool: this._directoryNodeUrlPool,
      blockchainRid: this._blockchainRid.toString('hex'),
    });

    try {
      const receipt = await client.sendTransaction(gtx.serialize(_gtx));
      logger.info(`Transaction receipt: ${JSON.stringify(receipt)}`);
      if (receipt.statusCode !== 200) {
        return err({ type: "execute_error", context: receipt.status });
      }
      logger.info(`Manage megadata executed successfully with txRid: ${receipt.transactionRid.toString('hex')}`);
    } catch (error: any) {
      // Check if this is a 409 error (Transaction already in database)
      if (error.status === 409) {
        logger.info(`Transaction already in database, considering as success`);
      } else {
        // Log and return failure for any other error
        logger.error(`Failed to manage megadata:`, error);
        return err({ type: "execute_error", context: `Error: ${error}` });
      }
    }

    return ok({ id });
  }
}