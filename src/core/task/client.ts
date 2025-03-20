import type { Peer } from "../types/config/Peer";
import type { ValidateRequest, ValidateResponse } from "../types/requests/ValidateRequest";
import { decode, encode } from "../../util/encoder";
import type { ProtocolPrepareResult, ValidateResult } from "../types/Protocol";
import type { PrepareResponse } from "../types/requests/PrepareRequest";
import { err, ok, Result, ResultAsync } from "neverthrow";
import type { TaskError } from "../../util/errors";

export const requestPrepare = async <T, R>(peer: Peer, request: T): Promise<Result<ProtocolPrepareResult<R>, TaskError>> => {
  const reqBody = encode(request);

  return await ResultAsync.fromPromise(
    fetch(`http://${peer.address}/task/prepare`, {
      method: "POST",
      body: reqBody,
      headers: {
        "Content-Type": "application/json",
      },
    }),
    (error): TaskError => ({
      type: 'timeout',
      context: `Failed to connect to peer ${peer.oracleId}: ${error}`
    })
  ).andThen((response) => {
    return ResultAsync.fromPromise(
      response.json() as Promise<PrepareResponse>,
      (error): TaskError => ({
        type: 'plugin_error',
        context: `Failed to parse response from peer ${peer.oracleId}: ${error}`
      })
    );
  }).andThen((resBody: PrepareResponse) => {
    if (!resBody.encodedData) {
      return err<ProtocolPrepareResult<R>, TaskError>({
        type: 'plugin_error',
        context: `Failed to prepare task in peer ${peer.oracleId}`
      });
    }

    const data = decode(Buffer.from(resBody.encodedData, 'hex')) as R;

    return ok<ProtocolPrepareResult<R>, TaskError>({
      data,
      signatureData: {
        signature: resBody.signature,
        encodedData: resBody.encodedData
      },
      encodedData: resBody.encodedData
    });
  });
};

export const requestValidate = async <T, R>(peer: Peer, request: ValidateRequest): Promise<Result<ValidateResult<R>, TaskError>> => {
  const reqBody = encode(request);

  return await ResultAsync.fromPromise(
    fetch(`http://${peer.address}/task/validate`, {
      method: "POST",
      body: reqBody,
      headers: {
        "Content-Type": "application/json",
      },
    }),
    (error): TaskError => ({
      type: 'timeout',
      context: `Failed to connect to peer ${peer.oracleId}: ${error}`
    })
  ).andThen((response) => {
    return ResultAsync.fromPromise(
      response.json() as Promise<ValidateResponse>,
      (error): TaskError => ({
        type: 'plugin_error',
        context: `Failed to parse response from peer ${peer.oracleId}: ${error}`
      })
    );
  }).andThen((resBody: ValidateResponse) => {
    return ok<ValidateResult<R>, TaskError>({
      data: resBody.encodedData ? decode(Buffer.from(resBody.encodedData, 'hex')) as R : undefined,
    });
  });
};

