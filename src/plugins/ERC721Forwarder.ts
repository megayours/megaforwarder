import type { Log, TransactionResponse } from "ethers";
import { Plugin } from "../core/plugin/Plugin";
import type { EventLog } from "ethers";
import { ChainConfirmationLevel, createClient, getDigestToSignFromRawGtxBody, gtx, type GTX, type RawGtxBody } from "postchain-client";
import type { ProcessInput } from "../core/types/Protocol";
import { logger, rpcCallsTotal, txProcessedTotal } from "../util/monitoring";
import { JsonRpcProvider } from "ethers/providers";
import { Contract, dataSlice, ethers } from "ethers";
import { getAddress } from "ethers/address";
import { ecdsaSign } from "secp256k1";
import config from "../config";
import { hexToBuffer } from "../util/hex";
import erc721Abi from "../util/abis/erc721";
import { err, ok, ResultAsync, type Result } from "neverthrow";
import type { OracleError } from "../util/errors";
import { executeThrottled } from "../util/throttle";
import type { TransactionReceipt } from "ethers";
import { EVM_THROTTLE_LIMIT } from "../util/constants";
import { createRandomProvider } from "../util/create-provider";
import type { Rpc } from "../core/types/config/Rpc";
import { postchainConfig } from "../util/postchain-config";

// Define input for a single event
export type ERC721ForwarderInput = {
  chain: string;
  collection: string;
  event: Log | EventLog
}

// Update to allow array of inputs as the plugin input type
export type BatchedERC721ForwarderInput = ERC721ForwarderInput[];

type ERC721Event = {
  chain: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
  contractAddress: string;
  tokenId: bigint;
  from: string;
  to: string;
  metadata: string | undefined;
  tokenUri: string | undefined;
  collection: string | undefined;
}

export class ERC721Forwarder extends Plugin<BatchedERC721ForwarderInput, ERC721Event[], GTX, boolean> {
  static readonly pluginId = "erc721-forwarder";

  private readonly _directoryNodeUrlPool: string[];
  private readonly _blockchainRid: Buffer;

  constructor() {
    super({ id: ERC721Forwarder.pluginId });
    this._blockchainRid = Buffer.from(config.abstractionChain.blockchainRid, 'hex');
    this._directoryNodeUrlPool = config.abstractionChain.directoryNodeUrlPool;
  }

