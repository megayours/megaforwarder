import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import type { PrepareResult, ProcessInput, ProcessResult, ValidateResult } from "../core/types/Protocol";
import { createClient, getDigestToSignFromRawGtxBody, gtx, type GTX, type RawGtxBody } from "postchain-client";
import config from "../config";
import { ecdsaSign } from "secp256k1";
import { Plugin } from "../core/plugin/Plugin";
import { getMint } from "@solana/spl-token";
import { logger } from "../util/monitoring";

// Metaplex Token Metadata Program ID
const TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

type SolanaMegaForwarderInput = {
  txSignature: string;
}

type MintData = {
  slot: number;
  txSignature: string;
  tokenAddress: string;
  decimals: number;
  amount: string;
  metadata: {
    name: string;
    symbol: string;
    uri: string;
  };
}

type SolanaMegaForwarderOutput = {
  status: "success" | "failure";
}

export class SolanaMinter extends Plugin<SolanaMegaForwarderInput, MintData, GTX, SolanaMegaForwarderOutput> {
  static readonly pluginId = "solana-minter";
  protected readonly _connection: Connection;
  protected readonly _programId: string;
  private readonly _directoryNodeUrlPool: string[];
  private readonly _nodeUrlPool: string[];
  private readonly _megadataBlockchainRid: Buffer;

  constructor() {
    super({ id: SolanaMinter.pluginId });

    this._connection = new Connection(this.config["solanaRpcUrl"] as string, "confirmed");
    this._programId = this.config["solanaProgramId"] as string;
    this._directoryNodeUrlPool = (this.config["directoryNodeUrlPool"] as string)?.split(',') ?? [];
    this._nodeUrlPool = (this.config["nodeUrlPool"] as string)?.split(',') ?? [];
    this._megadataBlockchainRid = Buffer.from((this.config["blockchainRid"] as string), "hex");
  }

  private async getTokenMetadata(mintAddress: string): Promise<{ metadata: { name: string, symbol: string, uri: string }, decimals: number }> {
    try {
      logger.debug(`Getting token metadata`, { mintAddress });
      const mintPubkey = new PublicKey(mintAddress);
      
      // Get token decimals from mint account
      const mintInfo = await getMint(this._connection, mintPubkey);
      const decimals = mintInfo.decimals;

      // Get token metadata
      const [metadataPDA] = PublicKey.findProgramAddressSync(
        [
          Buffer.from('metadata'),
          TOKEN_METADATA_PROGRAM_ID.toBuffer(),
          mintPubkey.toBuffer()
        ],
        TOKEN_METADATA_PROGRAM_ID
      );

      logger.debug(`Metadata PDA`, { metadataPDA: metadataPDA.toBase58() });

      const metadataAccount = await this._connection.getAccountInfo(metadataPDA);
      if (!metadataAccount) {
        throw new Error('Metadata account not found');
      }

      // Parse metadata manually
      const data = metadataAccount.data;

      // Metadata structure:
      // 1 byte: Key (1)
      // 32 bytes: Update authority
      // 32 bytes: Mint
      // Variable: Name
      // Variable: Symbol
      // Variable: URI
      let offset = 1 + 32 + 32; // Skip key, update authority, and mint

      // Helper function to read string
      const readString = () => {
        const length = data.readUInt32LE(offset);
        offset += 4;
        const str = data.slice(offset, offset + length).toString('utf8').replace(/\0/g, '');
        offset += length;
        return str;
      };

      const metadata = {
        name: readString(),
        symbol: readString(),
        uri: readString()
      };

      logger.debug(`Parsed metadata`, { metadata });
      
      return {
        metadata,
        decimals
      };
    } catch (error) {
      logger.error('Error fetching token metadata', { error });
      throw error;
    }
  }

  async prepare(input: SolanaMegaForwarderInput): Promise<PrepareResult<MintData>> {
    logger.debug(`Preparing transaction`, { txSignature: input.txSignature });
    const transaction = await this._connection.getTransaction(input.txSignature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });

    logger.debug(`Transaction`, { transaction });

    if (!transaction) {
      return { status: "failure" }
    }

    const logs = transaction.meta?.logMessages;

    if (!logs) {
      return { status: "failure" }
    }

    const event = logs.find((log) => log.includes('MEGADATA:'));
    logger.debug(`Event`, { event });

