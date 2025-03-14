export type PrepareRequest<T> = {
  pluginId: string;
  input: T;
}

export type PrepareResponse = {
  status: "success" | "failure";
  encodedData: string;
  signature: string;
}