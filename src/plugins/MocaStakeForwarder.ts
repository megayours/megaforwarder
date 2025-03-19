import type { Log } from "ethers";
import { Plugin } from "../core/plugin/Plugin";
import type { EventLog } from "ethers";
import { createClient, getDigestToSignFromRawGtxBody, gtx, type GTX, type RawGtxBody } from "postchain-client";
import type { ExecuteResult, PrepareResult, ProcessInput, ProcessResult, ValidateResult } from "../core/types/Protocol";
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

  async prepare(input: MocaStakeForwarderInput): Promise<PrepareResult<StakingEvent[]>> {
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
    if (!transaction) return { status: "failure" };

    // Verify transaction was included in a block
    if (!transaction.blockNumber) return { status: "failure" };

    // Get transaction receipt to access logs
    const receipt = await throttler.execute(() => 
      provider.getTransactionReceipt(transactionHash)
    );
    if (!receipt) return { status: "failure" };

    // Verify that the transaction was successful
    if (receipt.status !== 1) return { status: "failure" };

    // Find the matching log in the receipt
    const matchingLog = receipt.logs.find(log =>
      log.blockNumber === blockNumber &&
      log.index === logIndex &&
      log.address.toLowerCase() === contractAddress.toLowerCase()
    );

    if (!matchingLog) return { status: "failure" };

    // Additional verification: check that the topics/data match
    if (input.event.topics.length !== matchingLog.topics.length ||
      !input.event.topics.every((topic, i) => topic === matchingLog.topics[i]) ||
      input.event.data !== matchingLog.data) {
      return { status: "failure" };
    }

    logger.info(`Verified event from transaction ${transactionHash} at block ${blockNumber}`);

    if (input.eventName === "Staked") {
      return this.handleStaked(input);
    } else if (input.eventName === "StakedBehalf") {
      return this.handleStakedBehalf(input, transaction);
    } else if (input.eventName === "Unstaked") {
      return this.handleUnstaked(input);
    }

    return { status: "failure" };
  }

  private handleStaked(input: MocaStakeForwarderInput): PrepareResult<StakingEvent[]> {
    const from = this.safelyExtractAddress(input.event.topics[1]);
    if (!from) return { status: "failure" };

    const amount = BigInt(input.event.data);

    return {
      status: "success",
      data: [{
        chain: input.chain,
        blockNumber: input.event.blockNumber,
        transactionHash: input.event.transactionHash,
        logIndex: input.event.index,
        contractAddress: input.event.address,
        from,
        amount,
        type: "staked"
      }]
    }
  }

  private handleStakedBehalf(input: MocaStakeForwarderInput, tx: TransactionResponse): PrepareResult<StakingEvent[]> {
    const iface = new Interface([
      'function stakeBehalf(address[] calldata users, uint256[] calldata amounts)'
    ]);

    const decodedInput = iface.parseTransaction({ data: tx.data, value: tx.value });
    if (!decodedInput || !decodedInput.args) return { status: "failure" };

    const users = decodedInput.args[0] || [];
    const amounts = decodedInput.args[1] || [];

    console.log(`Decoded ${users.length} users and ${amounts.length} amounts from transaction input`);

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

    return {
      status: "success",
      data: events
    }
  }

  private handleUnstaked(input: MocaStakeForwarderInput): PrepareResult<StakingEvent[]> {
    const from = this.safelyExtractAddress(input.event.topics[1]);
    if (!from) return { status: "failure" };

    const amount = BigInt(input.event.data);
    
    return {
      status: "success",
      data: [{
        chain: input.chain,
        blockNumber: input.event.blockNumber,
        transactionHash: input.event.transactionHash,
        logIndex: input.event.index,
        contractAddress: input.event.address,
        from,
        amount,
        type: "unstaked"
      }]
    }
  }

  async process(input: ProcessInput<StakingEvent[]>[]): Promise<ProcessResult<GTX>> {
    const emptyGtx = gtx.emptyGtx(this._blockchainRid);
    const selectedInput = input[Math.floor(Math.random() * input.length)];
    if (!selectedInput) throw new Error(`No input data`);

    let tx: GTX = emptyGtx;
    for (const event of selectedInput.data) {
      const eventId = `${event.transactionHash}-${event.logIndex}`;
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

    tx.signers = input.map((i) => Buffer.from(i.pubkey, 'hex'));
    
    return {
      status: "success",
      data: tx
    };
  }

  async validate(gtx: GTX, preparedData: StakingEvent[]): Promise<ValidateResult<GTX>> {
    const gtxBody = [gtx.blockchainRid, gtx.operations.map((op) => [op.opName, op.args]), gtx.signers] as RawGtxBody;
    const digest = getDigestToSignFromRawGtxBody(gtxBody);
    const signature = Buffer.from(ecdsaSign(digest, Buffer.from(config.privateKey, 'hex')).signature);

    if (gtx.signatures) {
      gtx.signatures.push(signature);
    } else {
      gtx.signatures = [signature];
    }

    return {
      status: "success",
      data: gtx
    };
  }

  async execute(_gtx: GTX): Promise<ExecuteResult<boolean>> {
    logger.info(`Executing GTX`);
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
        // Re-throw any other error
        throw error;
      }
    }
    
    return { status: "success", data: true };
  }

  private getRpcUrl(chain: string) {
    const rpcs = config.rpc[chain];
    if (!rpcs) throw new Error(`No RPC Configuration found`);

    const rpcUrl = rpcs?.[Math.floor(Math.random() * rpcs.length)];
    if (!rpcUrl) throw new Error(`No RPC URL found for chain ${chain}`);

    logger.info(`Selected RPC URL: ${rpcUrl}`);
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
}