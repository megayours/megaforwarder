import { err, ok, Result } from "neverthrow";
import { logger } from "./monitoring";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { ethers } from "ethers";
import config from "../config";
import type { OracleError } from "./errors";

export type AccountSignature = {
  type: "solana" | "evm";
  timestamp: number;
  account: string;
  signature: string;
}

const expectedMessage = (type: string,account: string, timestamp: number) => {
  return `MegaYours ${type}: ${account} at ${timestamp}`;
}

const validTimestamp = (timestamp: number, maxAge: number) => {
  logger.info(`Validating timestamp ${timestamp} with max age ${maxAge}`);
  const now = Date.now();
  const diff = now - timestamp;
  logger.info(`Diff: ${diff}`);
  return diff < maxAge;
}

export const validateAuth = (auth: AccountSignature, type: string): Result<void, OracleError> => {
  if (!auth) {
    return err({
      type: "validation_error",
      context: "Auth is required"
    });
  }

  if (!validTimestamp(auth.timestamp, config.auth.signatureMaxAgeMs)) {
    return err({
      type: "validation_error",
      context: `Signature timestamp too old for account ${auth.account}`
    });
  }

  const message = expectedMessage(type, auth.account, auth.timestamp);

  // Validate signature based on type
  if (auth.type === "solana") {
    try {
      // For Solana, verify using nacl (tweetnacl)
      const publicKey = new PublicKey(auth.account);
      const encodedMessage = new TextEncoder().encode(message);
      const signatureBytes = Buffer.from(auth.signature, 'base64');

      // Use nacl to verify the signature
      const isValid = nacl.sign.detached.verify(
        encodedMessage,
        signatureBytes,
        publicKey.toBytes()
      );

      if (!isValid) {
        return err({
          type: "validation_error",
          context: `Invalid Solana signature for account ${auth.account}`
        });
      }
    } catch (error) {
      return err({
        type: "validation_error",
        context: `Error validating Solana signature: ${error}`
      });
    }
  } else if (auth.type === "evm") {
    try {
      // For EVM, verify using ethers.js
      const signerAddress = ethers.verifyMessage(message, auth.signature);

      // Check if recovered address matches the claimed address
      if (signerAddress.toLowerCase() !== auth.account.toLowerCase()) {
        return err({
          type: "validation_error",
          context: `Invalid EVM signature for account ${auth.account}`
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
      context: `Unsupported signature type: ${auth.type}`
    });
  }

  return ok();
}