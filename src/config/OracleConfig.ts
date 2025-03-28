import type { ListenerConfig } from '../core/types/config/Listener';
import type { AbstractionChain } from '../core/types/config/AbstractionChain';
import type { Rpcs } from '../core/types/config/Rpc';
import { type Peer } from '../core/types/config/Peer';
import type { WebhookConfig } from '../core/types/config/Webhook';
import yaml from 'yaml';
import type { AuthConfig } from '../core/types/config/AuthConfig';

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
  listener: ListenerConfig;
  plugins: Record<string, Record<string, Record<string, unknown>>>;
  listeners: Record<string, Record<string, Record<string, unknown>>>;
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
  listener: ListenerConfig;
  plugins: Record<string, Record<string, Record<string, unknown>>>;
  listeners: Record<string, Record<string, Record<string, unknown>>>;
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
    this.listener = options.listener;
    this.plugins = options.plugins;
    this.listeners = options.listeners;
    this.peers = options.peers || [];
    this.peerTimeoutMs = options.peerTimeoutMs || 30000; // 30 seconds default
    this.minSignaturesRequired = options.minSignaturesRequired || 0; // Default to 2 signatures
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

    return new OracleConfig(options);
  }
} 