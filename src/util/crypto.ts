import { SHA256 } from "bun";
import { ecdsaSign, ecdsaVerify } from "secp256k1";

export const signData = (data: Buffer, privateKey: string) => {
  const hash = hashData(data);
  const signature = ecdsaSign(Buffer.from(hash.buffer), Buffer.from(privateKey, 'hex'));
  return Buffer.from(signature.signature).toString('hex');
}

export const verifySignature = (data: Buffer, signature: string, publicKey: string) => {
  const hash = hashData(data);
  const verified = ecdsaVerify(Buffer.from(signature, 'hex'), Buffer.from(hash.buffer), Buffer.from(publicKey, 'hex'));
  return verified;
}

export const hashData = (data: Buffer) => {
  return Buffer.from(new SHA256().update(data).digest().buffer);
}