    if (!event) {
      return { status: "failure" }
    }

    // Extract the base58 encoded data
    const base58Data = event.split('MEGADATA:')?.[1]?.trim();
    if (!base58Data) {
      return { status: "failure" }
    }
    
    // Decode from base58
    const binaryData = bs58.decode(base58Data);

    // Create a buffer reader for manual deserialization
    const buffer = Buffer.from(binaryData);
    let offset = 0;

    // Read operation string
    const addressLength = buffer.readUInt32LE(offset);
    offset += 4;
    const address = buffer.toString('utf8', offset, offset + addressLength);
    offset += addressLength;

    // Read args array
    const modulesLength = buffer.readUInt32LE(offset);
    offset += 4;
    const modules = [];

    for (let i = 0; i < modulesLength; i++) {
      const moduleLength = buffer.readUInt32LE(offset);
      offset += 4;
      const module = buffer.toString('utf8', offset, offset + moduleLength);
      offset += moduleLength;
      modules.push(module);
    }

    logger.debug(`Address`, { address });
    logger.debug(`Modules`, { modules });

    if (!address) {
      return { status: "failure" };
    }

    try {
      const { metadata, decimals } = await this.getTokenMetadata(address);
      return { 
        status: "success", 
        data: { 
          slot: transaction.slot,
          txSignature: input.txSignature,
          tokenAddress: address, 
          decimals, 
          metadata,
          amount: "0"  // Default to 0 if amount not provided
        } 
      };
    } catch (error) {
      console.error('Error in prepare:', error);
      return { status: "failure" };
    }
  }

  async process(input: ProcessInput<MintData>[]): Promise<ProcessResult<GTX>> {
    logger.debug(`Processing input`, { input });
    const selectedData = input[0];
    if (!selectedData) return { status: "failure" };
    const { slot, txSignature, tokenAddress, decimals, metadata, amount }: MintData = selectedData.data;
    logger.debug(`Metadata`, { metadata, amount });

    const emptyGtx = gtx.emptyGtx(this._megadataBlockchainRid);
    // Adding empty array to args to make it a valid RawGtxBody with no properties since we don't receive it yet
    const tx = gtx.addTransactionToGtx("solana.register_token", [slot, txSignature, tokenAddress, decimals, "{}"], emptyGtx);
    tx.signers = input.map((i) => Buffer.from(i.pubkey, 'hex'));
    return { status: "success", data: tx };
  }

  async validate(gtx: GTX, preparedData: MintData): Promise<ValidateResult<GTX>> {
    if (gtx.operations.length !== 1) return { status: "failure" };
    if (gtx.operations[0]?.opName !== "solana.register_token") return { status: "failure" };
    if (gtx.operations[0]?.args.length !== 5) return { status: "failure" };

    const [slot, txSignature, tokenAddress, decimals] = gtx.operations[0].args;
    if (slot !== preparedData.slot) return { status: "failure" };
    if (txSignature !== preparedData.txSignature) return { status: "failure" };
    if (tokenAddress !== preparedData.tokenAddress) return { status: "failure" };
    if (decimals !== preparedData.decimals) return { status: "failure" };

    // Adding empty array to args to make it a valid RawGtxBody with no properties since we don't receive it yet
    const gtxBody = [gtx.blockchainRid, gtx.operations.map((op) => [op.opName, op.args]), gtx.signers] as RawGtxBody;
    const digest = getDigestToSignFromRawGtxBody(gtxBody);
    const signature = Buffer.from(ecdsaSign(digest, Buffer.from(config.privateKey, 'hex')).signature);

    if (gtx.signatures) {
      gtx.signatures.push(signature);
    } else {
      gtx.signatures = [signature];
    }

    return { status: "success", data: gtx }
  }

  async execute(_gtx: GTX): Promise<SolanaMegaForwarderOutput> {
    const client = this._directoryNodeUrlPool.length > 0 ? await createClient({
      directoryNodeUrlPool: this._directoryNodeUrlPool ?? undefined,
      blockchainRid: this._megadataBlockchainRid.toString('hex')
    }) : await createClient({
      nodeUrlPool: this._nodeUrlPool ?? undefined,
      blockchainRid: this._megadataBlockchainRid.toString('hex')
    });

    await client.sendTransaction(gtx.serialize(_gtx));

    return { status: "success" };
  }
}