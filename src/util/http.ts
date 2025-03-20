import { decode } from "./encoder";


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

