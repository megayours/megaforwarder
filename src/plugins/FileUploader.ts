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
import { createHash } from "crypto";

type FileUploadInput = {
  auth: AccountSignature;
  data: Buffer;
  contentType: string;
};

type FileUploadOutput = {
  hash: string;
}

export class FileUploader extends Plugin<FileUploadInput, FileUploadInput, GTX, FileUploadOutput> {
  static readonly pluginId = "file-uploader";

  private readonly _directoryNodeUrlPool: string[];
  private readonly _blockchainRid: Buffer;

  constructor() {
    super({ id: FileUploader.pluginId });

    this._directoryNodeUrlPool = config.abstractionChain.directoryNodeUrlPool as string[];
    this._blockchainRid = Buffer.from(config.abstractionChain.blockchainRid as string, "hex");
  }

  async prepare(input: FileUploadInput): Promise<Result<FileUploadInput, OracleError>> {
    logger.info(`Preparing file upload`);
    const authResult = validateAuth(input.auth, `File Upload`);
    if (authResult.isErr()) {
      return err(authResult.error);
    }

    // Validate data size less than 10MB
    if (input.data.length > 10 * 1024 * 1024) {
      return err({ type: "prepare_error", context: "Data size must be less than 10MB" });
    }

    return ok(input);
  }

  async process(input: ProcessInput<FileUploadInput>[]): Promise<Result<GTX, OracleError>> {
    logger.info(`Processing file upload`);
    const selectedData = input[0];
    if (!selectedData) {
      return err({ type: "process_error", context: "No input data" });
    }

    // Ensure data is a Buffer
    const fileData = Buffer.isBuffer(selectedData.data.data) 
      ? selectedData.data.data 
      : Buffer.from(selectedData.data.data);

    let tx = gtx.emptyGtx(this._blockchainRid);
    tx = gtx.addTransactionToGtx("filestorage.store_file", [fileData, selectedData.data.contentType, selectedData.data.auth.account], tx);

    tx.signers = input.map((i) => Buffer.from(i.pubkey, "hex"));

    return ok(tx);
  }

  async validate(gtx: GTX, preparedData: FileUploadInput): Promise<Result<GTX, OracleError>> {
    const gtxBody = [gtx.blockchainRid, gtx.operations.map((op) => [op.opName, op.args]), gtx.signers] as RawGtxBody;
    const digest = getDigestToSignFromRawGtxBody(gtxBody);
    const signature = Buffer.from(ecdsaSign(digest, Buffer.from(config.privateKey, 'hex')).signature);

    if (gtx.signatures) {
      gtx.signatures.push(signature);
    } else {
      gtx.signatures = [signature];
    }

    logger.info(`File upload validated successfully`);
    return ok(gtx);
  }

  async execute(_gtx: GTX): Promise<Result<FileUploadOutput, OracleError>> {
    logger.info(`Executing GTX for file upload`);
    const operation = _gtx.operations[0];
    if (!operation || !operation.args || operation.args.length === 0) {
      return err({ type: "execute_error", context: "No operation data found" });
    }

    const data = operation.args[0];
    if (!data) {
      return err({ type: "execute_error", context: "Data is null or undefined" });
    }

    // Convert to Buffer if it's not already one
    let fileData: Buffer;
    if (Buffer.isBuffer(data)) {
      fileData = data;
    } else if (typeof data === 'string') {
      fileData = Buffer.from(data);
    } else if (Array.isArray(data)) {
      fileData = Buffer.from(data as number[]);
    } else {
      return err({ type: "execute_error", context: "Data is not in a format that can be converted to Buffer" });
    }
    
    logger.info(`File upload data: ${fileData.length} bytes, typeof: ${typeof fileData}, isBuffer: ${Buffer.isBuffer(fileData)}`);

    const sha256Hash = createHash('sha256').update(fileData).digest('hex');

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
      logger.info(`File upload executed successfully with txRid: ${receipt.transactionRid.toString('hex')}`);
    } catch (error: any) {
      // Check if this is a 409 error (Transaction already in database)
      if (error.status === 409) {
        logger.info(`Transaction already in database, considering as success`);
        return ok({ hash: sha256Hash });
      } else {
        // Log and return failure for any other error
        logger.error(`Failed to file upload:`, error);
        return err({ type: "execute_error", context: `Error: ${error}` });
      }
    }

    return ok({ hash: sha256Hash });
  }
}