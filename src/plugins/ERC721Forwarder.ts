import type { Log } from "ethers";
import { Plugin } from "../core/plugin/Plugin";
import type { EventLog } from "ethers";
import { ChainConfirmationLevel, createClient, getDigestToSignFromRawGtxBody, gtx, type GTX, type RawGtxBody } from "postchain-client";
import type { ProcessInput } from "../core/types/Protocol";
import { logger } from "../util/monitoring";
import { JsonRpcProvider } from "ethers/providers";
import { Contract, dataSlice, ethers } from "ethers";
import { getAddress } from "ethers/address";
import { ecdsaSign } from "secp256k1";
import config from "../config";
import { hexToBuffer } from "../util/hex";
import { Throttler } from "../util/throttle";
import erc721Abi from "../util/abis/erc721";
import { err, ok, ResultAsync, type Result } from "neverthrow";
import type { OracleError } from "../util/errors";

export type ERC721ForwarderInput = {
  chain: string;
  collection: string;
  event: Log | EventLog
}

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

export class ERC721Forwarder extends Plugin<ERC721ForwarderInput, ERC721Event, GTX, boolean> {
  static readonly pluginId = "erc721-forwarder";

  private readonly _directoryNodeUrlPool: string[];
  private readonly _blockchainRid: Buffer;

  constructor() {
    super({ id: ERC721Forwarder.pluginId });
    this._blockchainRid = Buffer.from(config.abstractionChain.blockchainRid, 'hex');
    this._directoryNodeUrlPool = config.abstractionChain.directoryNodeUrlPool;
  }

  async prepare(input: ERC721ForwarderInput): Promise<Result<ERC721Event, OracleError>> {
    const timestamp = Date.now();
    logger.info(`Preparing ERC721Forwarder`, { input });
    const rpcUrl = this.getRpcUrl(input.chain);
    const provider = new JsonRpcProvider(rpcUrl);
    const throttler = Throttler.getInstance(input.chain);

    // Validate input event was actually an event
    const contractAddress = input.event.address;
    const transactionHash = input.event.transactionHash;
    const blockNumber = input.event.blockNumber;
    const logIndex = input.event.index;

    // Check that transaction exists
    const transaction = await throttler.execute(() =>
      provider.getTransaction(transactionHash)
    );
    if (!transaction) return err({ type: "prepare_error", context: `Transaction ${transactionHash} not found` });

    logger.info(`Received transaction in ${Date.now() - timestamp}ms`, { input });
    // Verify transaction was included in a block
    if (!transaction.blockNumber) return err({ type: "prepare_error", context: `Transaction ${transactionHash} not included in a block` });

    // Get transaction receipt to access logs
    const receipt = await throttler.execute(() =>
      provider.getTransactionReceipt(transactionHash)
    );
    if (!receipt) return err({ type: "prepare_error", context: `Transaction ${transactionHash} receipt not found` });

    logger.info(`Received transaction receipt in ${Date.now() - timestamp}ms`, { input });
    // Verify that the transaction was successful
    if (receipt.status !== 1) return err({ type: "prepare_error", context: `Transaction ${transactionHash} failed` });

    // Find the matching log in the receipt
    const matchingLog = receipt.logs.find(log =>
      log.blockNumber === blockNumber &&
      log.index === logIndex &&
      log.address.toLowerCase() === contractAddress.toLowerCase()
    );

    if (!matchingLog) return err({ type: "prepare_error", context: `Log not found in transaction ${transactionHash} at block ${blockNumber}` });

    // Additional verification: check that the topics/data match
    if (input.event.topics.length !== matchingLog.topics.length ||
      !input.event.topics.every((topic, i) => topic === matchingLog.topics[i]) ||
      input.event.data !== matchingLog.data) {
      return err({ type: "prepare_error", context: `Log does not match expected event` });
    }

    const from = this.safelyExtractAddress(matchingLog.topics[1]);
    const to = this.safelyExtractAddress(matchingLog.topics[2]);

    if (!from || !to) return err({ type: "prepare_error", context: `Invalid log topics` });

    const tokenIdString = matchingLog.topics[3];
    if (!tokenIdString) return err({ type: "prepare_error", context: `Invalid log topics` });
    const tokenId = BigInt(tokenIdString);

    let tokenUri: string | undefined;
    let metadata: string | undefined;
    if (this.isZeroAddress(from)) {
      const contract = new Contract(contractAddress, erc721Abi, provider);
      if (!contract.tokenURI) return err({ type: "prepare_error", context: `Token URI not found on contract` });

      tokenUri = await throttler.execute(() => {
        // Ensure tokenURI exists before calling it
        if (typeof contract.tokenURI === 'function') {
          return contract.tokenURI(tokenId);
        }
        throw new Error('tokenURI function not found on contract');
      });
      logger.info(`Received token URI in ${Date.now() - timestamp}ms`, { input, tokenUri });
      const preparedTokenUri = this.routeViaGateway(tokenUri!);
      logger.debug(`Prepared token URI: ${preparedTokenUri}`);
      const response = await fetch(preparedTokenUri);
      const json = await response.json();
      metadata = JSON.stringify(json);
      logger.info(`Received metadata in ${Date.now() - timestamp}ms`, { input, metadata, tokenUri });
    }

    logger.info(`Received all data in ${Date.now() - timestamp}ms`, { input });

    return ok({
      chain: input.chain,
      blockNumber,
      transactionHash,
      logIndex,
      contractAddress,
      tokenId,
      from,
      to,
      metadata,
      tokenUri: tokenUri,
      collection: input.collection
    });
  }

