import type { Log, TransactionResponse } from "ethers";
import { Plugin } from "../core/plugin/Plugin";
import type { EventLog } from "ethers";
import { ChainConfirmationLevel, createClient, getDigestToSignFromRawGtxBody, gtx, type GTX, type RawGtxBody } from "postchain-client";
import type { ProcessInput } from "../core/types/Protocol";
import { logger, rpcCallsTotal, txProcessedTotal } from "../util/monitoring";
import { dataSlice, ethers } from "ethers";
import { getAddress } from "ethers/address";
import { ecdsaSign } from "secp256k1";
import config from "../config";
import { hexToBuffer } from "../util/hex";
import erc20Abi from "../util/abis/erc20";
import type { OracleError } from "../util/errors";
import { err, ok, Result, ResultAsync } from "neverthrow";
import { executeThrottled } from "../util/throttle";
import type { TransactionReceipt } from "ethers";
import { EVM_THROTTLE_LIMIT } from "../util/constants";
import { createRandomProvider } from "../util/create-provider";
import type { Rpc } from "../core/types/config/Rpc";
import { postchainConfig } from "../util/postchain-config";

// Define input for a single ERC20 event
export type ERC20ForwarderInput = {
  chain: string;
  event: Log | EventLog
}

// Update to allow an array of inputs as the plugin input type
export type BatchedERC20ForwarderInput = ERC20ForwarderInput[];

type ERC20Event = {
  chain: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
  contractAddress: string;
  from: string;
  to: string;
  amount: bigint;
  isMint: boolean;
} & (
    | { isMint: true; decimals: number; name: string; symbol: string }
    | { isMint: false; decimals?: undefined; name?: undefined; symbol?: undefined }
  );

export class ERC20Forwarder extends Plugin<BatchedERC20ForwarderInput, ERC20Event[], GTX, boolean> {
  static readonly pluginId = "erc20-forwarder";

  private readonly _directoryNodeUrlPool: string[];
  private readonly _blockchainRid: Buffer;

  constructor() {
    super({ id: ERC20Forwarder.pluginId });
    this._directoryNodeUrlPool = config.abstractionChain.directoryNodeUrlPool;
    this._blockchainRid = Buffer.from(config.abstractionChain.blockchainRid, 'hex');
  }

  // Update prepare to handle a batch of events
  async prepare(inputBatch: BatchedERC20ForwarderInput): Promise<Result<ERC20Event[], OracleError>> {
    if (inputBatch.length === 0) {
      return ok([]); // Return empty array if no inputs
    }

    const preparedEvents: ERC20Event[] = [];
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

      const amount = BigInt(matchingLog.data);
      const isMint = this.isZeroAddress(from);

      if (isMint) {
        const contract = new ethers.Contract(contractAddress, erc20Abi, provider);
        const [decimalsResult, nameResult, symbolResult] = await Promise.all([
          executeThrottled<number>(input.chain, () => contract.decimals!(), EVM_THROTTLE_LIMIT),
          executeThrottled<string>(input.chain, () => contract.name!(), EVM_THROTTLE_LIMIT),
          executeThrottled<string>(input.chain, () => contract.symbol!(), EVM_THROTTLE_LIMIT)
        ]);
        rpcCallsTotal.inc({ chain: input.chain, chain_code: contractAddress }, 3);

        if (decimalsResult.isErr()) {
          logger.error(`Failed to get decimals`, { error: decimalsResult.error });
          continue; // Skip this event but continue processing others
        }
        if (nameResult.isErr()) {
          logger.error(`Failed to get name`, { error: nameResult.error });
          continue; // Skip this event but continue processing others
        }
        if (symbolResult.isErr()) {
          logger.error(`Failed to get symbol`, { error: symbolResult.error });
          continue; // Skip this event but continue processing others
        }

        // Add successfully prepared mint event to the array
        preparedEvents.push({
          chain: input.chain,
          blockNumber,
          transactionHash,
          logIndex,
          contractAddress,
          from,
          to,
          amount,
          isMint: true,
          decimals: Number(decimalsResult.value),
          name: nameResult.value,
          symbol: symbolResult.value
        });
      } else {
        // Add successfully prepared transfer event to the array
        preparedEvents.push({
          chain: input.chain,
          blockNumber,
          transactionHash,
          logIndex,
          contractAddress,
          from,
          to,
          amount,
          isMint: false
        });
      }
    }

    const timeTaken = Date.now() - timestamp;
    if (timeTaken > 5000) {
      logger.warn(`ERC20Forwarder took ${timeTaken}ms to prepare ${preparedEvents.length}/${inputBatch.length} events`);
    }

    return ok(preparedEvents);
  }

  // Update process to handle multiple prepared events
  async process(inputs: ProcessInput<ERC20Event[]>[]): Promise<Result<GTX, OracleError>> {
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
      if (event.isMint) {
        // Here we can safely access decimals, name, and symbol because we know isMint is true
        const { decimals, name, symbol } = event;
        logger.info(`Processing ERC20 mint`, {
          eventId,
          contractAddress: event.contractAddress,
          amount: event.amount.toString(),
        });

        tx = gtx.addTransactionToGtx('evm.erc20.mint', [
          event.chain,
          event.blockNumber,
          hexToBuffer(event.contractAddress),
          eventId,
          hexToBuffer(event.to),
          event.amount,
          decimals,
          name,
          symbol
        ], tx);
        processedAny = true;
      } else {
        logger.info(`Processing ERC20 transfer`, {
          eventId,
          contractAddress: event.contractAddress,
          amount: event.amount.toString(),
        });

        tx = gtx.addTransactionToGtx('evm.erc20.transfer', [
          event.chain,
          event.blockNumber,
          hexToBuffer(event.contractAddress),
          eventId,
          hexToBuffer(event.from),
          hexToBuffer(event.to),
          event.amount
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

  async validate(gtx: GTX, preparedData: ERC20Event[]): Promise<Result<GTX, OracleError>> {
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
      txProcessedTotal.inc({ type: "erc20" }, _gtx.operations.length);
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

    // Try the preferred method first (getAddress with dataSlice)
    const primaryResult = Result.fromThrowable(
      () => getAddress(dataSlice(topic, 12)),
      (error): OracleError => ({ type: "execute_error", context: `Failed to parse address using primary method: ${error}` })
    )();

    // If successful, return the result
    if (primaryResult.isOk()) {
      return primaryResult.value;
    }

    // Log the issue
    logger.info(`Failed to parse address using primary method. Falling back to manual extraction.`);

    // Try fallback method if primary method fails
    const fallbackResult = Result.fromThrowable(
      () => ethers.getAddress('0x' + topic.slice(-40)),
      (error): OracleError => ({ type: "execute_error", context: `Failed to parse address using fallback method: ${error}` })
    )();

    // Return the fallback result value or undefined if both methods failed
    return fallbackResult.isOk() ? fallbackResult.value : undefined;
  }

  private isZeroAddress(address: string): boolean {
    return address.toLowerCase() === '0x0000000000000000000000000000000000000000';
  }
}