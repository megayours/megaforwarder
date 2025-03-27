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
import { validateAuth } from "../util/auth";

type AccountSignature = {
  type: "solana" | "evm";
  timestamp: number;
  account: string;
  signature: string;
}

type AccountLinkerInput = {
  signatures: AccountSignature[];
};

export class AccountLinker extends Plugin<AccountLinkerInput, string[], GTX, void> {
  static readonly pluginId = "account-linker";

  private readonly _directoryNodeUrlPool: string[];
  private readonly _blockchainRid: Buffer;

  constructor() {
    super({ id: AccountLinker.pluginId });

    this._directoryNodeUrlPool = config.abstractionChain.directoryNodeUrlPool as string[];
    this._blockchainRid = Buffer.from(config.abstractionChain.blockchainRid as string, "hex");
  }

  async prepare(input: AccountLinkerInput): Promise<Result<string[], OracleError>> {
    logger.info(`Preparing account linker with ${input.signatures.length} signatures`);

    // Ensure at least two signatures are provided
    if (input.signatures.length < 2) {
      return err({
        type: "validation_error",
        context: "At least two signatures are required"
      });
    }

    for (const signature of input.signatures) {
      const authResult = validateAuth(signature, `Account Linker`);
      if (authResult.isErr()) {
        return err(authResult.error);
      }
    }

    logger.info(`Account linker prepared successfully`);
    return ok(input.signatures.map((s) => s.account));
  }

  async process(input: ProcessInput<string[]>[]): Promise<Result<GTX, OracleError>> {
    logger.info(`Processing account linker`);
    const selectedData = input[0];
    if (!selectedData) {
      return err({ type: "process_error", context: "No input data" });
    }

    const { data: accounts } = selectedData;

    const emptyGtx = gtx.emptyGtx(this._blockchainRid);

    let tx = emptyGtx;
    const baseAccount = accounts[0];
    if (!baseAccount) return err({ type: "process_error", context: "No base account" });

    for (let i = 1; i < accounts.length; i++) {
      const account = accounts[i];
      if (!account) return err({ type: "process_error", context: "No account" });

      tx = gtx.addTransactionToGtx("account_links.link_accounts", [baseAccount, account], tx);
    }

    tx = gtx.addTransactionToGtx("nop", [Math.floor(Math.random() * 1000000)], tx);
    tx.signers = input.map((i) => Buffer.from(i.pubkey, "hex"));

    return ok(tx);
  }

  async validate(gtx: GTX, preparedData: string[]): Promise<Result<GTX, OracleError>> {
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