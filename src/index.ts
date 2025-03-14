import config from "./config";
import { PluginRegistry } from "./core/plugin/PluginRegistry";
import { SolanaMegaForwarder } from "./plugins/SolanaMegaForwarder";
import taskCreate from "./routes/taskCreate";
import taskValidate from "./routes/taskValidate";
import taskPrepare from "./routes/taskPrepare";
import { SolanaListener } from "./listeners/SolanaListener";
import { ListenerRegistry } from "./core/listener/ListenerRegistry";
import { SolanaMinter } from "./plugins/SolanaMinter";
import { logger } from "./util/monitoring";

const pluginRegistry = PluginRegistry.getInstance();
pluginRegistry.register(new SolanaMegaForwarder());
pluginRegistry.register(new SolanaMinter());

if (config.primary) {
  const listenerHandler = ListenerRegistry.getInstance();
  listenerHandler.register(new SolanaListener());
}

const server = Bun.serve({
  port: config.port,
  fetch: async (req) => {
    const url = new URL(req.url);
    const path = url.pathname;

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
  fetch: async (req) => {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "POST" && path === "/task") {
      return taskCreate(req);
    }
    
    return new Response(JSON.stringify({ error: "Not Found" }), { 
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  }
});

logger.info(`${config.id} running at ${server.url}`);
logger.info(`${config.id} API running at ${apiServer.url}`);