import { ecdsaVerify } from "secp256k1";
import type { Peer } from "../core/types/config/Peer";
import type { PeerSignedResponse } from "../core/types/PeerSignedResponse";
import { decode } from "./encoder";
import { SHA256 } from "bun";

export const decodeResponse = async <T>(response: Response) => {
  const body = await response.arrayBuffer();
  return decode(Buffer.from(body)) as T;
};

export const decodeRequest = async (req: Request) => {
  const body = await req.blob();
  const arrayBuffer = await body.arrayBuffer();
  const encodedResponse = Buffer.from(arrayBuffer);
  return decode(encodedResponse);
};

