import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import winston from 'winston';
import LokiTransport from 'winston-loki';
import config from '../config';

// Get environment label from env vars
const environment = process.env.ENVIRONMENT || 'development';

// Create a new Prometheus Registry with default labels
export const register = new Registry();
register.setDefaultLabels({
  environment,
  service: 'decentralized-oracle',
  job: config.id
});

// Enable default metrics collection
collectDefaultMetrics({ register });

export const blockHeightGauge = new Gauge({
  name: 'latest_block_height',
  help: 'Latest processed block height per chain and contract',
  labelNames: ['chain', 'chain_code'],
  registers: [register],
});

// Solana Balance Updater specific metrics
export const solanaBalanceUpdateDuration = new Histogram({
  name: 'solana_balance_update_duration_seconds',
  help: 'Duration of Solana balance update operations',
  labelNames: ['operation', 'status'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120],
  registers: [register],
});

export const solanaTokenLookupErrors = new Counter({
  name: 'solana_token_lookup_errors_total',
  help: 'Total number of token lookup errors by type',
  labelNames: ['error_type', 'token_mint'],
  registers: [register],
});

export const solanaRpcLatency = new Histogram({
  name: 'solana_rpc_latency_seconds',
  help: 'Latency of Solana RPC calls',
  labelNames: ['method', 'status'],
  buckets: [0.05, 0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

export const throttleQueueSize = new Gauge({
  name: 'throttle_queue_size',
  help: 'Current size of the Solana throttle queue',
  labelNames: ['identifier'],
  registers: [register],
});

export const throttleWaitTime = new Histogram({
  name: 'throttle_wait_time_seconds',
  help: 'Wait time for throttled operations',
  labelNames: ['identifier', 'operation'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
  registers: [register],
});

export const txProcessedTotal = new Counter({
  name: 'tx_processed_total',
  help: 'Total number of transactions processed',
  labelNames: ['type'],
  registers: [register],
});

export const rpcCallsTotal = new Counter({
  name: 'rpc_calls_total',
  help: 'Total number of RPC calls',
  labelNames: ['chain', 'chain_code', 'rpc_url'],
  registers: [register],
});

export const completedTasksTotal = new Counter({
  name: 'completed_tasks_total',
  help: 'Total number of tasks completed',
  labelNames: ['plugin_id'],
  registers: [register],
});

export const taskDurationTotal = new Histogram({
  name: 'task_duration_total',
  help: 'Total duration of tasks',
  labelNames: ['plugin_id'],
  registers: [register],
});

// Create Winston logger with Loki transport
export const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { 
    service: 'decentralized-oracle',
    environment 
  },
  transports: process.env.LOKI_URL ? [
    new winston.transports.Console(),
    new LokiTransport({
      host: process.env.LOKI_URL,
      labels: { 
        job: config.id,
        environment 
      },
      json: true,
      format: winston.format.json(),
      replaceTimestamp: true,
      onConnectionError: (err) => console.error(err)
    })
  ] : [
    new winston.transports.Console()
  ],
}); 