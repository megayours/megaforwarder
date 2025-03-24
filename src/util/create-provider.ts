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
    return new AlchemyProvider(chain, apiKey);
  } else if (type === "infura") {
    return new InfuraProvider(chain, apiKey);
  } else if (type === "quicknode" || type === "quiknode") {
    return new QuickNodeProvider(chain, apiKey);
  } else if (type === "ankr") {
    return new AnkrProvider(chain, apiKey);
  }

  throw new Error(`Unsupported RPC type: ${type}`);
}