import config from "./config";
import { PluginRegistry } from "./core/plugin/PluginRegistry";
import { SolanaMegaForwarder } from "./plugins/SolanaMegaForwarder";
import taskCreate from "./routes/taskCreate";
import taskValidate from "./routes/taskValidate";
import taskPrepare from "./routes/taskPrepare";
import { ListenerRegistry } from "./core/listener/ListenerRegistry";
import { logger, register } from "./util/monitoring";
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
import { AccountLinker } from "./plugins/AccountLinker";

const pluginRegistry = PluginRegistry.getInstance();
pluginRegistry.register(new SolanaMegaForwarder());
pluginRegistry.register(new ERC721Forwarder());
pluginRegistry.register(new ERC20Forwarder());
pluginRegistry.register(new MocaStakeForwarder());
pluginRegistry.register(new SolanaBalanceUpdater());
pluginRegistry.register(new AccountLinker());

if (config.primary) {
  const listenerHandler = ListenerRegistry.getInstance();
  listenerHandler.register(new SolanaListener());
  listenerHandler.register(new EVMListener({
    chain: "ethereum",
    contract: "0xBd3531dA5CF5857e7CfAA92426877b022e612cf8",
    collection: "Pudgy Penguins",
    startBlock: 12876277,
    abi: erc721Abi,
    type: "erc721",
    filters: [
      {
        name: "Transfer",
        filter: (contract: Contract) => contract.filters.Transfer as ContractEventName
      }
    ]
  }));
  listenerHandler.register(new EVMListener({
    chain: "ethereum",
    contract: "0xf944e35f95e819e752f3ccb5faf40957d311e8c5",
    startBlock: 19729886,
    abi: erc20Abi,
    type: "erc20",
    filters: [
      {
        name: "Transfer",
        filter: (contract: Contract) => contract.filters.Transfer as ContractEventName
      }
    ]
  }));
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

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const server = Bun.serve({
  port: config.port,
  fetch: async (req) => {
    const url = new URL(req.url);
    const path = url.pathname;

    // Handle preflight requests
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    if (req.method === "GET" && path === "/health") {
      return new Response(JSON.stringify({ message: "OK" }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    if (req.method === "POST" && path === "/task/prepare") {
      const response = await taskPrepare(req);
      const { status, statusText, body } = response;
      const responseHeaders = { ...Object.fromEntries(response.headers), ...corsHeaders };
      
      return new Response(body, {
        status,
        statusText,
        headers: responseHeaders
      });
    }

    if (req.method === "POST" && path === "/task/validate") {
      const response = await taskValidate(req);
      const { status, statusText, body } = response;
      const responseHeaders = { ...Object.fromEntries(response.headers), ...corsHeaders };
      
      return new Response(body, {
        status,
        statusText,
        headers: responseHeaders
      });
    }

    return new Response(JSON.stringify({ error: "Not Found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...corsHeaders }
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

    // Handle preflight requests
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    if (req.method === "GET" && path === "/") {
      return new Response(JSON.stringify({ message: "Hello, world!" }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    if (req.method === "POST" && path === "/task") {
      const response = await taskCreate(req);
      const { status, statusText, body } = response;
      const responseHeaders = { ...Object.fromEntries(response.headers), ...corsHeaders };
      
      return new Response(body, {
        status,
        statusText,
        headers: responseHeaders
      });
    }

    if (req.method === "POST" && path === "/helius/webhook") {
      const response = await heliusWebhook(req);
      const { status, statusText, body } = response;
      const responseHeaders = { ...Object.fromEntries(response.headers), ...corsHeaders };
      
      return new Response(body, {
        status,
        statusText,
        headers: responseHeaders
      });
    }

    return new Response(JSON.stringify({ error: "Not Found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }
});

const metricsServer = Bun.serve({
  port: 9090,
  fetch: async (req) => {
    // Handle preflight requests
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }
    
    const metrics = await register.metrics();
    return new Response(metrics, { 
      headers: { 
        "Content-Type": register.contentType,
        ...corsHeaders
      } 
    });
  }
});

logger.info(`${config.id} running at ${server.url}`);
logger.info(`${config.id} API running at ${apiServer.url}`);
logger.info(`${config.id} Metrics running at ${metricsServer.url}`);