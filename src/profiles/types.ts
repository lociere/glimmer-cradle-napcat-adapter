import type { ExtensionCommandHandler, ExtensionCommandMetadata } from '@glimmer-cradle/extension-sdk';
import type { ManagedNapcatWindowsConfig, NapcatAdapterProfileMode } from '../../config/schema';
import type { OneBotBridgeSessionSnapshot } from '../connection/onebot-bridge-session';
import type { NapcatProcessSnapshot } from '../process/napcat-process-controller';
import type { NapcatWebUiSnapshot } from '../napcat/napcat-webui-client';

export interface OneBotEndpointConfig {
  host: string;
  port: number;
  path: string;
  accessToken: string;
}

export type AdapterProfileSnapshot =
  | {
      mode: 'external_onebot';
      endpoint: string;
    }
  | {
      mode: 'managed_napcat_windows';
      endpoint: string;
      process: NapcatProcessSnapshot;
      webui: NapcatWebUiSnapshot;
    };

export interface AdapterProfileRuntime {
  readonly mode: NapcatAdapterProfileMode;
  start(): void;
  dispose(): Promise<void>;
  onOneBotReady(loginInfo?: unknown): void;
  getSnapshot(): Promise<AdapterProfileSnapshot>;
  registerManagementCommands(
    registerCommand: (
      commandId: string,
      handler: ExtensionCommandHandler,
      metadata?: ExtensionCommandMetadata,
    ) => void,
  ): void;
}

export interface ManagedNapcatWindowsProfileOptions {
  config: ManagedNapcatWindowsConfig;
  endpoint: OneBotEndpointConfig;
}

export interface RuntimeProjectionInput {
  profile: AdapterProfileSnapshot;
  onebot: OneBotBridgeSessionSnapshot;
  replyEnabled: boolean;
  updatedAt: string;
}

export type AdapterProfileMode = NapcatAdapterProfileMode;
