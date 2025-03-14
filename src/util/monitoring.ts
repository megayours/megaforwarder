import { collectDefaultMetrics, Registry } from 'prom-client';
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