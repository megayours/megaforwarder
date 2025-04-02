import { createClient, getDigestToSignFromRawGtxBody, gtx, type GTX, type RawGtxBody } from "postchain-client";
import { Plugin } from "../core/plugin/Plugin";
import type { Result } from "neverthrow";
import { ok, err } from "neverthrow";
import type { OracleError } from "../util/errors";
import { ecdsaSign } from "secp256k1";
import config from "../config";
import { logger } from "../util/monitoring";
import { postchainConfig } from "../util/postchain-config";
import { hexToBuffer } from "../util/hex";
import { validateAuth, type AccountSignature } from "../util/auth";
import type { ProcessInput } from "../core/types/Protocol";
import { randomBytes } from "ethers";

type ManageQueryInput = {
  auth: AccountSignature;
  filters: Filter[];
  id?: string;
  name?: string; // Required if id is not provided
};

type Filter = {
  source: string;
  asset: string;
  requires: number;
}

export class ManageQuery extends Plugin<ManageQueryInput, ManageQueryInput, GTX, void> {
  static readonly pluginId = "manage-query";

  private readonly _directoryNodeUrlPool: string[];
  private readonly _blockchainRid: Buffer;

  constructor() {
    super({ id: ManageQuery.pluginId });

    this._directoryNodeUrlPool = config.abstractionChain.directoryNodeUrlPool as string[];
    this._blockchainRid = Buffer.from(config.abstractionChain.blockchainRid as string, "hex");
  }

  async prepare(input: ManageQueryInput): Promise<Result<ManageQueryInput, OracleError>> {
    logger.info(`Preparing manage query with ${input.filters.length} filters`);
    const authResult = validateAuth(input.auth, `Query Management`);
    if (authResult.isErr()) {
      return err(authResult.error);
    }

    if (!input.id && !input.name) {
      return err({ type: "validation_error", context: "Either id or name must be provided" });
    }

    return ok(input);
  }

  async process(input: ProcessInput<ManageQueryInput>[]): Promise<Result<GTX, OracleError>> {
    logger.info(`Processing manage query`);
    const selectedData = input[0];
    if (!selectedData) {
      return err({ type: "process_error", context: "No input data" });
    }

    let tx = gtx.emptyGtx(this._blockchainRid);

    if (!selectedData.data.id) {
      const id = Buffer.from(randomBytes(32));
      tx = gtx.addTransactionToGtx("asset_groups.create_asset_group", [id, selectedData.data.name!, selectedData.data.auth.account], tx);
      for (const filter of selectedData.data.filters) {
        tx = gtx.addTransactionToGtx("asset_groups.add_asset_group_filter", [id, filter.source, filter.asset, filter.requires], tx);
      }
    } else {
      const assetGroupId = hexToBuffer(selectedData.data.id);
      const client = await createClient({
        ...postchainConfig,
        directoryNodeUrlPool: this._directoryNodeUrlPool,
        blockchainRid: this._blockchainRid.toString('hex'),
      });
      
      const currentFilters = await client.query<{ source: string, asset: string, requires: number }[]>("asset_groups.get_asset_group_filters", { asset_group_id: assetGroupId });
      
      // Detect which filters needs to be added or removed. If a filter has a different requires then it should be deleted and then re-added.
      for (const filter of selectedData.data.filters) {
        const currentFilter = currentFilters.find((f) => f.source === filter.source && f.asset === filter.asset);
        if (currentFilter && currentFilter.requires !== filter.requires) {
          tx = gtx.addTransactionToGtx("asset_groups.remove_asset_group_filter", [assetGroupId, filter.source, filter.asset], tx);
          tx = gtx.addTransactionToGtx("asset_groups.add_asset_group_filter", [assetGroupId, filter.source, filter.asset, filter.requires], tx);
        }
        if (!currentFilter) {
          tx = gtx.addTransactionToGtx("asset_groups.add_asset_group_filter", [assetGroupId, filter.source, filter.asset, filter.requires], tx);
        }
      }

      // If a filter is not in the current filters, it should be removed
      for (const filter of currentFilters) {
        if (!selectedData.data.filters.find((f) => f.source === filter.source && f.asset === filter.asset)) {
          tx = gtx.addTransactionToGtx("asset_groups.remove_asset_group_filter", [assetGroupId, filter.source, filter.asset], tx);
        }
      }
    }

    tx = gtx.addTransactionToGtx("nop", [Math.floor(Math.random() * 1000000)], tx);
    tx.signers = input.map((i) => Buffer.from(i.pubkey, "hex"));

    return ok(tx);
  }

  async validate(gtx: GTX, preparedData: ManageQueryInput): Promise<Result<GTX, OracleError>> {
    const gtxBody = [gtx.blockchainRid, gtx.operations.map((op) => [op.opName, op.args]), gtx.signers] as RawGtxBody;
    const digest = getDigestToSignFromRawGtxBody(gtxBody);
    const signature = Buffer.from(ecdsaSign(digest, Buffer.from(config.privateKey, 'hex')).signature);

    if (gtx.signatures) {
      gtx.signatures.push(signature);
    } else {
      gtx.signatures = [signature];
    }

    logger.info(`Manage query validated successfully`);
    return ok(gtx);
  }

  async execute(_gtx: GTX): Promise<Result<void, OracleError>> {
    logger.info(`Executing GTX for manage query`);
    const client = await createClient({
      ...postchainConfig,
      directoryNodeUrlPool: this._directoryNodeUrlPool,
      blockchainRid: this._blockchainRid.toString('hex'),
    });

    try {
      const receipt = await client.sendTransaction(gtx.serialize(_gtx));
      logger.info(`Transaction receipt: ${JSON.stringify(receipt)}`);
      if (receipt.statusCode !== 200) {
        return err({ type: "execute_error", context: receipt.status });
      }
      logger.info(`Manage query executed successfully with txRid: ${receipt.transactionRid.toString('hex')}`);
    } catch (error: any) {
      // Check if this is a 409 error (Transaction already in database)
      if (error.status === 409) {
        logger.info(`Transaction already in database, considering as success`);
      } else {
        // Log and return failure for any other error
        logger.error(`Failed to manage query:`, error);
        return err({ type: "execute_error", context: `Error: ${error}` });
      }
    }

    return ok();
  }
}