export type TaskError =
  | { type: 'plugin_error'; context?: string }
  | { type: 'timeout'; context?: string }
  | { type: 'insufficient_peers'; context?: string }
  | { type: 'permanent_error'; context?: string }
  | { type: 'non_error'; context?: string };

export type ListenerError =
  | { type: 'task_error'; context?: string }
  | { type: 'unsupported_contract_type'; context?: string }
  | { type: 'non_error'; context?: string };

export type PluginError =
  | { type: 'permanent_error'; context?: string }
  | { type: 'prepare_error'; context?: string }
  | { type: 'process_error'; context?: string }
  | { type: 'validation_error'; context?: string }
  | { type: 'execute_error'; context?: string }
  | { type: 'non_error'; context?: string };