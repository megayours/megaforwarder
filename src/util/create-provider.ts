import { JsonRpcProvider, QuickNodeProvider } from "ethers";
import { AlchemyProvider, InfuraProvider } from "ethers";

export const createProvider = (url: string) => {
  if (url.includes("alchemy")) {
    return new AlchemyProvider(url);
  } else if (url.includes("infura")) {
    return new InfuraProvider(url);
  } else if (url.includes("quicknode") || url.includes("quiknode")) {
    return new QuickNodeProvider(url);
  }

  return new JsonRpcProvider(url);
}