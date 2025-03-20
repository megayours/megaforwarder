export type ValidateRequest = {
  pluginId: string;
  input: unknown;
  preparedData: unknown;
  signature: string;
};

export type ValidateResponse = {
  encodedData?: string;
}