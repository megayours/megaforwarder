export type PrepareRequest<T> = {
  pluginId: string;
  input: T;
}

export type PrepareResponse = {
  encodedData: string;
  signature: string;
}