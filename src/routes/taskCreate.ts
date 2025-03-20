import { Result } from "neverthrow";
import { Task } from "../core/task/Task";
import type { TaskCreationRequest } from "../core/types/requests/TaskCreationRequest";
import type { TaskError } from "../util/errors";

const taskCreate = async (req: Request) => {
  const body = await req.json() as TaskCreationRequest;
  const task = Result.fromThrowable(
    () => new Task(body.pluginId, body.input),
    (error): TaskError => ({
      type: 'plugin_error',
      context: `Failed to create task: ${error}`
    })
  )();
  if (task.isErr()) {
    return new Response(JSON.stringify({ error: task.error.type, context: task.error.context }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  const result = await task.value.start();
  if (result.isErr()) {
    return new Response(JSON.stringify({ error: result.error.type, context: result.error.context }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  return new Response("OK");
};

export default taskCreate;