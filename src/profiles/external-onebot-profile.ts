import type { ExtensionCommandHandler, ExtensionCommandMetadata } from '@glimmer-cradle/extension-sdk';
import type { AdapterProfileRuntime, AdapterProfileSnapshot, OneBotEndpointConfig } from './types';

export class ExternalOneBotProfile implements AdapterProfileRuntime {
  public readonly mode = 'external_onebot' as const;

  public constructor(private readonly endpoint: OneBotEndpointConfig) {}

  public start(): void {}

  public async dispose(): Promise<void> {}

  public onOneBotReady(): void {}

  public async getSnapshot(): Promise<AdapterProfileSnapshot> {
    return {
      mode: this.mode,
      endpoint: toEndpoint(this.endpoint),
    };
  }

  public registerManagementCommands(
    _registerCommand: (
      commandId: string,
      handler: ExtensionCommandHandler,
      metadata?: ExtensionCommandMetadata,
    ) => void,
  ): void {}
}

function toEndpoint(endpoint: OneBotEndpointConfig): string {
  return `ws://${endpoint.host}:${endpoint.port}${endpoint.path}`;
}
