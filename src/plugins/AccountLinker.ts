import { ChainConfirmationLevel, createClient, getDigestToSignFromRawGtxBody, gtx, type GTX, type RawGtxBody } from "postchain-client";
import { Plugin } from "../core/plugin/Plugin";
import type { Result } from "neverthrow";
import { ok, err } from "neverthrow";
import type { OracleError } from "../util/errors";
import type { ProcessInput } from "../core/types/Protocol";
import { PublicKey } from "@solana/web3.js";
import { ethers } from "ethers";
import nacl from "tweetnacl";
import { ecdsaSign } from "secp256k1";
import config from "../config";
import { logger } from "../util/monitoring";

type AccountSignature = {
  type: "solana" | "evm";
  timestamp: number;
  account: string;
  signature: string;
}

type AccountLinkerInput = {
  signatures: AccountSignature[];
};

const expectedMessage = (account: string, timestamp: number) => {
  return `MegaYours Account Linker: ${account} at ${timestamp}`;
}

const validTimestamp = (timestamp: number, maxAge: number) => {
  const now = Date.now();
  const diff = now - timestamp;
  return diff < maxAge;
}

export class AccountLinker extends Plugin<AccountLinkerInput, string[], GTX, void> {
  static readonly pluginId = "account-linker";

  private readonly _directoryNodeUrlPool: string[];
  private readonly _blockchainRid: Buffer;
  private readonly _signatureMaxAgeMs: number;

  constructor() {
    super({ id: AccountLinker.pluginId });

    this._directoryNodeUrlPool = this.config.directoryNodeUrlPool as string[];
    this._blockchainRid = Buffer.from(this.config.blockchainRid as string, "hex");
    this._signatureMaxAgeMs = this.config.signatureMaxAgeMs as number;
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
      // Validate timestamp
      if (!validTimestamp(signature.timestamp, this._signatureMaxAgeMs)) {
        return err({
          type: "validation_error",
          context: `Signature timestamp too old for account ${signature.account}`
        });
      }

      // Generate expected message
      const message = expectedMessage(signature.account, signature.timestamp);

      // Validate signature based on type
      if (signature.type === "solana") {
        try {
          // For Solana, verify using nacl (tweetnacl)
          const publicKey = new PublicKey(signature.account);
          const encodedMessage = new TextEncoder().encode(message);
          const signatureBytes = Buffer.from(signature.signature, 'base64');

          // Use nacl to verify the signature
          const isValid = nacl.sign.detached.verify(
            encodedMessage,
            signatureBytes,
            publicKey.toBytes()
          );

          if (!isValid) {
            return err({
              type: "validation_error",
              context: `Invalid Solana signature for account ${signature.account}`
            });
          }
        } catch (error) {
          return err({
            type: "validation_error",
            context: `Error validating Solana signature: ${error}`
          });
        }
      } else if (signature.type === "evm") {
        try {
          // For EVM, verify using ethers.js
          const signerAddress = ethers.verifyMessage(message, signature.signature);

          // Check if recovered address matches the claimed address
          if (signerAddress.toLowerCase() !== signature.account.toLowerCase()) {
            return err({
              type: "validation_error",
              context: `Invalid EVM signature for account ${signature.account}`
            });
          }
        } catch (error) {
          return err({
            type: "validation_error",
            context: `Error validating EVM signature: ${error}`
          });
        }
      } else {
        return err({
          type: "validation_error",
          context: `Unsupported signature type: ${signature.type}`
        });
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

      tx = gtx.addTransactionToGtx("reputation.link_accounts", [baseAccount, account], tx);
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
      directoryNodeUrlPool: this._directoryNodeUrlPool,
      blockchainRid: this._blockchainRid.toString('hex')
    });

    try {
      await client.sendTransaction(gtx.serialize(_gtx), true, undefined, ChainConfirmationLevel.Dapp);
      logger.info(`Account linker executed successfully`);
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