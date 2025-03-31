import config from "./config";
import { PluginRegistry } from "./core/plugin/PluginRegistry";
import { SolanaMegaForwarder } from "./plugins/SolanaMegaForwarder";
import taskCreate from "./routes/taskCreate";
import taskValidate from "./routes/taskValidate";
import taskPrepare from "./routes/taskPrepare";
import { ListenerRegistry } from "./core/listener/ListenerRegistry";
import { logger, register } from "./util/monitoring";
import { ERC721Forwarder } from "./plugins/ERC721Forwarder";
import { ERC20Forwarder } from "./plugins/ERC20Forwarder";
import { MocaStakeForwarder } from "./plugins/MocaStakeForwarder";
import { SolanaListener } from "./listeners/SolanaListener";
import { SolanaBalanceUpdater } from "./plugins/SolanaBalanceUpdater";
import heliusWebhook from "./routes/heliusWebhook";
import { AccountLinker } from "./plugins/AccountLinker";
import { ERC721Listener } from "./listeners/ERC721Listener";
import { AssetRegistration } from "./plugins/AssetRegistration";
import { MocaStakeListener } from "./listeners/MocaStakeListener";
import { ERC20Listener } from "./listeners/ERC20Listener";
import { ManageMegadata } from "./plugins/ManageMegadata";

const pluginRegistry = PluginRegistry.getInstance();
pluginRegistry.register(new SolanaMegaForwarder());
pluginRegistry.register(new ERC721Forwarder());
pluginRegistry.register(new ERC20Forwarder());
pluginRegistry.register(new MocaStakeForwarder());
pluginRegistry.register(new SolanaBalanceUpdater());
pluginRegistry.register(new AccountLinker());
pluginRegistry.register(new AssetRegistration());
pluginRegistry.register(new ManageMegadata());

if (config.primary) {
  const listenerHandler = ListenerRegistry.getInstance();
  listenerHandler.register(new SolanaListener());
  listenerHandler.register(new ERC721Listener());
  listenerHandler.register(new ERC20Listener());
  listenerHandler.register(new MocaStakeListener());
}

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

    if (req.method === "GET" && path === "/sources") {
      const rpcs = config.rpc;
      return new Response(JSON.stringify(Object.keys(rpcs)), {
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