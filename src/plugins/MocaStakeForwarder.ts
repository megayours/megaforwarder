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
import { Interface } from "ethers";
import type { TransactionResponse } from "ethers";
import { Throttler } from "../util/throttle";
import { err, ok, Result, ResultAsync } from "neverthrow";
import type { OracleError } from "../util/errors";

export type MocaStakeForwarderInput = {
  chain: string;
  eventName: string;
  event: Log | EventLog
}

type StakingEvent = {
  chain: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
  contractAddress: string;
  type: "staked" | "staked_behalf" | "unstaked";
  from: string;
  amount: bigint;
}

export class MocaStakeForwarder extends Plugin<MocaStakeForwarderInput, StakingEvent[], GTX, boolean> {
  static readonly pluginId = "moca-stake-forwarder";

  private readonly _directoryNodeUrlPool: string[];
  private readonly _blockchainRid: Buffer;

  constructor() {
    super({ id: MocaStakeForwarder.pluginId });
    this._blockchainRid = Buffer.from(config.abstractionChain.blockchainRid, 'hex');
    this._directoryNodeUrlPool = config.abstractionChain.directoryNodeUrlPool;
  }

  async prepare(input: MocaStakeForwarderInput): Promise<Result<StakingEvent[], OracleError>> {
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

    if (input.eventName === "Staked") {
      return this.handleStaked(input);
    } else if (input.eventName === "StakedBehalf") {
      return this.handleStakedBehalf(input, transaction);
    } else if (input.eventName === "Unstaked") {
      return this.handleUnstaked(input);
    }

    return err({ type: "prepare_error", context: `Invalid event name: ${input.eventName}` });
  }

  private handleStaked(input: MocaStakeForwarderInput): Result<StakingEvent[], OracleError> {
    const from = this.safelyExtractAddress(input.event.topics[1]);
    if (!from) return err({ type: "prepare_error", context: `Invalid log topics` });

    const amount = BigInt(input.event.data);

    return ok([{
      chain: input.chain,
      blockNumber: input.event.blockNumber,
      transactionHash: input.event.transactionHash,
      logIndex: input.event.index,
      contractAddress: input.event.address,
      from,
      amount,
      type: "staked"
    }]);
  }

  private handleStakedBehalf(input: MocaStakeForwarderInput, tx: TransactionResponse): Result<StakingEvent[], OracleError> {
    const iface = new Interface([
      'function stakeBehalf(address[] calldata users, uint256[] calldata amounts)'
    ]);

    const decodedInput = iface.parseTransaction({ data: tx.data, value: tx.value });
    if (!decodedInput || !decodedInput.args) return err({ type: "prepare_error", context: `Invalid transaction input` });

    const users = decodedInput.args[0] || [];
    const amounts = decodedInput.args[1] || [];

    logger.info(`Decoded ${users.length} users and ${amounts.length} amounts from transaction input`);

    const events: StakingEvent[] = [];
    // Process each user with their corresponding amount
    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      const amount = amounts[i];

      if (amount > 0) {
        events.push({
          chain: input.chain,
          blockNumber: input.event.blockNumber,
          transactionHash: input.event.transactionHash,
          logIndex: input.event.index,
          contractAddress: input.event.address,
          from: user,
          amount,
          type: "staked_behalf"
        })
      }
    }

    return ok(events);
  }

  private handleUnstaked(input: MocaStakeForwarderInput): Result<StakingEvent[], OracleError> {
    const from = this.safelyExtractAddress(input.event.topics[1]);
    if (!from) return err({ type: "prepare_error", context: `Invalid log topics` });

    const amount = BigInt(input.event.data);

    return ok([{
      chain: input.chain,
      blockNumber: input.event.blockNumber,
      transactionHash: input.event.transactionHash,
      logIndex: input.event.index,
      contractAddress: input.event.address,
      from,
      amount,
      type: "unstaked"
    }]);
  }

  async process(input: ProcessInput<StakingEvent[]>[]): Promise<Result<GTX, OracleError>> {
    const emptyGtx = gtx.emptyGtx(this._blockchainRid);
    const selectedInput = input[Math.floor(Math.random() * input.length)];
    if (!selectedInput) return err({ type: "process_error", context: `No input data` });

    const client = await createClient({
      directoryNodeUrlPool: this._directoryNodeUrlPool,
      blockchainRid: this._blockchainRid.toString('hex')
    })

    let tx: GTX = emptyGtx;
    let i = 0;
    for (const event of selectedInput.data) {
      const eventId = `${event.transactionHash}-${event.logIndex}-${i++}`;

      const alreadyProcessed = await ResultAsync.fromPromise(client.query('evm.is_event_processed', {
        contract: Buffer.from(event.contractAddress.replace('0x', ''), 'hex'),
        event_id: eventId
      }), (error) => error);
      
      if (alreadyProcessed.isErr()) {
        return err({ type: "process_error", context: `Failed to check if event is already processed` });
      }

      if (alreadyProcessed.value) {
        continue
      }

      if (event.type === "staked" || event.type === "staked_behalf") {
        tx = gtx.addTransactionToGtx('evm.erc20.mint', [
          event.chain,
          event.blockNumber,
          hexToBuffer(event.contractAddress),
          eventId,
          hexToBuffer(event.from),
          event.amount,
          18,
          "Moca Stake",
          "MOCASTAKE"
        ], tx);
      } else if (event.type === "unstaked") {
        tx = gtx.addTransactionToGtx('evm.erc20.destroy', [
          event.chain,
          event.blockNumber,
          hexToBuffer(event.contractAddress),
          eventId,
          hexToBuffer(event.from),
          event.amount
        ], tx);
      }
    }

    if (tx.operations.length === 0) {
      return err({ type: "non_error", context: `No transactions to execute` });
    }

    tx.signers = input.map((i) => Buffer.from(i.pubkey, 'hex'));

    return ok(tx);
  }

  async validate(gtx: GTX, preparedData: StakingEvent[]): Promise<Result<GTX, OracleError>> {
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

    const result = Result.fromThrowable(
      () => getAddress(dataSlice(topic, 12)),
      (error): OracleError => ({ type: "execute_error", context: `Failed to parse address using primary method: ${error}` })
    )();

    if (result.isOk()) {
      return result.value;
    }

    // If that fails, fall back to our original method
    logger.info(`Failed to parse address using ethers: ${result.error}. Falling back to manual extraction.`);
    return ethers.getAddress('0x' + topic.slice(-40));
  }
}