  // Update prepare to handle a batch of events
  async prepare(inputBatch: BatchedERC721ForwarderInput): Promise<Result<ERC721Event[], OracleError>> {
    if (inputBatch.length === 0) {
      return ok([]); // Return empty array if no inputs
    }

    const preparedEvents: ERC721Event[] = [];
    const timestamp = Date.now();

    // Process each event in the batch
    for (const input of inputBatch) {
      const { provider, token } = createRandomProvider(config.rpc[input.chain] as unknown as Rpc[]);

      // Validate input event was actually an event
      const contractAddress = input.event.address;
      const transactionHash = input.event.transactionHash;
      const blockNumber = input.event.blockNumber;
      const logIndex = input.event.index;

      // Check that transaction exists
      const transaction = await executeThrottled<TransactionResponse | null>(
        input.chain,
        () => provider.getTransaction(transactionHash),
        EVM_THROTTLE_LIMIT
      );
      rpcCallsTotal.inc({ chain: input.chain, chain_code: contractAddress, token });
      if (transaction.isErr()) {
        logger.error(`Transaction ${transactionHash} not found`, { error: transaction.error });
        continue; // Skip this event but continue processing others
      }

      // Verify transaction was included in a block
      if (transaction.value?.blockNumber === null) {
        logger.error(`Transaction ${transactionHash} not included in a block`);
        continue; // Skip this event but continue processing others
      }

      // Get transaction receipt to access logs
      const receipt = await executeThrottled<null | TransactionReceipt>(
        input.chain,
        () => provider.getTransactionReceipt(transactionHash),
        EVM_THROTTLE_LIMIT
      );
      rpcCallsTotal.inc({ chain: input.chain, chain_code: contractAddress, token });
      if (receipt.isErr()) {
        logger.error(`Transaction ${transactionHash} receipt not found`, { error: receipt.error });
        continue; // Skip this event but continue processing others
      }

      // Verify that the transaction was successful
      if (receipt.value?.status !== 1) {
        logger.error(`Transaction ${transactionHash} failed`);
        continue; // Skip this event but continue processing others
      }

      // Find the matching log in the receipt
      const matchingLog = receipt.value?.logs.find((log: Log) =>
        log.blockNumber === blockNumber &&
        log.index === logIndex &&
        log.address.toLowerCase() === contractAddress.toLowerCase()
      );

      if (!matchingLog) {
        logger.error(`Log not found in transaction ${transactionHash} at block ${blockNumber}`);
        continue; // Skip this event but continue processing others
      }

      // Additional verification: check that the topics/data match
      if (input.event.topics.length !== matchingLog.topics.length ||
        !input.event.topics.every((topic, i) => topic === matchingLog.topics[i]) ||
        input.event.data !== matchingLog.data) {
        logger.error(`Log does not match expected event`);
        continue; // Skip this event but continue processing others
      }

      const from = this.safelyExtractAddress(matchingLog.topics[1]);
      const to = this.safelyExtractAddress(matchingLog.topics[2]);

      if (!from || !to) {
        logger.error(`Invalid log topics`);
        continue; // Skip this event but continue processing others
      }

      const tokenIdString = matchingLog.topics[3];
      if (!tokenIdString) {
        logger.error(`Invalid log topics`);
        continue; // Skip this event but continue processing others
      }
      const tokenId = BigInt(tokenIdString);

      let tokenUri: string | undefined;
      let metadata: string | undefined;
      if (this.isZeroAddress(from)) {
        const contract = new Contract(contractAddress, erc721Abi, provider);
        if (!contract.tokenURI) {
          logger.error(`Token URI not found on contract`);
          continue; // Skip this event but continue processing others
        }

        const tokenUriResult = await executeThrottled<string>(
          input.chain,
          () => contract.tokenURI!(tokenId),
          EVM_THROTTLE_LIMIT
        );
        rpcCallsTotal.inc({ chain: input.chain, chain_code: contractAddress, token });

        if (tokenUriResult.isErr()) {
          logger.error(`Failed to get token URI`, { error: tokenUriResult.error });
          continue; // Skip this event but continue processing others
        }

        tokenUri = tokenUriResult.value;
        const preparedTokenUri = this.routeViaGateway(tokenUri!);
        const metadataTimestamp = Date.now();
        try {
          const response = await fetch(preparedTokenUri);
          const json = await response.json();
          const metadataTimeTaken = Date.now() - metadataTimestamp;
          if (metadataTimeTaken > 1000) {
            logger.warn(`ERC721Forwarder took ${metadataTimeTaken}ms to fetch metadata`, { preparedTokenUri });
          }
          metadata = JSON.stringify(json);
        } catch (error) {
          logger.error(`Failed to fetch metadata from ${preparedTokenUri}`, { error });
          // Even if metadata fetch fails, we can still process the event
          // Just leave metadata as undefined
        }
      }

      // Add successfully prepared event to the array
      preparedEvents.push({
        chain: input.chain,
        blockNumber,
        transactionHash,
        logIndex,
        contractAddress,
        tokenId,
        from,
        to,
        metadata,
        tokenUri,
        collection: input.collection
      });
    }

    const timeTaken = Date.now() - timestamp;
    if (timeTaken > 5000) {
      logger.warn(`ERC721Forwarder took ${timeTaken}ms to prepare ${preparedEvents.length}/${inputBatch.length} events`);
    }

    return ok(preparedEvents);
  }

