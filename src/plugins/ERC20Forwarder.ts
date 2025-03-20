import type { Log } from "ethers";
import { Plugin } from "../core/plugin/Plugin";
import type { EventLog } from "ethers";
import { ChainConfirmationLevel, createClient, getDigestToSignFromRawGtxBody, gtx, type GTX, type RawGtxBody } from "postchain-client";
import type { ProcessInput } from "../core/types/Protocol";
import { logger } from "../util/monitoring";
import { JsonRpcProvider } from "ethers/providers";
import { dataSlice, ethers } from "ethers";
import { getAddress } from "ethers/address";
import { ecdsaSign } from "secp256k1";
import config from "../config";
import { hexToBuffer } from "../util/hex";
import { Throttler } from "../util/throttle";
import erc20Abi from "../util/abis/erc20";
import type { PluginError } from "../util/errors";
import { err, ok, Result } from "neverthrow";

export type ERC20ForwarderInput = {
  chain: string;
  event: Log | EventLog
}

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

export class ERC20Forwarder extends Plugin<ERC20ForwarderInput, ERC20Event, GTX, boolean> {
  static readonly pluginId = "erc20-forwarder";

  private readonly _directoryNodeUrlPool: string[];
  private readonly _blockchainRid: Buffer;

  constructor() {
    super({ id: ERC20Forwarder.pluginId });
    this._directoryNodeUrlPool = config.abstractionChain.directoryNodeUrlPool;
    this._blockchainRid = Buffer.from(config.abstractionChain.blockchainRid, 'hex');
  }

  async prepare(input: ERC20ForwarderInput): Promise<Result<ERC20Event, PluginError>> {
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

    // Verify transaction was included in a block
    if (!transaction.blockNumber) return err({ type: "prepare_error", context: `Transaction ${transactionHash} not included in a block` });

    // Get transaction receipt to access logs
    const receipt = await throttler.execute(() =>
      provider.getTransactionReceipt(transactionHash)
    );
    if (!receipt) return err({ type: "prepare_error", context: `Transaction ${transactionHash} receipt not found` });

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

    const amount = BigInt(matchingLog.data);
    const isMint = this.isZeroAddress(from);

    if (isMint) {
      const contract = new ethers.Contract(contractAddress, erc20Abi, provider);
      const [decimals, name, symbol] = await Promise.all([
        contract.decimals!(),
        contract.name!(),
        contract.symbol!()
      ]);

      return ok({
        chain: input.chain,
        blockNumber,
        transactionHash,
        logIndex,
        contractAddress,
        from,
        to,
        amount,
        isMint: true,
        decimals: Number(decimals),
        name,
        symbol
      });
    } else {
      return ok({
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

  async process(input: ProcessInput<ERC20Event>[]): Promise<Result<GTX, PluginError>> {
    const emptyGtx = gtx.emptyGtx(this._blockchainRid);
    const selectedInput = input[Math.floor(Math.random() * input.length)];
    if (!selectedInput) return err({ type: "process_error", context: `No input data received` });

    const eventId = `${selectedInput.data.transactionHash}-${selectedInput.data.logIndex}`;

    let tx: GTX;
    if (selectedInput.data.isMint) {
      // Here we can safely access decimals, name, and symbol because we know isMint is true
      const { decimals, name, symbol } = selectedInput.data;

      tx = gtx.addTransactionToGtx('evm.erc20.mint', [
        selectedInput.data.chain,
        selectedInput.data.blockNumber,
        hexToBuffer(selectedInput.data.contractAddress),
        eventId,
        hexToBuffer(selectedInput.data.to),
        selectedInput.data.amount,
        decimals,
        name,
        symbol
      ], emptyGtx);
    } else {
      tx = gtx.addTransactionToGtx('evm.erc20.transfer', [
        selectedInput.data.chain,
        selectedInput.data.blockNumber,
        hexToBuffer(selectedInput.data.contractAddress),
        eventId,
        hexToBuffer(selectedInput.data.from),
        hexToBuffer(selectedInput.data.to),
        selectedInput.data.amount
      ], emptyGtx);
    }

    tx.signers = input.map((i) => Buffer.from(i.pubkey, 'hex'));

    return ok(tx);
  }

  async validate(gtx: GTX, preparedData: ERC20Event): Promise<Result<GTX, PluginError>> {
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

  async execute(_gtx: GTX): Promise<Result<boolean, PluginError>> {
    logger.debug(`Executing GTX`);
    const client = await createClient({
      directoryNodeUrlPool: this._directoryNodeUrlPool,
      blockchainRid: this._blockchainRid.toString('hex')
    })

    try {
      await client.sendTransaction(gtx.serialize(_gtx), true, undefined, ChainConfirmationLevel.ClusterAnchoring);
      logger.info(`Executed successfully`);
    } catch (error: any) {
      // Check if this is a 409 error (Transaction already in database)
      if (error.status >= 400 && error.status !== 499) {
        logger.info(`Permanent error, marking as success`);
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

    // Try the preferred method first (getAddress with dataSlice)
    const primaryResult = Result.fromThrowable(
      () => getAddress(dataSlice(topic, 12)),
      (error): PluginError => ({ type: "execute_error", context: `Failed to parse address using primary method: ${error}` })
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
      (error): PluginError => ({ type: "execute_error", context: `Failed to parse address using fallback method: ${error}` })
    )();

    // Return the fallback result value or undefined if both methods failed
    return fallbackResult.isOk() ? fallbackResult.value : undefined;
  }

  private isZeroAddress(address: string): boolean {
    return address.toLowerCase() === '0x0000000000000000000000000000000000000000';
  }
}