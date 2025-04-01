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
import { validateAuth, type AccountSignature } from "../util/auth";

type AssetRegistrationInput = {
  auth: AccountSignature;
  source: string;
  asset: string;
  unit: number;
  name: string;
  type: string;
}

export class AssetRegistration extends Plugin<AssetRegistrationInput, AssetRegistrationInput, GTX, void> {
  static readonly pluginId = "asset-registration";

  private readonly _directoryNodeUrlPool: string[];
  private readonly _blockchainRid: Buffer;

  constructor() {
    super({ id: AssetRegistration.pluginId });

    this._directoryNodeUrlPool = config.abstractionChain.directoryNodeUrlPool as string[];
    this._blockchainRid = Buffer.from(config.abstractionChain.blockchainRid as string, "hex");
  }

  async prepare(input: AssetRegistrationInput): Promise<Result<AssetRegistrationInput, OracleError>> {
    const authResult = validateAuth(input.auth, `Asset Registration`);
    if (authResult.isErr()) {
      return err(authResult.error);
    }

    // Validate has a RPC for the source
    const rpcs = config.rpc;
    if (!rpcs[input.source]) {
      return err({ type: "bad_input", context: `Source ${input.source} not found in config` });
    }

    // Validate the source and type combination
    switch (input.type.toLowerCase()) {
      case "erc20":
      case "erc721":
        if (input.source !== "ethereum" && input.source !== "polygon" && input.source !== "bsc_testnet") {
          return err({ type: "bad_input", context: `Unsupported source and type combination: ${input.source} and ${input.type}` });
        }
        break;
      case "spl":
        if (input.source !== "solana") {
          return err({ type: "bad_input", context: `Unsupported source and type combination: ${input.source} and ${input.type}` });
        }
        break;
      default:
        return err({ type: "bad_input", context: `Unsupported asset type: ${input.type}` });
    }

    return ok(input);
  }

  async process(input: ProcessInput<AssetRegistrationInput>[]): Promise<Result<GTX, OracleError>> {
    logger.info(`Processing asset registration`);
    const selectedData = input[0];
    if (!selectedData) {
      return err({ type: "process_error", context: "No input data" });
    }

    const { data: contract } = selectedData;

    const emptyGtx = gtx.emptyGtx(this._blockchainRid);
    
    const tx = gtx.addTransactionToGtx("assets.register", [
      contract.source,
      contract.asset,
      contract.unit,
      contract.name,
      contract.type.toLowerCase()
    ], emptyGtx);

    tx.signers = input.map((i) => Buffer.from(i.pubkey, "hex"));

    return ok(tx);
  }

  async validate(gtx: GTX, _: AssetRegistrationInput): Promise<Result<GTX, OracleError>> {
    const gtxBody = [gtx.blockchainRid, gtx.operations.map((op) => [op.opName, op.args]), gtx.signers] as RawGtxBody;
    const digest = getDigestToSignFromRawGtxBody(gtxBody);
    const signature = Buffer.from(ecdsaSign(digest, Buffer.from(config.privateKey, 'hex')).signature);

    if (gtx.signatures) {
      gtx.signatures.push(signature);
    } else {
      gtx.signatures = [signature];
    }

    logger.info(`Asset registration validated successfully`);
    return ok(gtx);
  }

  async execute(_gtx: GTX): Promise<Result<void, OracleError>> {
    logger.info(`Executing GTX for asset registration`);
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
      logger.info(`Asset registration executed successfully with txRid: ${receipt.transactionRid.toString('hex')}`);
    } catch (error: any) {
      // Check if this is a 409 error (Transaction already in database)
      if (error.status === 409) {
        logger.info(`Transaction already in database, considering as success`);
      } else {
        // Log and return failure for any other error
        logger.error(`Failed to register asset:`, error);
        return err({ type: "execute_error", context: `Error: ${error}` });
      }
    }

    return ok();
  }
}