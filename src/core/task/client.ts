import type { Peer } from "../types/config/Peer";
import type { ValidateRequest, ValidateResponse } from "../types/requests/ValidateRequest";
import { decode, encode } from "../../util/encoder";
import type { ProtocolPrepareResult } from "../types/Protocol";
import type { PrepareResponse } from "../types/requests/PrepareRequest";
import { err, ok, Result, ResultAsync } from "neverthrow";
import type { OracleError } from "../../util/errors";
import { logger } from "../../util/monitoring";

export const requestPrepare = async <T, R>(peer: Peer, request: T): Promise<Result<ProtocolPrepareResult<R>, OracleError>> => {
  const reqBody = encode(request);

  return await ResultAsync.fromPromise(
    fetch(`http://${peer.address}/task/prepare`, {
      method: "POST",
      body: reqBody,
      headers: {
        "Content-Type": "application/json",
      },
    }),
    (error): OracleError => ({
      type: 'timeout',
      context: `Failed to connect to peer ${peer.oracleId}: ${error}`
    })
  ).andThen((response) => {
    return ResultAsync.fromPromise(
      response.json() as Promise<PrepareResponse>,
      (error): OracleError => ({
        type: 'plugin_error',
        context: `Failed to parse response from peer ${peer.oracleId}: ${error}`
      })
    );
  }).andThen((resBody: PrepareResponse) => {
    logger.info(`Prepare response from peer ${peer.oracleId}: ${JSON.stringify(resBody)}`);
    if (!resBody.encodedData) {
      return err<ProtocolPrepareResult<R>, OracleError>({
        type: 'plugin_error',
        context: `Failed to prepare task in peer ${peer.oracleId}`
      });
    }

    const data = decode(Buffer.from(resBody.encodedData, 'hex')) as R;

    return ok<ProtocolPrepareResult<R>, OracleError>({
      data,
      signatureData: {
        signature: resBody.signature,
        encodedData: resBody.encodedData
      },
      encodedData: resBody.encodedData
    });
  });
};

export const requestValidate = async (peer: Peer, request: ValidateRequest): Promise<Result<unknown, OracleError>> => {
  const reqBody = encode(request);

  return await ResultAsync.fromPromise(
    fetch(`http://${peer.address}/task/validate`, {
      method: "POST",
      body: reqBody,
      headers: {
        "Content-Type": "application/json",
      },
    }),
    (error): OracleError => ({
      type: 'timeout',
      context: `Failed to connect to peer ${peer.oracleId}: ${error}`
    })
  ).andThen((response) => {
    return ResultAsync.fromPromise(
      response.json() as Promise<ValidateResponse>,
      (error): OracleError => ({
        type: 'plugin_error',
        context: `Failed to parse response from peer ${peer.oracleId}: ${error}`
      })
    );
  }).andThen((resBody: ValidateResponse) => {
    return resBody.encodedData ? ok<unknown, OracleError>(decode(Buffer.from(resBody.encodedData, 'hex'))) : err<unknown, OracleError>({
      type: 'plugin_error',
      context: `Failed to validate task in peer ${peer.oracleId}`
    });
  });
};

