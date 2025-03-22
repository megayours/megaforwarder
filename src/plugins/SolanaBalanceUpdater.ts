import { Plugin } from "../core/plugin/Plugin";
import type { ProcessInput } from "../core/types/Protocol";
import { 
  logger, 
  rpcCallsTotal, 
  txProcessedTotal, 
  solanaBalanceUpdateDuration, 
  solanaTokenLookupErrors,
  solanaRpcLatency,
  throttleWaitTime
} from "../util/monitoring";
import config from "../config";
import { ChainConfirmationLevel, createClient, getDigestToSignFromRawGtxBody, gtx, type GTX, type RawGtxBody } from "postchain-client";
import { ecdsaSign } from "secp256k1";
import { Connection, PublicKey, type AccountInfo, type ParsedAccountData, type RpcResponseAndContext } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddress, type Account } from "@solana/spl-token";
import { err, ok, type Result } from "neverthrow";
import type { OracleError } from "../util/errors";
import { executeThrottled } from "../util/throttle";
import { SOLANA_THROTTLE_LIMIT } from "../util/constants";

type SolanaBalanceUpdaterInput = {
  tokenMint: string;
  userAccount: string;
  decimals: number;
};

type BalanceUpdateEvent = {
  operation: string;
  args: any[];
};

type SolanaBalanceUpdaterOutput = {
  message?: string;
};

export class SolanaBalanceUpdater extends Plugin<SolanaBalanceUpdaterInput, BalanceUpdateEvent, GTX, SolanaBalanceUpdaterOutput> {
  static readonly pluginId = "solana-balance-updater";
  private readonly _connection: Connection;
  private readonly _directoryNodeUrlPool: string[];
  private readonly _megaYoursBlockchainRid: Buffer;

  constructor() {
    super({ id: SolanaBalanceUpdater.pluginId });

    const solanaRpcUrl = config.rpc["solana"]?.[0];
    if (!solanaRpcUrl) throw new Error("No Solana RPC URL found");

    this._connection = new Connection(solanaRpcUrl);
    this._directoryNodeUrlPool = config.abstractionChain.directoryNodeUrlPool;
    this._megaYoursBlockchainRid = Buffer.from(config.abstractionChain.blockchainRid, "hex");
  }

  async prepare(input: SolanaBalanceUpdaterInput): Promise<Result<BalanceUpdateEvent, OracleError>> {
    const prepareTimer = solanaBalanceUpdateDuration.startTimer({ operation: 'prepare' });
    
    logger.info(`Preparing balance update for user account`, {
      tokenMint: input.tokenMint,
      decimals: input.decimals,
      userAccount: input.userAccount
    });

    // Convert string addresses to PublicKeys
    const mintPubkey = new PublicKey(input.tokenMint);
    const userPubkey = new PublicKey(input.userAccount);

    logger.debug(`Looking up token account for mint ${mintPubkey.toString()} and user ${userPubkey.toString()}`);

    // Get the associated token address for this user and token mint
    const beforeThrottle = Date.now();
    const tokenAddress = await executeThrottled<PublicKey>(
      "solana",
      () =>
        getAssociatedTokenAddress(
          mintPubkey,
          userPubkey,
          true // Allow owner off curve
        ),
      SOLANA_THROTTLE_LIMIT
    );
    throttleWaitTime.observe({ identifier: 'solana', operation: 'getAssociatedTokenAddress' }, (Date.now() - beforeThrottle) / 1000);
    
    if (tokenAddress.isErr()) {
      solanaTokenLookupErrors.inc({ error_type: 'associated_token_address', token_mint: input.tokenMint });
      prepareTimer({ status: 'error' });
      return err({ type: "permanent_error", context: `Error getting associated token address: ${tokenAddress.error}` });
    }

    logger.debug(`Looking up token balance for address ${tokenAddress.value.toString()}`);

    // Get the token account info to fetch balance
    let balance = "0";

    // First, try to find all token accounts using getParsedTokenAccountsByOwner
    // This is more reliable but potentially more expensive
    try {
      const rpcTimer = solanaRpcLatency.startTimer({ method: 'getParsedTokenAccountsByOwner' });
      const throttleStart = Date.now();
      const tokenAccounts = await executeThrottled<RpcResponseAndContext<{ pubkey: PublicKey; account: AccountInfo<ParsedAccountData>; }[]>>(
        "solana",
        () => this._connection.getParsedTokenAccountsByOwner(userPubkey, { mint: mintPubkey }),
        SOLANA_THROTTLE_LIMIT
      );
      throttleWaitTime.observe({ identifier: 'solana', operation: 'getParsedTokenAccountsByOwner' }, (Date.now() - throttleStart) / 1000);
      rpcTimer({ status: tokenAccounts.isOk() ? 'success' : 'error' });
      
      rpcCallsTotal.inc({ chain: "solana", chain_code: input.tokenMint, rpc_url: this._connection.rpcEndpoint }, 1);
      if (tokenAccounts.isOk() && tokenAccounts.value.value.length > 0) {
        const accountInfo = tokenAccounts.value.value[0];
        if (accountInfo && accountInfo.account.data.parsed.info) {
          const parsedInfo = accountInfo.account.data.parsed.info;
          balance = parsedInfo.tokenAmount.amount;
          logger.debug(`Retrieved token balance from parsed account: ${balance} at address ${accountInfo.pubkey.toString()}`);
        } else {
          logger.info(`Retrieved account info structure is invalid`);
          solanaTokenLookupErrors.inc({ error_type: 'invalid_parsed_account_info', token_mint: input.tokenMint });
        }
      } else if (tokenAccounts.isErr()) {
        logger.warn(`Error getting parsed token accounts, falling back to ATA: ${JSON.stringify(tokenAccounts.error)}`);
        solanaTokenLookupErrors.inc({ error_type: 'parsed_token_accounts_error', token_mint: input.tokenMint });

        // Fallback to the ATA method
        const ataRpcTimer = solanaRpcLatency.startTimer({ method: 'getAccount' });
        const ataThrottleStart = Date.now();
        const tokenAccountResult = await executeThrottled<Account>(
          "solana",
          () => getAccount(this._connection, tokenAddress.value),
          SOLANA_THROTTLE_LIMIT
        );
        throttleWaitTime.observe({ identifier: 'solana', operation: 'getAccount' }, (Date.now() - ataThrottleStart) / 1000);
        ataRpcTimer({ status: tokenAccountResult.isOk() ? 'success' : 'error' });
        
        rpcCallsTotal.inc({ chain: "solana", chain_code: input.tokenMint, rpc_url: this._connection.rpcEndpoint }, 1);
        if (tokenAccountResult.isOk()) {
          balance = tokenAccountResult.value.amount.toString();
          logger.debug(`Retrieved token balance from getAccount: ${balance}`);
        } else if (tokenAccountResult.error.type !== "non_error") {
          logger.warn(`Failed to get token balance via both methods: ${JSON.stringify(tokenAccountResult.error)}`);
          solanaTokenLookupErrors.inc({ error_type: 'fallback_get_account_error', token_mint: input.tokenMint });
        }
      } else {
        logger.info(`No token accounts found for mint ${mintPubkey.toString()}`);
        solanaTokenLookupErrors.inc({ error_type: 'no_token_accounts', token_mint: input.tokenMint });
      }
    } catch (error: any) {
      logger.error(`Error in token account lookup: ${JSON.stringify(error)}`);
      solanaTokenLookupErrors.inc({ error_type: 'unexpected_error', token_mint: input.tokenMint });
    }

    logger.debug(`Final retrieved token balance: ${balance}`);
    prepareTimer({ status: 'success' });

    // For a balance update, pass the token mint, user account, and current balance to the Chromia blockchain
    return ok({
      operation: "solana.spl.balance_update",
      args: [
        input.tokenMint,
        input.userAccount,
        BigInt(balance),
        input.decimals
      ]
    });
  }

