import type { ListenerConfig } from '../core/types/config/Listener';
import type { AbstractionChain } from '../core/types/config/AbstractionChain';
import type { Rpcs } from '../core/types/config/Rpc';
import { type Peer } from '../core/types/config/Peer';
import type { WebhookConfig } from '../core/types/config/Webhook';
import yaml from 'yaml';
import type { AuthConfig } from '../core/types/config/AuthConfig';

// Define a type for listener-specific settings, including batchSize
type ListenerSpecificConfig = {
  [key: string]: unknown;
  batchSize?: number; // Optional batch size per listener type
};

/**
 * Configuration for an oracle instance
 */
export type OracleConfigOptions = {
  id: string;
  privateKey: string;
  publicKey: string;
  port: number;
  host: string;
  apiPort: number;
  primary: boolean;
  abstractionChain: AbstractionChain;
  rpc: Rpcs;
  webhooks: WebhookConfig;
  auth: AuthConfig;
  /** General listener configuration (e.g., polling intervals) */
  listener: ListenerConfig; // Keep this for general listener settings if any
  /** Specific configurations for plugins */
  plugins: Record<string, Record<string, Record<string, unknown>>>;
  /** Specific configurations for listeners, now including batchSize */
  listeners: Record<string, ListenerSpecificConfig>; // Updated type
  peers?: Peer[];
  peerTimeoutMs?: number;
  minSignaturesRequired?: number;
  dataDirectory?: string;
};

/**
 * Class for managing oracle configuration
 */
export class OracleConfig {
  id: string;
  privateKey: string;
  publicKey: string;
  port: number;
  host: string;
  apiPort: number;
  primary: boolean;
  abstractionChain: AbstractionChain;
  rpc: Rpcs;
  webhooks: WebhookConfig;
  auth: AuthConfig;
  listener: ListenerConfig; // General listener settings
  plugins: Record<string, Record<string, Record<string, unknown>>>;
  listeners: Record<string, ListenerSpecificConfig>; // Listener-specific settings
  peers: Peer[];
  peerTimeoutMs: number;
  minSignaturesRequired: number;

  constructor(options: OracleConfigOptions) {
    this.id = options.id;

    this.privateKey = options.privateKey;
    this.publicKey = options.publicKey;

    this.port = options.port;
    this.host = options.host;
    this.apiPort = options.apiPort;
    this.primary = options.primary;
    this.abstractionChain = options.abstractionChain;
    this.rpc = options.rpc;
    this.webhooks = options.webhooks;
    this.auth = options.auth;
    this.listener = options.listener; // Assign general listener config
    this.plugins = options.plugins;
    this.listeners = options.listeners; // Assign specific listener config
    this.peers = options.peers || [];
    this.peerTimeoutMs = options.peerTimeoutMs || 30000; // 30 seconds default
    this.minSignaturesRequired = options.minSignaturesRequired || 0; // Default to 0 signatures (adjust as needed)
  }

  /**
   * Load configuration from a file
   */
  static async load(filePath: string): Promise<OracleConfig> {
    const fileContent = await Bun.file(filePath).text();
    let options: OracleConfigOptions;

    // Determine file format based on extension
    if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
      options = yaml.parse(fileContent) as OracleConfigOptions;
    } else {
      options = JSON.parse(fileContent) as OracleConfigOptions;
    }

    // Ensure listeners object exists if not provided in the file
    options.listeners = options.listeners ?? {};

    return new OracleConfig(options);
  }
} 