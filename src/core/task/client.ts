import type { Peer } from "../types/config/Peer";
import type { ValidateRequest, ValidateResponse } from "../types/requests/ValidateRequest";
import { decode, encode } from "../../util/encoder";
import type { ProtocolPrepareResult, ValidateResult } from "../types/Protocol";
import type { PrepareResponse } from "../types/requests/PrepareRequest";

export const requestPrepare = async <T, R>(peer: Peer,request: T): Promise<ProtocolPrepareResult<R>> => {
  const reqBody = encode(request);
  const response = await fetch(`http://${peer.address}/task/prepare`, {
    method: "POST",
    body: reqBody,
    headers: {
      "Content-Type": "application/json",
    },
  });

  const resBody = await response.json() as PrepareResponse;

  if (resBody.status === "failure") {
    throw new Error(`Failed to prepare task in peer ${peer.oracleId}`);
  }

  return {
    status: resBody.status,  
    data: decode(Buffer.from(resBody.encodedData, 'hex')) as R,
    signatureData: {
      signature: resBody.signature,
      encodedData: resBody.encodedData
    },
    encodedData: resBody.encodedData
  }
};

export const requestValidate = async <T, R>(peer: Peer, request: ValidateRequest): Promise<ValidateResult<R>> => {
  const reqBody = encode(request);
  const response = await fetch(`http://${peer.address}/task/validate`, {
    method: "POST",
    body: reqBody,
    headers: {
      "Content-Type": "application/json",
    },
  });

  const resBody = await response.json() as ValidateResponse;

  return {
    status: resBody.status,
    data: resBody.encodedData ? decode(Buffer.from(resBody.encodedData, 'hex')) as R : undefined,
  };
};

