import config from "../config";
import { PluginRegistry } from "../core/plugin/PluginRegistry";
import type { PrepareRequest, PrepareResponse } from "../core/types/requests/PrepareRequest";
import { signData } from "../util/crypto";
import { encode } from "../util/encoder";
import { decodeRequest } from "../util/http";

const taskPrepare = async (req: Request) => {
  try {
    const body = await decodeRequest(req) as PrepareRequest<unknown>;

    const plugin = PluginRegistry.getInstance().get(body.pluginId);
    if (!plugin) {
      return new Response(JSON.stringify({ error: `Plugin ${body.pluginId} not found` }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }

    const result = await plugin.prepare(body.input);
    const encodedData = encode(result.data);

    const response: PrepareResponse = {
      status: result.status,
      encodedData: encodedData.toString('hex'),
      signature: signData(encodedData, config.privateKey)
    };

    return new Response(JSON.stringify(response), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (error: any) {
    console.error("Error validating task:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

export default taskPrepare;