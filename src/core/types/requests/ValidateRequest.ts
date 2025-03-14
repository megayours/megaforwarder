export type ValidateRequest = {
  pluginId: string;
  input: unknown;
  preparedData: unknown;
  signature: string;
};

export type ValidateResponse = {
  status: "success" | "failure";
  encodedData?: string;
}