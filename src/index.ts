import config from "./config";
import { PluginRegistry } from "./core/plugin/PluginRegistry";
import { SolanaMegaForwarder } from "./plugins/SolanaMegaForwarder";
import taskCreate from "./routes/taskCreate";
import taskValidate from "./routes/taskValidate";
import taskPrepare from "./routes/taskPrepare";
import { ListenerRegistry } from "./core/listener/ListenerRegistry";
import { logger } from "./util/monitoring";
import { EVMListener } from "./listeners/EVMListener";
import type { Contract, ContractEventName } from "ethers";
import erc721Abi from "./util/abis/erc721";
import erc20Abi from "./util/abis/erc20";
import mocaStakeAbi from "./util/abis/moca-staking";
import { ERC721Forwarder } from "./plugins/ERC721Forwarder";
import { ERC20Forwarder } from "./plugins/ERC20Forwarder";
import { MocaStakeForwarder } from "./plugins/MocaStakeForwarder";
import { SolanaListener } from "./listeners/SolanaListener";
import { SolanaBalanceUpdater } from "./plugins/SolanaBalanceUpdater";
import heliusWebhook from "./routes/heliusWebhook";

const pluginRegistry = PluginRegistry.getInstance();
pluginRegistry.register(new SolanaMegaForwarder());
pluginRegistry.register(new ERC721Forwarder());
pluginRegistry.register(new ERC20Forwarder());
pluginRegistry.register(new MocaStakeForwarder());
pluginRegistry.register(new SolanaBalanceUpdater());

if (config.primary) {
  const listenerHandler = ListenerRegistry.getInstance();
  // listenerHandler.register(new SolanaListener());
  // listenerHandler.register(new EVMListener({
  //   chain: "ethereum",
  //   contract: "0xBd3531dA5CF5857e7CfAA92426877b022e612cf8",
  //   collection: "Pudgy Penguins",
  //   startBlock: 12876277,
  //   abi: erc721Abi,
  //   type: "erc721",
  //   filters: [
  //     {
  //       name: "Transfer",
  //       filter: (contract: Contract) => contract.filters.Transfer as ContractEventName
  //     }
  //   ]
  // }));
  // listenerHandler.register(new EVMListener({
  //   chain: "ethereum",
  //   contract: "0xf944e35f95e819e752f3ccb5faf40957d311e8c5",
  //   startBlock: 19729886,
  //   abi: erc20Abi,
  //   type: "erc20",
  //   filters: [
  //     {
  //       name: "Transfer",
  //       filter: (contract: Contract) => contract.filters.Transfer as ContractEventName
  //     }
  //   ]
  // }));
  listenerHandler.register(new EVMListener({
    chain: "ethereum",
    contract: "0x9a98E6B60784634AE273F2FB84519C7F1885AeD2",
    startBlock: 20260103,
    abi: mocaStakeAbi,
    type: "moca_stake",
    filters: [
      {
        name: "Staked",
        filter: (contract: Contract) => contract.filters.Staked as ContractEventName
      },
      {
        name: "StakedBehalf",
        filter: (contract: Contract) => contract.filters.StakedBehalf as ContractEventName
      },
      {
        name: "Unstaked",
        filter: (contract: Contract) => contract.filters.Unstaked as ContractEventName
      }
    ]
  }));
}

console.log(`Starting server on port ${config.port}`);

const server = Bun.serve({
  port: config.port,
  fetch: async (req) => {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "GET" && path === "/health") {
      return new Response(JSON.stringify({ message: "OK" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (req.method === "POST" && path === "/task/prepare") {
      return taskPrepare(req);
    }

    if (req.method === "POST" && path === "/task/validate") {
      return taskValidate(req);
    }

    return new Response(JSON.stringify({ error: "Not Found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  }
});

const apiServer = Bun.serve({
  port: config.apiPort,
  maxRequestBodySize: 1024 * 1024 * 10, // 10MB
  fetch: async (req) => {
    console.log(`Received request`, { url: req.url, method: req.method });
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "GET" && path === "/") {
      return new Response(JSON.stringify({ message: "Hello, world!" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (req.method === "POST" && path === "/task") {
      return taskCreate(req);
    }

    if (req.method === "POST" && path === "/helius/webhook") {
      return heliusWebhook(req);
    }

    return new Response(JSON.stringify({ error: "Not Found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  }
});

logger.info(`${config.id} running at ${server.url}`);
logger.info(`${config.id} API running at ${apiServer.url}`);