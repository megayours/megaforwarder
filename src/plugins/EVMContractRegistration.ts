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

type EVMContractRegistrationInput = {
  auth: AccountSignature;
  chain: string;
  contract: string;
  blockNumber: number;
  collection: string;
  type: string;
}

export class EVMContractRegistration extends Plugin<EVMContractRegistrationInput, EVMContractRegistrationInput, GTX, void> {
  static readonly pluginId = "evm-contract-registration";

  private readonly _directoryNodeUrlPool: string[];
  private readonly _blockchainRid: Buffer;

  constructor() {
    super({ id: EVMContractRegistration.pluginId });

    this._directoryNodeUrlPool = config.abstractionChain.directoryNodeUrlPool as string[];
    this._blockchainRid = Buffer.from(config.abstractionChain.blockchainRid as string, "hex");
  }

  async prepare(input: EVMContractRegistrationInput): Promise<Result<EVMContractRegistrationInput, OracleError>> {
    const authResult = validateAuth(input.auth, `Asset Registration`);
    if (authResult.isErr()) {
      return err(authResult.error);
    }

    return ok(input);
  }

  async process(input: ProcessInput<EVMContractRegistrationInput>[]): Promise<Result<GTX, OracleError>> {
    logger.info(`Processing evm contract registration`);
    const selectedData = input[0];
    if (!selectedData) {
      return err({ type: "process_error", context: "No input data" });
    }

    const { data: contract } = selectedData;

    const emptyGtx = gtx.emptyGtx(this._blockchainRid);
    
    const tx = gtx.addTransactionToGtx("assets.register", [
      contract.chain,
      contract.contract,
      contract.blockNumber,
      contract.collection,
      contract.type
    ], emptyGtx);

    tx.signers = input.map((i) => Buffer.from(i.pubkey, "hex"));

    return ok(tx);
  }

  async validate(gtx: GTX, _: EVMContractRegistrationInput): Promise<Result<GTX, OracleError>> {
    const gtxBody = [gtx.blockchainRid, gtx.operations.map((op) => [op.opName, op.args]), gtx.signers] as RawGtxBody;
    const digest = getDigestToSignFromRawGtxBody(gtxBody);
    const signature = Buffer.from(ecdsaSign(digest, Buffer.from(config.privateKey, 'hex')).signature);

    if (gtx.signatures) {
      gtx.signatures.push(signature);
    } else {
      gtx.signatures = [signature];
    }

    logger.info(`Account linker validated successfully`);
    return ok(gtx);
  }

  async execute(_gtx: GTX): Promise<Result<void, OracleError>> {
    logger.info(`Executing GTX for account linker`);
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
      logger.info(`Account linker executed successfully with txRid: ${receipt.transactionRid.toString('hex')}`);
    } catch (error: any) {
      // Check if this is a 409 error (Transaction already in database)
      if (error.status === 409) {
        logger.info(`Transaction already in database, considering as success`);
      } else {
        // Log and return failure for any other error
        logger.error(`Failed to link accounts:`, error);
        return err({ type: "execute_error", context: `Error: ${error}` });
      }
    }

    return ok();
  }
}