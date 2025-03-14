import { type Peer } from '../core/types/Peer';
import yaml from 'yaml';

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