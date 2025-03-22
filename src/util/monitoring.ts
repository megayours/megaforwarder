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