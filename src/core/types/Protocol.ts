export type SignatureData = {
  signature: string;
  encodedData: string;
}

export type PrepareResult<T> = {
  data?: T;
};

export type ProtocolPrepareResult<T> = {
  data: T;
  signatureData: SignatureData | null;
  encodedData: string;
}

export type ProcessInput<T> = {
  data: T;
  pubkey: string;
}

export type ProcessResult<T> = {
  data?: T;
};

export type ValidateResult<T> = {
  data?: T;
};

export type ExecuteResult<T> = {
  data?: T;
};
