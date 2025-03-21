export type OracleError =
  | { type: 'permanent_error'; context?: string }
  | { type: 'prepare_error'; context?: string }
  | { type: 'process_error'; context?: string }
  | { type: 'validation_error'; context?: string }
  | { type: 'execute_error'; context?: string }
  | { type: 'non_error'; context?: string }
  | { type: 'plugin_error'; context?: string }
  | { type: 'insufficient_peers'; context?: string }
  | { type: 'timeout'; context?: string };