  // Update process to handle multiple prepared events
  async process(inputs: ProcessInput<ERC721Event[]>[]): Promise<Result<GTX, OracleError>> {
    // Create an empty GTX
    const emptyGtx = gtx.emptyGtx(this._blockchainRid);
    
    // Use the first input from any peer
    const selectedInput = inputs[0];
    if (!selectedInput || selectedInput.data.length === 0) {
      return err({ type: "process_error", context: `No input data received` });
    }

    const client = await createClient({
      directoryNodeUrlPool: this._directoryNodeUrlPool,
      blockchainRid: this._blockchainRid.toString('hex')
    });

    // Initialize the transaction with our empty GTX
    let tx = emptyGtx;
    let processedAny = false;

    // For each prepared event in the batch
    for (const event of selectedInput.data) {
      const eventId = `${event.transactionHash}-${event.logIndex}`;

      // Check if this event was already processed to avoid duplicates
      const alreadyProcessed = await ResultAsync.fromPromise(client.query('evm.is_event_processed', {
        contract: Buffer.from(event.contractAddress.replace('0x', ''), 'hex'),
        event_id: eventId
      }), (error) => error);

      if (alreadyProcessed.isErr()) {
        logger.error(`Failed to check if event is already processed`, { eventId, error: alreadyProcessed.error });
        continue; // Skip this event but continue processing others
      }

      if (alreadyProcessed.value) {
        logger.info(`Event already processed, skipping`, { eventId });
        continue; // Skip this event but continue processing others
      }

      // Add the appropriate operation based on whether this is a mint or transfer
      if (event.metadata && event.tokenUri) {
        logger.info(`Processing ERC721 mint`, {
          eventId,
          contractAddress: event.contractAddress,
          tokenId: event.tokenId,
        });
        tx = gtx.addTransactionToGtx('evm.erc721.mint', [
          event.chain,
          event.blockNumber,
          hexToBuffer(event.contractAddress),
          eventId,
          event.tokenId,
          hexToBuffer(event.to),
          event.metadata,
          event.tokenUri,
          event.collection ?? null
        ], tx);
        processedAny = true;
      } else {
        logger.info(`Processing ERC721 transfer`, {
          eventId,
          contractAddress: event.contractAddress,
          tokenId: event.tokenId,
        });
        tx = gtx.addTransactionToGtx('evm.erc721.transfer', [
          event.chain,
          event.blockNumber,
          hexToBuffer(event.contractAddress),
          eventId,
          event.tokenId,
          hexToBuffer(event.from),
          hexToBuffer(event.to),
        ], tx);
        processedAny = true;
      }
    }

    // If we didn't process any events, return a non-error
    if (!processedAny) {
      return err({ type: "non_error", context: "All events in batch were already processed" });
    }

    // Set the signers from all inputs
    tx.signers = inputs.map((i) => Buffer.from(i.pubkey, 'hex'));

    return ok(tx);
  }

  async validate(gtx: GTX, preparedData: ERC721Event[]): Promise<Result<GTX, OracleError>> {
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
    logger.debug(`Executing GTX with ${_gtx.operations.length} operations`);
    const client = await createClient({
      ...postchainConfig,
      directoryNodeUrlPool: this._directoryNodeUrlPool,
      blockchainRid: this._blockchainRid.toString('hex')
    })

    try {
      await client.sendTransaction(gtx.serialize(_gtx), true, undefined, ChainConfirmationLevel.Dapp);
      logger.info(`Executed ${_gtx.operations.length} operations successfully`);
      // Increment the metric for each operation
      txProcessedTotal.inc({ type: "erc721" }, _gtx.operations.length);
    } catch (error: any) {
      // Check if this is a 409 error (Transaction already in database)
      if (error.status === 409) {
        logger.info(`Transaction already in database, considering as success`);
      } else {
        return err({ type: "execute_error", context: error?.message ?? "Unknown error" });
      }
    }

    return ok(true);
  }

  private safelyExtractAddress(topic: string | undefined): string | undefined {
    if (!topic) return undefined;

    try {
      // First, try to use ethers to parse the address
      return getAddress(dataSlice(topic, 12));
    } catch (error) {
      // If that fails, fall back to our original method
      logger.info(`Failed to parse address using ethers: ${error}. Falling back to manual extraction.`);
      return ethers.getAddress('0x' + topic.slice(-40));
    }
  }

  private routeViaGateway(tokenUri: string): string {
    return `https://router1.testnet.megayours.com/ext/${tokenUri}`;
  }

  private isZeroAddress(address: string): boolean {
    return address.toLowerCase() === '0x0000000000000000000000000000000000000000';
  }
}