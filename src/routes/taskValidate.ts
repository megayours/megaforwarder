import type { ValidateRequest, ValidateResponse } from "../core/types/requests/ValidateRequest";
import { PluginRegistry } from "../core/plugin/PluginRegistry";
import { encode } from "../util/encoder";
import { decodeRequest } from "../util/http";
import { verifySignature } from "../util/crypto";
import config from "../config";
import { logger } from "../util/monitoring";

const taskValidate = async (req: Request) => {
  const body = await decodeRequest(req) as ValidateRequest;

  logger.info(`Validating data from peer`, body);

  if (!verifySignature(encode(body.preparedData), body.signature, config.publicKey)) {
    return new Response(JSON.stringify({ error: "Invalid signature" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  const plugin = PluginRegistry.getInstance().get(body.pluginId);
  if (!plugin) {
    return new Response(JSON.stringify({ error: `Plugin ${body.pluginId} not found` }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  }

  const result = await plugin.validate(body.input, body.preparedData);
  if (result.isErr()) {
    return new Response(JSON.stringify({ error: result.error.type, context: result.error.context }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  const encodedResult = encode(result.value);

  const response: ValidateResponse = {
    encodedData: encodedResult.toString('hex')
  };

  return new Response(JSON.stringify(response), {
    headers: { "Content-Type": "application/json" }
  });
}

export default taskValidate;