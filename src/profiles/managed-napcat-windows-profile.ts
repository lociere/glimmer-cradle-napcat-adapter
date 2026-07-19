import type { ExtensionCommandHandler, ExtensionCommandMetadata, ExtensionLogger } from '@glimmer-cradle/extension-sdk';
import { NapcatWebUiClient } from '../napcat/napcat-webui-client';
import { NapcatProcessController } from '../process/napcat-process-controller';
import type { AdapterProfileRuntime, AdapterProfileSnapshot, ManagedNapcatWindowsProfileOptions } from './types';

export class ManagedNapcatWindowsProfile implements AdapterProfileRuntime {
  public readonly mode = 'managed_napcat_windows' as const;

  private readonly processController: NapcatProcessController;
  private readonly webUiClient: NapcatWebUiClient;
  private readonly endpoint: string;

  public constructor(
    private readonly logger: ExtensionLogger,
    options: ManagedNapcatWindowsProfileOptions,
  ) {
    if (process.platform !== 'win32') {
      throw new Error('managed_napcat_windows 仅支持 Windows x64 Desktop profile。');
    }
    this.processController = new NapcatProcessController(
      logger,
      options.config,
      options.endpoint,
    );
    this.webUiClient = new NapcatWebUiClient(logger, this.processController.getWorkDir());
    this.endpoint = `ws://${options.endpoint.host}:${options.endpoint.port}${options.endpoint.path}`;
  }

  public start(): void {
    this.processController.start();
  }

  public async dispose(): Promise<void> {
    await this.processController.dispose();
  }

  public onOneBotReady(loginInfo?: unknown): void {
    this.processController.markLoginReady(loginInfo);
  }

  public async getSnapshot(): Promise<AdapterProfileSnapshot> {
    return {
      mode: this.mode,
      endpoint: this.endpoint,
      process: this.processController.getSnapshot(),
      webui: await this.webUiClient.getSnapshot(),
    };
  }

  public registerManagementCommands(
    registerCommand: (
      commandId: string,
      handler: ExtensionCommandHandler,
      metadata?: ExtensionCommandMetadata,
    ) => void,
  ): void {
    registerCommand(
      'lociere.napcat-adapter.refreshQrcode',
      () => this.webUiClient.refreshQrcode(),
      { title: 'Refresh NapCat login QR code', category: 'NapCat' },
    );
    registerCommand(
      'lociere.napcat-adapter.quickLogin',
      (uin) => this.webUiClient.quickLogin(String(uin ?? '').trim()),
      { title: 'Quick login NapCat account', category: 'NapCat' },
    );
    registerCommand(
      'lociere.napcat-adapter.setAutoLoginAccount',
      (uin) => this.webUiClient.setAutoLoginAccount(String(uin ?? '').trim()),
      { title: 'Set NapCat auto login account', category: 'NapCat' },
    );
    registerCommand(
      'lociere.napcat-adapter.openWebUi',
      () => this.webUiClient.openWebUi(),
      { title: 'Open NapCat WebUI', category: 'NapCat' },
    );
  }
}
