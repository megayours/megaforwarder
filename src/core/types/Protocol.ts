export type SignatureData = {
  signature: string;
  encodedData: string;
}

export type PrepareResult<T> = {
  status: "success" | "failure";
  data?: T;
};

export type ProtocolPrepareResult<T> = {
  status: "success" | "failure";
  data: T;
  signatureData: SignatureData | null;
  encodedData: string;
}

export type ProcessInput<T> = {
  data: T;
  pubkey: string;
}

export type ProcessResult<T> = {
  status: "success" | "failure";
  data?: T;
};

export type ValidateResult<T> = {
  status: "success" | "failure";
  data?: T;
};

export type ExecuteResult<T> = {
  status: "success" | "failure";
  data?: T;
};
