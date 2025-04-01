import { AnkrProvider, JsonRpcProvider, QuickNodeProvider } from "ethers";
import { AlchemyProvider, InfuraProvider } from "ethers";
import type { ApiKeyRpc, JsonRpc, Rpc } from "../core/types/config/Rpc";
import { logger } from "./monitoring";

const jsonProviderCache = new Map<string, JsonRpcProvider>();

export const createRandomProvider = (rpcs: Rpc[]) => {
  const randomRpc = rpcs[Math.floor(Math.random() * rpcs.length)];
  if (!randomRpc) {
    throw new Error("No RPC configuration found");
  }

  const type = randomRpc.type;
  if (type === "json") {
    const { url } = randomRpc as JsonRpc;
    logger.info(`Creating JSON provider with url: ${url}`);
    if (jsonProviderCache.has(url)) {
      return { provider: jsonProviderCache.get(url), token: url };
    }
    const provider = new JsonRpcProvider(url);
    jsonProviderCache.set(url, provider);
    return { provider, token: url };
  } else if (type === "alchemy") {
    const { chain, apiKey } = randomRpc as ApiKeyRpc;
    logger.info(`Creating Alchemy provider with chain: ${chain} and token: ${apiKey}`);
    return { provider: new AlchemyProvider(chain, apiKey), token: apiKey };
  } else if (type === "infura") {
    const { chain, apiKey } = randomRpc as ApiKeyRpc;
    logger.info(`Creating Infura provider with chain: ${chain} and token: ${apiKey}`);
    return { provider: new InfuraProvider(chain, apiKey), token: apiKey };
  } else if (type === "quicknode" || type === "quiknode") {
    const { chain, apiKey } = randomRpc as ApiKeyRpc;
    logger.info(`Creating QuickNode provider with chain: ${chain} and token: ${apiKey}`);
    return { provider: new QuickNodeProvider(chain, apiKey), token: apiKey };
  } else if (type === "ankr") {
    const { chain, apiKey } = randomRpc as ApiKeyRpc;
    logger.info(`Creating Ankr provider with chain: ${chain} and token: ${apiKey}`);
    return { provider: new AnkrProvider(chain, apiKey), token: apiKey };
  }

  throw new Error(`Unsupported RPC type: ${type}`);
}