  async process(input: ProcessInput<BalanceUpdateEvent>[]): Promise<Result<GTX, OracleError>> {
    const processTimer = solanaBalanceUpdateDuration.startTimer({ operation: 'process' });
    
    const selectedData = input[0];
    if (!selectedData) {
      processTimer({ status: 'error' });
      return err({ type: "process_error", context: `No input data` });
    }

    const { operation, args }: BalanceUpdateEvent = selectedData.data;

    const emptyGtx = gtx.emptyGtx(this._megaYoursBlockchainRid);
    let tx = gtx.addTransactionToGtx(operation, args, emptyGtx);
    tx = gtx.addTransactionToGtx('nop', [Math.floor(Math.random() * 1000000)], tx);
    tx.signers = input.map((i) => Buffer.from(i.pubkey, 'hex'));
    
    processTimer({ status: 'success' });
    return ok(tx);
  }

  async validate(gtx: GTX, preparedData: BalanceUpdateEvent): Promise<Result<GTX, OracleError>> {
    const validateTimer = solanaBalanceUpdateDuration.startTimer({ operation: 'validate' });
    
    const gtxBody = [gtx.blockchainRid, gtx.operations.map((op) => [op.opName, op.args]), gtx.signers] as RawGtxBody;
    const digest = getDigestToSignFromRawGtxBody(gtxBody);
    const signature = Buffer.from(ecdsaSign(digest, Buffer.from(config.privateKey, 'hex')).signature);

    if (gtx.signatures) {
      gtx.signatures.push(signature);
    } else {
      gtx.signatures = [signature];
    }

    validateTimer({ status: 'success' });
    return ok(gtx);
  }

  async execute(_gtx: GTX): Promise<Result<SolanaBalanceUpdaterOutput, OracleError>> {
    const executeTimer = solanaBalanceUpdateDuration.startTimer({ operation: 'execute' });
    
    logger.debug(`Executing GTX for balance update`);
    const client = await createClient({
      directoryNodeUrlPool: this._directoryNodeUrlPool,
      blockchainRid: this._megaYoursBlockchainRid.toString('hex')
    });

    try {
      await client.sendTransaction(gtx.serialize(_gtx), true, undefined, ChainConfirmationLevel.Dapp);
      logger.info(`Balance update forwarded successfully`);
      txProcessedTotal.inc({ type: "solana_balance_update" });
      executeTimer({ status: 'success' });
    } catch (error: any) {
      // Check if this is a 409 error (Transaction already in database)
      if (error.status === 409) {
        logger.info(`Transaction already in database, considering as success`);
        executeTimer({ status: 'duplicate' });
      } else {
        // Log and return failure for any other error
        logger.error(`Failed to update balance:`, error);
        executeTimer({ status: 'error' });
        return err({ type: "execute_error", context: `Error: ${error}` });
      }
    }

    return ok({
      message: "Balance update forwarded successfully"
    });
  }
} 