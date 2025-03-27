import { createClient, getDigestToSignFromRawGtxBody, gtx, type GTX, type RawGtxBody } from "postchain-client";
import { Plugin } from "../core/plugin/Plugin";
import type { Result } from "neverthrow";
import { ok, err } from "neverthrow";
import type { OracleError } from "../util/errors";
import type { ProcessInput } from "../core/types/Protocol";
import { ecdsaSign } from "secp256k1";
import config from "../config";
import { logger } from "../util/monitoring";
import { postchainConfig } from "../util/postchain-config";
import { hexToBuffer } from "../util/hex";
import { validateAuth, type AccountSignature } from "../util/auth";

type Operation = "create_collection" | "upsert_item" | "create_item" | "update_item" | "delete_item";

type ManageMegadataInput = {
  auth: AccountSignature;
  operation: Operation;
};

type UpsertItemInput = ManageMegadataInput & {
  operation: "upsert_item";
  collection: string;
  tokenId: string;
  properties: Record<string, any>;
}

type DeleteItemInput = ManageMegadataInput & {
  operation: "delete_item";
  collection: string;
  tokenId: string;
}

export class ManageMegadata extends Plugin<ManageMegadataInput, ManageMegadataInput, GTX, void> {
  static readonly pluginId = "manage-megadata";

  private readonly _directoryNodeUrlPool: string[];
  private readonly _blockchainRid: Buffer;

  constructor() {
    super({ id: ManageMegadata.pluginId });

    this._directoryNodeUrlPool = config.abstractionChain.directoryNodeUrlPool as string[];
    this._blockchainRid = Buffer.from(config.abstractionChain.blockchainRid as string, "hex");
  }

  async prepare(input: ManageMegadataInput): Promise<Result<ManageMegadataInput, OracleError>> {
    logger.info(`Preparing manage megadata with ${input.operation}`);

    const authResult = validateAuth(input.auth, `MegaData Management`);
    if (authResult.isErr()) {
      return err(authResult.error);
    }

    // TODO: Validate payments etc etc

    if (input.operation === "create_collection") {
      return ok(input);
    } else if (input.operation === "upsert_item") {
      const upsertItemInput = input as UpsertItemInput;
      const { collection, tokenId } = upsertItemInput;
      const collectionId = hexToBuffer(collection);
      const client = await createClient({
        ...postchainConfig,
        directoryNodeUrlPool: this._directoryNodeUrlPool,
        blockchainRid: this._blockchainRid.toString('hex'),
      });
      
      const ownerCollections = await client.query<Buffer[]>("megadata.get_collections", { owner: input.auth.account });
      if (!ownerCollections.some((c) => c.equals(collectionId))) {
        return err({
          type: "validation_error",
          context: `Collection ${collection} not found`
        });
      }

      const item = await client.query<{ token_id: string }>("megadata.get_item", { collection: collectionId, token_id: tokenId });
      if (item) {
        return ok({ ...input, operation: "update_item" });
      }
      
      return ok({ ...input, operation: "create_item" });
    } else if (input.operation === "delete_item") {
      const deleteItemInput = input as DeleteItemInput;
      const { collection, tokenId } = deleteItemInput;
      const collectionId = hexToBuffer(collection);
      const client = await createClient({
        ...postchainConfig,
        directoryNodeUrlPool: this._directoryNodeUrlPool,
        blockchainRid: this._blockchainRid.toString('hex'),
      });

      const item = await client.query<{ token_id: string }>("megadata.get_item", { collection: collectionId, token_id: tokenId });
      if (!item) {
        return err({
          type: "validation_error",
          context: `Item ${tokenId} not found`
        });
      }
      return ok(input);
    }

    return err({
      type: "validation_error",
      context: `Unsupported operation: ${input.operation}`
    });
  }

  async process(input: ProcessInput<ManageMegadataInput>[]): Promise<Result<GTX, OracleError>> {
    logger.info(`Processing manage megadata`);
    const selectedData = input[0];
    if (!selectedData) {
      return err({ type: "process_error", context: "No input data" });
    }

    let tx = gtx.emptyGtx(this._blockchainRid);

    if (selectedData.data.operation === "create_collection") {
      tx = gtx.addTransactionToGtx("megadata.create_collection", [selectedData.data.auth.account], tx);
    } else if (selectedData.data.operation === "create_item") {
      const createItemInput = selectedData.data as UpsertItemInput;
      tx = gtx.addTransactionToGtx("megadata.create_item", [Buffer.from(createItemInput.collection, 'hex'), createItemInput.tokenId, JSON.stringify(createItemInput.properties)], tx);
    } else if (selectedData.data.operation === "update_item") {
      const updateItemInput = selectedData.data as UpsertItemInput;
      tx = gtx.addTransactionToGtx("megadata.update_item", [Buffer.from(updateItemInput.collection, 'hex'), updateItemInput.tokenId, JSON.stringify(updateItemInput.properties)], tx);
    } else if (selectedData.data.operation === "delete_item") {
      const deleteItemInput = selectedData.data as DeleteItemInput;
      tx = gtx.addTransactionToGtx("megadata.delete_item", [Buffer.from(deleteItemInput.collection, 'hex'), deleteItemInput.tokenId], tx);
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

  async execute(_gtx: GTX): Promise<Result<void, OracleError>> {
    logger.info(`Executing GTX for manage megadata`);
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

    return ok();
  }
}