  async process(input: ProcessInput<ERC721Event>[]): Promise<Result<GTX, OracleError>> {
    const emptyGtx = gtx.emptyGtx(this._blockchainRid);
    const selectedInput = input[Math.floor(Math.random() * input.length)];
    if (!selectedInput) return err({ type: "process_error", context: `No input data` });

    const eventId = `${selectedInput.data.transactionHash}-${selectedInput.data.logIndex}`;

    const client = await createClient({
      directoryNodeUrlPool: this._directoryNodeUrlPool,
      blockchainRid: this._blockchainRid.toString('hex')
    })

    const alreadyProcessed = await ResultAsync.fromPromise(client.query('evm.is_event_processed', {
      contract: Buffer.from(selectedInput.data.contractAddress.replace('0x', ''), 'hex'),
      event_id: eventId
    }), (error) => error);

    if (alreadyProcessed.isErr()) {
      return err({ type: "process_error", context: `Failed to check if event is already processed` });
    }

    if (alreadyProcessed.value) {
      return err({ type: "non_error", context: `Event already processed` });
    }

    let tx: GTX;
    if (selectedInput.data.metadata && selectedInput.data.tokenUri) {
      logger.info(`Processing ERC721 mint`, {
        eventId,
        contractAddress: selectedInput.data.contractAddress,
        tokenId: selectedInput.data.tokenId,
      });
      tx = gtx.addTransactionToGtx('evm.erc721.mint', [
        selectedInput.data.chain,
        selectedInput.data.blockNumber,
        hexToBuffer(selectedInput.data.contractAddress),
        eventId,
        selectedInput.data.tokenId,
        hexToBuffer(selectedInput.data.to),
        selectedInput.data.metadata,
        selectedInput.data.tokenUri,
        selectedInput.data.collection ?? null
      ], emptyGtx);
    } else {
      logger.info(`Processing ERC721 transfer`, {
        eventId,
        contractAddress: selectedInput.data.contractAddress,
        tokenId: selectedInput.data.tokenId,
      });
      tx = gtx.addTransactionToGtx('evm.erc721.transfer', [
        selectedInput.data.chain,
        selectedInput.data.blockNumber,
        hexToBuffer(selectedInput.data.contractAddress),
        eventId,
        selectedInput.data.tokenId,
        hexToBuffer(selectedInput.data.from),
        hexToBuffer(selectedInput.data.to),
      ], emptyGtx);
    }

    tx.signers = input.map((i) => Buffer.from(i.pubkey, 'hex'));

    return ok(tx);
  }

  async validate(gtx: GTX, preparedData: ERC721Event): Promise<Result<GTX, OracleError>> {
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
    logger.debug(`Executing GTX`);
    const client = await createClient({
      directoryNodeUrlPool: this._directoryNodeUrlPool,
      blockchainRid: this._blockchainRid.toString('hex')
    })

    try {
      await client.sendTransaction(gtx.serialize(_gtx));
      logger.info(`Executed successfully`);
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

  private getRpcUrl(chain: string) {
    const rpcs = config.rpc[chain];
    if (!rpcs) throw new Error(`No RPC Configuration found`);

    const rpcUrl = rpcs?.[Math.floor(Math.random() * rpcs.length)];
    if (!rpcUrl) throw new Error(`No RPC URL found for chain ${chain}`);

    logger.debug(`Selected RPC URL: ${rpcUrl}`);
    return rpcUrl;
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