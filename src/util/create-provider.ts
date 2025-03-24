import { AnkrProvider, QuickNodeProvider } from "ethers";
import { AlchemyProvider, InfuraProvider } from "ethers";
import type { Rpc } from "../core/types/config/Rpc";

export const createRandomProvider = (rpcs: Rpc[]) => {
  const randomRpc = rpcs[Math.floor(Math.random() * rpcs.length)];
  if (!randomRpc) {
    throw new Error("No RPC configuration found");
  }
  const apiKey = randomRpc.apiKey;
  const chain = randomRpc.chain;
  const type = randomRpc.type;

  if (type === "alchemy") {
    return { provider: new AlchemyProvider(chain, apiKey), token: apiKey };
  } else if (type === "infura") {
    return { provider: new InfuraProvider(chain, apiKey), token: apiKey };
  } else if (type === "quicknode" || type === "quiknode") {
    return { provider: new QuickNodeProvider(chain, apiKey), token: apiKey };
  } else if (type === "ankr") {
    return { provider: new AnkrProvider(chain, apiKey), token: apiKey };
  }

  throw new Error(`Unsupported RPC type: ${type}`);
}