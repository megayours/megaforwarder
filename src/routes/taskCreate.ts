import { PluginNotFound } from "../core/errors/PluginNotFound";
import { Task } from "../core/task/Task";
import type { TaskCreationRequest } from "../core/types/requests/TaskCreationRequest";

const taskCreate = async (req: Request) => {
  try {
    const body = await req.json() as TaskCreationRequest;
    const task = new Task(body.pluginId, body.input);
    await task.start();
    return new Response("OK");
  } catch (error: any) {
    if (error instanceof PluginNotFound) {
      return new Response(JSON.stringify({ error: error.message }), { 
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }
    console.error("Error processing task:", error);
    return new Response(JSON.stringify({ error: error.message }), { 
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
};

export default taskCreate;