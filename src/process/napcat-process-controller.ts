import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import type { ExtensionLogger } from '@glimmer-cradle/extension-sdk';
import type { NapcatAdapterConfig } from '../../config/schema';

type ExternalDependencyConfig = NapcatAdapterConfig['external_dependency'];

interface LaunchSpec {
  command: string;
  args: string[];
  cwd: string;
  detached: boolean;
  env: NodeJS.ProcessEnv;
  bootstrap: boolean;
  injectionSensitive: boolean;
  targetQqPath?: string;
  targetQqSource?: 'configured' | 'packaged' | 'system';
  strategy: 'official_direct' | 'official_shell' | 'custom';
}

interface WindowsDirectLaunchPlan {
  mode: 'onekey_shell' | 'app_launcher';
  bootMainPath: string;
  cwd: string;
  args: string[];
  targetQqPath: string;
  targetQqSource: 'configured' | 'packaged' | 'system';
  napcatAppDir: string;
  napcatMainPath: string;
  injectPath?: string;
  loadPath?: string;
  patchPackagePath?: string;
}

export interface NapcatWindowsOneKeyShellLayout {
  bootMainPath: string;
  qqPath: string;
  versionsConfigPath: string;
  versionDir: string;
  appRootDir: string;
  appPackageJsonPath: string;
  napcatAppDir: string;
  napcatMainPath: string;
}

interface OneBotEndpointConfig {
  host: string;
  port: number;
  path: string;
  accessToken: string;
}

export interface NapcatProcessSnapshot {
  state: 'disabled' | 'starting' | 'running' | 'detached' | 'degraded' | 'stopped' | 'error';
  managed: boolean;
  command: string;
  cwd: string;
  workDir: string;
  packageDir: string;
  pid?: number;
  bootstrap: boolean;
  startedAt?: string;
  lastExitCode?: number | null;
  lastExitSignal?: NodeJS.Signals | null;
  lastError?: string;
  ready: boolean;
  launchStrategy?: 'official_direct' | 'official_shell' | 'custom';
  readinessDeadlineAt?: string;
  readinessTimedOut?: boolean;
  preexistingQqProcesses?: ExistingQqProcess[];
  recoveryActions: string[];
}

export interface ExistingQqProcess {
  pid: number;
  startedAt?: string;
  executablePath?: string;
}

export function redactNapcatProcessOutput(text: string): string {
  return text
    .replace(/(WebUi Token:\s*)\S+/giu, '$1[REDACTED]')
    .replace(/(二维码解码URL:\s*)\S+/gu, '$1[REDACTED]')
    .replace(/([?&](?:token|access_token|key|ticket|k)=)[^&\s]+/giu, '$1[REDACTED]');
}

export class NapcatProcessController {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopping = false;
  private state: NapcatProcessSnapshot['state'] = 'disabled';
  private lastCommand = '';
  private lastCwd = '';
  private lastBootstrap = false;
  private lastStartedAt = '';
  private lastExitCode: number | null | undefined;
  private lastExitSignal: NodeJS.Signals | null | undefined;
  private lastError = '';
  private lastLaunchStrategy: LaunchSpec['strategy'] | undefined;
  private ready = false;
  private readinessDeadlineAt = 0;
  private readinessTimer: NodeJS.Timeout | null = null;
  private preexistingQqProcesses: ExistingQqProcess[] = [];
  private conflictingQqProcesses: ExistingQqProcess[] = [];
  private recoveryActions: string[] = [];
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private managedTargetQqPath = '';
  private managedTargetQqSource: LaunchSpec['targetQqSource'];

  constructor(
    private readonly logger: ExtensionLogger,
    private readonly config: ExternalDependencyConfig,
    private readonly onebot: OneBotEndpointConfig,
  ) {}

  start(): void {
    if (!this.config.managed_process_enabled) {
      this.state = 'disabled';
      return;
    }

    if (this.child) return;
    this.state = 'starting';
    this.lastError = '';
    this.lastExitCode = undefined;
    this.lastExitSignal = undefined;
    this.lastLaunchStrategy = undefined;
    this.ready = false;
    this.preexistingQqProcesses = this.detectExistingQqProcesses();
    this.conflictingQqProcesses = [];
    this.recoveryActions = [];
    this.readinessDeadlineAt = Date.now() + this.config.startup_timeout_ms;
    this.clearReadinessTimer();

    const packageDir = this.resolvePackageDir();
    const workDir = this.resolveWorkDir();
    this.prepareWorkDir(packageDir, workDir);
    this.ensureNapcatConfig(workDir);
    this.ensureOneBotConfig(workDir);
    const launch = this.resolveLaunchSpec(packageDir, workDir);
    if (!launch) {
      this.state = 'error';
      this.lastError ||= 'managed process enabled but no launcher was found';
      this.logger.error('[napcat] managed process enabled but no launcher was found', {
        package_dir: packageDir,
      });
      return;
    }

    this.conflictingQqProcesses = this.findConflictingQqProcesses(launch);
    if (
      launch.injectionSensitive &&
      this.conflictingQqProcesses.length > 0 &&
      !this.config.allow_preexisting_qq
    ) {
      this.state = 'degraded';
      this.lastCommand = launch.command;
      this.lastCwd = launch.cwd;
      this.lastBootstrap = launch.bootstrap;
      this.lastLaunchStrategy = launch.strategy;
      this.lastError = '检测到 NapCat 将要注入的 QQ.exe 已在启动前运行，官方 direct 启动可能无法完成注入。';
      this.recoveryActions = buildNapcatStartupRecoveryActions(true, launch.targetQqSource);
      this.logger.warn('[napcat] direct launcher blocked because target QQ is already running', {
        qq_path: launch.targetQqPath,
        qq_source: launch.targetQqSource,
        qq_processes: this.conflictingQqProcesses,
      });
      return;
    }

    if (!fs.existsSync(launch.cwd)) {
      this.state = 'error';
      this.lastError = `managed process cwd does not exist: ${launch.cwd}`;
      this.logger.error('[napcat] managed process cwd does not exist', { cwd: launch.cwd });
      return;
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      const needsShell = process.platform === 'win32' && /\.(bat|cmd)$/iu.test(launch.command);
      child = spawn(launch.command, launch.args, {
        cwd: launch.cwd,
        detached: launch.detached,
        shell: needsShell,
        windowsHide: this.config.window_policy === 'webui_managed',
        env: launch.env,
        stdio: 'pipe',
      });
    } catch (err) {
      this.logger.error('[napcat] managed process failed to start', {
        command: launch.command,
        cwd: launch.cwd,
        error: err instanceof Error ? err.message : String(err),
      });
      this.state = 'error';
      this.lastError = err instanceof Error ? err.message : String(err);
      return;
    }

    this.child = child;
    this.state = launch.bootstrap ? 'detached' : 'running';
    this.lastCommand = launch.command;
    this.lastCwd = launch.cwd;
    this.lastBootstrap = launch.bootstrap;
    this.lastLaunchStrategy = launch.strategy;
    this.lastStartedAt = new Date().toISOString();
    this.managedTargetQqPath = launch.targetQqPath ?? '';
    this.managedTargetQqSource = launch.targetQqSource;
    this.scheduleReadinessTimeout();

    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    child.stdout.on('data', (chunk: Buffer) => this.consumeProcessOutput('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => this.consumeProcessOutput('stderr', chunk));
    child.stdout.on('end', () => this.flushProcessOutput('stdout'));
    child.stderr.on('end', () => this.flushProcessOutput('stderr'));
    child.on('error', (error) => {
      this.logger.error('[napcat] managed process error: ' + error.message);
      this.state = 'error';
      this.lastError = error.message;
      if (this.child === child) this.child = null;
    });
    child.on('exit', (code, signal) => {
      this.lastExitCode = code ?? null;
      this.lastExitSignal = signal ?? null;
      const payload = { code: code ?? null, signal: signal ?? null };
      if (this.stopping) {
        this.state = 'stopped';
        this.logger.info('[napcat] managed process stopped', payload);
      } else if (launch.bootstrap && code === 0) {
        this.state = 'detached';
        this.lastError ||= 'NapCat bootstrap 已结束，正在等待 WebUI 或 OneBot readiness 证明注入成功。';
        this.logger.info('[napcat] managed launcher finished; waiting for readiness probes', payload);
      } else {
        this.state = 'stopped';
        this.logger.warn('[napcat] managed process exited', payload);
      }
      if (this.child === child) this.child = null;
    });

    this.logger.info('[napcat] managed process started', {
      command: launch.command,
      cwd: launch.cwd,
      detached: launch.detached,
      args_count: launch.args.length,
      work_dir: launch.env.NAPCAT_WORKDIR,
      window_policy: this.config.window_policy,
      launch_strategy: launch.strategy,
    });

  }

  private consumeProcessOutput(channel: 'stdout' | 'stderr', chunk: Buffer): void {
    const buffer = (channel === 'stdout' ? this.stdoutBuffer : this.stderrBuffer)
      + chunk.toString('utf8');
    const lines = buffer.split(/\r?\n/u);
    const remainder = lines.pop() ?? '';
    if (channel === 'stdout') this.stdoutBuffer = remainder;
    else this.stderrBuffer = remainder;
    for (const line of lines) this.logProcessOutput(channel, line);
  }

  private flushProcessOutput(channel: 'stdout' | 'stderr'): void {
    const text = channel === 'stdout' ? this.stdoutBuffer : this.stderrBuffer;
    if (channel === 'stdout') this.stdoutBuffer = '';
    else this.stderrBuffer = '';
    this.logProcessOutput(channel, text);
  }

  private logProcessOutput(channel: 'stdout' | 'stderr', text: string): void {
    const sanitized = redactNapcatProcessOutput(text.trim());
    if (!sanitized) return;
    const message = `[napcat:process:${channel}] ${sanitized}`;
    if (channel === 'stdout') this.logger.debug(message);
    else this.logger.warn(message);
  }

  async dispose(): Promise<void> {
    this.clearReadinessTimer();
    if (this.stopPromise) return this.stopPromise;

    const child = this.child;
    this.child = null;
    this.stopping = true;

    this.stopPromise = (async () => {
      if (child?.pid && process.platform === 'win32') {
        await terminateWindowsProcessTree(child.pid);
      } else if (child) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (!child.killed) child.kill('SIGKILL');
            resolve();
          }, 3000);
          child.once('exit', () => { clearTimeout(timer); resolve(); });
          try { child.kill('SIGTERM'); } catch { clearTimeout(timer); resolve(); }
        });
      }
      await this.terminateOwnedTargetQqProcesses();
      this.state = 'stopped';
    })();

    try {
      await this.stopPromise;
    } finally {
      this.stopping = false;
      this.stopPromise = null;
    }
  }

  private async terminateOwnedTargetQqProcesses(): Promise<void> {
    if (process.platform !== 'win32' || !this.managedTargetQqPath) return;
    if (this.managedTargetQqSource === 'system') {
      this.logger.warn('[napcat] system QQ target is not force-owned; skip detached process cleanup', {
        qq_path: this.managedTargetQqPath,
      });
      return;
    }
    const preexisting = new Set(this.preexistingQqProcesses.map((item) => item.pid));
    const target = normalizeWindowsPath(this.managedTargetQqPath);
    const owned = this.detectExistingQqProcesses().filter((item) => (
      !preexisting.has(item.pid)
      && item.executablePath
      && normalizeWindowsPath(item.executablePath) === target
    ));
    for (const processInfo of owned) {
      await terminateWindowsProcessTree(processInfo.pid);
      this.logger.info('[napcat] reclaimed managed dedicated QQ process', {
        pid: processInfo.pid,
        qq_path: processInfo.executablePath,
      });
    }
  }

  private scheduleReadinessTimeout(): void {
    this.clearReadinessTimer();
    const delay = Math.max(1, this.readinessDeadlineAt - Date.now());
    this.readinessTimer = setTimeout(() => {
      this.refreshReadinessState();
    }, delay);
    this.readinessTimer.unref?.();
  }

  private clearReadinessTimer(): void {
    if (!this.readinessTimer) return;
    clearTimeout(this.readinessTimer);
    this.readinessTimer = null;
  }

  private refreshReadinessState(): void {
    if (this.ready || !this.isReadinessTimedOut()) return;
    if (this.state !== 'starting' && this.state !== 'detached' && this.state !== 'running') return;
    const hasConflictingQq = this.conflictingQqProcesses.length > 0;
    this.state = 'degraded';
    this.lastError = hasConflictingQq
      ? 'NapCat 启动超时：bootstrap 已发出，但目标 QQ 在启动前已运行，WebUI/OneBot 未证明注入成功。'
      : 'NapCat 启动超时：bootstrap 或进程启动已完成，但 WebUI/OneBot 未在期限内 ready。';
    this.recoveryActions = buildNapcatStartupRecoveryActions(hasConflictingQq);
    this.logger.warn('[napcat] managed startup readiness timeout', {
      deadline_at: new Date(this.readinessDeadlineAt).toISOString(),
      preexisting_qq_processes: this.preexistingQqProcesses,
      conflicting_qq_processes: this.conflictingQqProcesses,
      launch_strategy: this.lastLaunchStrategy,
    });
  }

  private isReadinessTimedOut(): boolean {
    return this.readinessDeadlineAt > 0 && Date.now() >= this.readinessDeadlineAt;
  }

  private resolvePackageDir(): string {
    return this.resolveConfiguredPath(this.config.package_dir.trim(), this.resolveWorkspaceRoot());
  }

  private resolveWorkDir(): string {
    return this.resolveConfiguredPath(this.config.work_dir.trim(), this.resolveWorkspaceRoot());
  }

  getWorkDir(): string {
    return this.resolveWorkDir();
  }

  getSnapshot(): NapcatProcessSnapshot {
    this.refreshReadinessState();
    return {
      state: this.state,
      managed: this.config.managed_process_enabled,
      command: this.lastCommand,
      cwd: this.lastCwd,
      workDir: this.resolveWorkDir(),
      packageDir: this.resolvePackageDir(),
      bootstrap: this.lastBootstrap,
      ...(this.child?.pid ? { pid: this.child.pid } : {}),
      ...(this.lastStartedAt ? { startedAt: this.lastStartedAt } : {}),
      ...(this.lastExitCode !== undefined ? { lastExitCode: this.lastExitCode } : {}),
      ...(this.lastExitSignal !== undefined ? { lastExitSignal: this.lastExitSignal } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ready: this.ready,
      ...(this.lastLaunchStrategy ? { launchStrategy: this.lastLaunchStrategy } : {}),
      ...(this.readinessDeadlineAt ? { readinessDeadlineAt: new Date(this.readinessDeadlineAt).toISOString() } : {}),
      readinessTimedOut: this.isReadinessTimedOut(),
      ...(this.preexistingQqProcesses.length > 0 ? { preexistingQqProcesses: this.preexistingQqProcesses } : {}),
      recoveryActions: [...this.recoveryActions],
    };
  }

  markLoginReady(loginInfo?: unknown): void {
    this.ready = true;
    this.state = 'running';
    this.lastError = '';
    this.recoveryActions = [];
    this.clearReadinessTimer();
    const workDir = this.resolveWorkDir();
    const markerPath = this.resolveLoginMarkerPath(workDir);
    const account = this.extractLoginAccount(loginInfo);
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(
      markerPath,
      `${JSON.stringify({
        ready_at: new Date().toISOString(),
        account,
      }, null, 2)}\n`,
      'utf8',
    );
  }

  private resolveLaunchSpec(packageDir: string, workDir: string): LaunchSpec | null {
    if (this.config.command.trim() || this.config.launch_mode === 'custom') {
      return this.resolveBundledLauncherSpec(packageDir, workDir, 'custom');
    }

    if (process.platform === 'win32' && this.config.launch_mode === 'official_direct') {
      return this.resolveWindowsDirectLaunchSpec(packageDir, workDir);
    }

    return this.resolveBundledLauncherSpec(packageDir, workDir, 'official_shell');
  }

  private resolveBundledLauncherSpec(
    packageDir: string,
    workDir: string,
    strategy: LaunchSpec['strategy'],
  ): LaunchSpec | null {
    const command = this.resolveCommand(packageDir);
    if (!command) return null;

    const cwd = this.resolveCwd(packageDir, command);
    const env = this.buildLaunchEnv(workDir, packageDir);
    if (process.platform === 'win32' && this.config.elevation_mode === 'admin') {
      const elevatedCommand = this.createElevatedLauncher(command, cwd, workDir, this.config.args);
      return {
        command: 'powershell.exe',
        args: [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          this.buildElevatedCommand(elevatedCommand, path.dirname(elevatedCommand), []),
        ],
        cwd: path.dirname(elevatedCommand),
        detached: true,
        env,
        bootstrap: true,
        injectionSensitive: false,
        strategy,
      };
    }

    return {
      command,
      args: this.config.args,
      cwd,
      detached: false,
      env,
      bootstrap: false,
      injectionSensitive: false,
      strategy,
    };
  }

  private resolveWindowsDirectLaunchSpec(packageDir: string, workDir: string): LaunchSpec | null {
    const plan = this.resolveWindowsDirectLaunchPlan(packageDir);
    if (!plan) {
      this.logger.warn('[napcat] direct Windows launcher unavailable', {
        package_dir: packageDir,
        onekey_shell_available: Boolean(resolveNapcatWindowsOneKeyShellLayout(packageDir)),
      });
      this.lastError = 'NapCat official direct launcher 不可用，请安装官方 Windows Shell/OneKey 包，或显式改用 official_shell/custom。';
      this.recoveryActions = [
        '确认 data/packages/managed-resources/lociere.napcat-adapter/napcat 指向 OneKey 根目录，且包含 NapCatWinBootMain.exe、QQ.exe 与 versions/<version>/resources/app/napcat/napcat.mjs。',
        '如果 external_dependency.qq_path 指向外部 QQ，请确认包内 resources/app/napcat 目录包含 NapCatWinBootMain.exe、NapCatWinBootHook.dll、qqnt.json 与 napcat.mjs。',
        '如果必须使用 launcher.bat，请把 external_dependency.launch_mode 显式设为 official_shell。',
      ];
      return null;
    }

    if (plan.loadPath) {
      this.prepareDirectWindowsLaunchFiles(plan.napcatMainPath, plan.loadPath);
    }
    const env = this.buildLaunchEnv(workDir, packageDir, plan);
    const args = [...plan.args, ...this.config.args];

    if (this.config.elevation_mode === 'admin') {
      const scriptPath = this.createElevatedDirectWindowsLauncher(plan, workDir, args, env);
      return {
        command: 'powershell.exe',
        args: [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-WindowStyle',
          'Hidden',
          '-Command',
          this.buildElevatedPowerShellCommand(scriptPath),
        ],
        cwd: path.dirname(scriptPath),
        detached: true,
        env,
        bootstrap: true,
        injectionSensitive: true,
        targetQqPath: plan.targetQqPath,
        targetQqSource: plan.targetQqSource,
        strategy: 'official_direct',
      };
    }

    return {
      command: plan.bootMainPath,
      args,
      cwd: plan.cwd,
      detached: false,
      env,
      bootstrap: true,
      injectionSensitive: true,
      targetQqPath: plan.targetQqPath,
      targetQqSource: plan.targetQqSource,
      strategy: 'official_direct',
    };
  }

  private resolveWindowsDirectLaunchPlan(packageDir: string): WindowsDirectLaunchPlan | null {
    if (!this.config.qq_path?.trim()) {
      const oneKeyLayout = resolveNapcatWindowsOneKeyShellLayout(packageDir);
      if (oneKeyLayout) {
        const preferredAccount = this.resolvePreferredAccountArgument();
        return {
          mode: 'onekey_shell',
          bootMainPath: oneKeyLayout.bootMainPath,
          cwd: packageDir,
          args: preferredAccount ? [preferredAccount] : [],
          targetQqPath: oneKeyLayout.qqPath,
          targetQqSource: 'packaged',
          napcatAppDir: oneKeyLayout.napcatAppDir,
          napcatMainPath: oneKeyLayout.napcatMainPath,
        };
      }
    }

    const appDir = this.resolveNapcatAppLauncherDir(packageDir);
    if (!appDir) return null;

    const bootMainPath = path.join(appDir, 'NapCatWinBootMain.exe');
    const injectPath = path.join(appDir, 'NapCatWinBootHook.dll');
    const napcatMainPath = path.join(appDir, 'napcat.mjs');
    const loadPath = path.join(appDir, 'loadNapCat.js');
    const patchPackagePath = path.join(appDir, 'qqnt.json');
    const qqTarget = this.resolveWindowsQqExecutablePath(packageDir);

    if (
      !fs.existsSync(bootMainPath) ||
      !fs.existsSync(injectPath) ||
      !fs.existsSync(napcatMainPath) ||
      !fs.existsSync(patchPackagePath) ||
      !qqTarget.path
    ) {
      return null;
    }

    const preferredAccount = this.resolvePreferredAccountArgument();
    return {
      mode: 'app_launcher',
      bootMainPath,
      cwd: appDir,
      args: [qqTarget.path, injectPath, ...(preferredAccount ? [preferredAccount] : [])],
      targetQqPath: qqTarget.path,
      targetQqSource: qqTarget.source,
      napcatAppDir: appDir,
      napcatMainPath,
      injectPath,
      loadPath,
      patchPackagePath,
    };
  }

  private resolvePreferredAccountArgument(): string {
    return this.config.preferred_account.trim() || process.env.NAPCAT_QUICK_ACCOUNT?.trim() || '';
  }

  private buildLaunchEnv(
    workDir: string,
    packageDir: string,
    plan?: WindowsDirectLaunchPlan,
  ): NodeJS.ProcessEnv {
    const oneKeyLayout = plan ? null : resolveNapcatWindowsOneKeyShellLayout(packageDir);
    const napcatAppDir = plan?.napcatAppDir
      ?? oneKeyLayout?.napcatAppDir
      ?? this.resolveNapcatAppLauncherDir(packageDir)
      ?? packageDir;
    const launcherPath = plan?.bootMainPath
      ?? oneKeyLayout?.bootMainPath
      ?? path.join(napcatAppDir, 'NapCatWinBootMain.exe');
    const injectPath = plan?.injectPath
      ?? path.join(napcatAppDir, 'NapCatWinBootHook.dll');
    const loadPath = plan?.loadPath
      ?? path.join(napcatAppDir, 'loadNapCat.js');
    const patchPackagePath = plan?.patchPackagePath
      ?? path.join(napcatAppDir, 'qqnt.json');
    const mainPath = plan?.napcatMainPath
      ?? path.join(napcatAppDir, 'napcat.mjs');

    return {
      ...process.env,
      NAPCAT_WORKDIR: workDir,
      NAPCAT_QUICK_ACCOUNT: this.resolvePreferredAccountArgument(),
      NAPCAT_PATCH_PACKAGE: patchPackagePath,
      NAPCAT_LOAD_PATH: loadPath,
      NAPCAT_INJECT_PATH: injectPath,
      NAPCAT_LAUNCHER_PATH: launcherPath,
      NAPCAT_MAIN_PATH: mainPath,
    };
  }

  private resolveCwd(packageDir: string, command: string): string {
    const configured = this.config.cwd.trim();
    if (configured) {
      return this.resolveConfiguredPath(configured, this.resolveWorkspaceRoot());
    }

    if (command.toLowerCase().endsWith('.bat') || command.toLowerCase().endsWith('.cmd')) {
      return path.dirname(command);
    }

    return packageDir;
  }

  private resolveCommand(packageDir: string): string | null {
    const configured = this.config.command.trim();
    if (configured) {
      return path.isAbsolute(configured) ? configured : path.resolve(packageDir, configured);
    }

    const candidates = process.platform === 'win32'
      ? this.resolveWindowsLauncherCandidates(packageDir)
      : [
          path.join(packageDir, 'launcher.sh'),
          path.join(packageDir, 'launcher.bat'),
        ];

    return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
  }

  private resolveWindowsLauncherCandidates(packageDir: string): string[] {
    const appDir = this.resolveNapcatAppLauncherDir(packageDir);
    const inAppDir = (file: string): string => appDir ? path.join(appDir, file) : '';
    const unique = (items: string[]): string[] => [...new Set(items.filter(Boolean))];

    if (this.config.elevation_mode === 'user') {
      return unique([
        path.join(packageDir, 'napcat.bat'),
        path.join(packageDir, 'launcher-user.bat'),
        inAppDir('launcher-user.bat'),
        path.join(packageDir, 'launcher-win10-user.bat'),
        inAppDir('launcher-win10-user.bat'),
        path.join(packageDir, 'launcher.bat'),
        inAppDir('launcher.bat'),
        path.join(packageDir, 'NapCatWinBootMain.exe'),
        inAppDir('NapCatWinBootMain.exe'),
      ]);
    }

    return unique([
      path.join(packageDir, 'napcat.bat'),
      path.join(packageDir, 'launcher.bat'),
      inAppDir('launcher.bat'),
      path.join(packageDir, 'launcher-win10.bat'),
      inAppDir('launcher-win10.bat'),
      path.join(packageDir, 'launcher-user.bat'),
      inAppDir('launcher-user.bat'),
      path.join(packageDir, 'NapCatWinBootMain.exe'),
      inAppDir('NapCatWinBootMain.exe'),
    ]);
  }

  private buildElevatedCommand(command: string, cwd: string, args: string[]): string {
    const argumentList = args.length > 0
      ? args.map((arg) => this.quotePowerShellArgument(arg)).join(' ')
      : '';
    const parts = [
      'Start-Process',
      '-FilePath',
      this.quotePowerShell(command),
      '-WorkingDirectory',
      this.quotePowerShell(cwd),
      '-Verb',
      'RunAs',
      '-WindowStyle',
      this.config.window_policy === 'webui_managed' ? 'Hidden' : 'Normal',
    ];
    if (argumentList) {
      parts.push('-ArgumentList', this.quotePowerShell(argumentList));
    }
    return parts.join(' ');
  }

  private buildElevatedPowerShellCommand(scriptPath: string): string {
    const argumentList = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      this.config.window_policy === 'webui_managed' ? 'Hidden' : 'Normal',
      '-File',
      scriptPath,
    ].map((arg) => this.quotePowerShellArgument(arg)).join(' ');
    return [
      'Start-Process',
      '-FilePath',
      this.quotePowerShell('powershell.exe'),
      '-ArgumentList',
      this.quotePowerShell(argumentList),
      '-Verb',
      'RunAs',
      '-WindowStyle',
      this.config.window_policy === 'webui_managed' ? 'Hidden' : 'Normal',
    ].join(' ');
  }

  private quotePowerShell(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }

  private quotePowerShellArgument(value: string): string {
    return `"${value.replace(/"/g, '\\"')}"`;
  }

  private prepareWorkDir(packageDir: string, workDir: string): void {
    fs.mkdirSync(workDir, { recursive: true });

    const sourceConfigDir = path.join(packageDir, 'config');
    const targetConfigDir = path.join(workDir, 'config');
    if (fs.existsSync(sourceConfigDir) && !fs.existsSync(targetConfigDir)) {
      fs.cpSync(sourceConfigDir, targetConfigDir, { recursive: true });
      this.logger.info('[napcat] migrated package config into state work dir', {
        from: sourceConfigDir,
        to: targetConfigDir,
      });
    }
  }

  private ensureNapcatConfig(workDir: string): void {
    const configPath = path.join(workDir, 'config', 'napcat.json');
    const config = this.readJsonObject(configPath) ?? {};
    const bypass = this.ensureObject(config, 'bypass');
    bypass['window'] = false;
    if (config['fileLog'] === undefined) config['fileLog'] = true;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  }

  private ensureOneBotConfig(workDir: string): void {
    const configDir = path.join(workDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });

    const files = new Set<string>([path.join(configDir, 'onebot11.json')]);
    for (const entry of fs.readdirSync(configDir, { withFileTypes: true })) {
      if (entry.isFile() && /^onebot11_\d+\.json$/u.test(entry.name)) {
        files.add(path.join(configDir, entry.name));
      }
    }

    for (const file of files) {
      this.upsertOneBotClient(file);
    }
  }

  private upsertOneBotClient(file: string): void {
    const config = this.readJsonObject(file) ?? {};
    const network = this.ensureObject(config, 'network');
    const websocketClients = this.ensureArray(network, 'websocketClients');
    const targetClient = this.buildOneBotWebSocketClient();
    const existingIndex = websocketClients.findIndex((item) => (
      item &&
      typeof item === 'object' &&
      (item as Record<string, unknown>)['name'] === targetClient.name
    ));

    if (existingIndex >= 0) {
      websocketClients[existingIndex] = {
        ...(websocketClients[existingIndex] as Record<string, unknown>),
        ...targetClient,
      };
    } else {
      websocketClients.push(targetClient);
    }

    network['httpServers'] ??= [];
    network['httpSseServers'] ??= [];
    network['httpClients'] ??= [];
    network['websocketServers'] ??= [];
    network['plugins'] ??= [];
    config['musicSignUrl'] ??= '';
    config['enableLocalFile2Url'] ??= false;
    config['parseMultMsg'] ??= false;
    config['imageDownloadProxy'] ??= '';
    config['timeout'] ??= {
      baseTimeout: 10000,
      uploadSpeedKBps: 256,
      downloadSpeedKBps: 256,
      maxTimeout: 1800000,
    };

    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    this.logger.info('[napcat] ensured OneBot reverse WebSocket config', {
      file,
      url: targetClient.url,
    });
  }

  private buildOneBotWebSocketClient(): Record<string, unknown> {
    return {
      name: 'glimmer-cradle',
      enable: true,
      url: this.buildOneBotUrl(),
      messagePostFormat: 'array',
      reportSelfMessage: false,
      reconnectInterval: 5000,
      token: this.onebot.accessToken,
      debug: false,
      heartInterval: 30000,
    };
  }

  private buildOneBotUrl(): string {
    const host = this.onebot.host === '0.0.0.0' || this.onebot.host === '::'
      ? '127.0.0.1'
      : this.onebot.host;
    const pathPart = this.onebot.path.startsWith('/') ? this.onebot.path : `/${this.onebot.path}`;
    return `ws://${host}:${this.onebot.port}${pathPart}`;
  }

  private readJsonObject(file: string): Record<string, unknown> | null {
    if (!fs.existsSync(file)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch (err) {
      this.logger.warn('[napcat] JSON file parse failed', {
        file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }

  private ensureObject(target: Record<string, unknown>, key: string): Record<string, unknown> {
    const value = target[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    const next: Record<string, unknown> = {};
    target[key] = next;
    return next;
  }

  private ensureArray(target: Record<string, unknown>, key: string): unknown[] {
    const value = target[key];
    if (Array.isArray(value)) return value;
    const next: unknown[] = [];
    target[key] = next;
    return next;
  }

  private createElevatedLauncher(command: string, cwd: string, workDir: string, args: string[]): string {
    const launcherDir = path.join(workDir, 'managed-launch');
    fs.mkdirSync(launcherDir, { recursive: true });
    const launcherPath = path.join(launcherDir, 'start-napcat.cmd');
    const escapedArgs = args.map((arg) => `"${arg.replace(/"/g, '""')}"`).join(' ');
    const content = [
      '@echo off',
      'chcp 65001 >nul',
      `set "NAPCAT_WORKDIR=${workDir}"`,
      `cd /d "${cwd}"`,
      `call "${command}" ${escapedArgs}`.trim(),
      '',
    ].join('\r\n');
    fs.writeFileSync(launcherPath, content, 'utf8');
    return launcherPath;
  }

  private prepareDirectWindowsLaunchFiles(napcatMainPath: string, loadPath: string): void {
    const mainUrl = pathToFileURL(napcatMainPath).href;
    fs.writeFileSync(loadPath, `(async () => {await import(${JSON.stringify(mainUrl)})})()\n`, 'utf8');
  }

  private createElevatedDirectWindowsLauncher(
    plan: WindowsDirectLaunchPlan,
    workDir: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ): string {
    const launcherDir = path.join(workDir, 'managed-launch');
    fs.mkdirSync(launcherDir, { recursive: true });
    const scriptPath = path.join(launcherDir, 'start-napcat-direct.ps1');
    const envLines = [
      'NAPCAT_WORKDIR',
      'NAPCAT_QUICK_ACCOUNT',
      'NAPCAT_PATCH_PACKAGE',
      'NAPCAT_LOAD_PATH',
      'NAPCAT_INJECT_PATH',
      'NAPCAT_LAUNCHER_PATH',
      'NAPCAT_MAIN_PATH',
    ].map((key) => `$env:${key} = ${this.quotePowerShell(env[key] ?? '')}`);
    const startProcessParts = [
      'Start-Process',
      '-FilePath',
      this.quotePowerShell(plan.bootMainPath),
      '-WorkingDirectory',
      this.quotePowerShell(plan.cwd),
    ];
    const argumentListLine = args.length > 0
      ? `$argumentList = @(${args.map((arg) => this.quotePowerShell(arg)).join(', ')})`
      : '';
    if (args.length > 0) {
      startProcessParts.push('-ArgumentList', '$argumentList');
    }
    startProcessParts.push(
      '-WindowStyle',
      this.config.window_policy === 'webui_managed' ? 'Hidden' : 'Normal',
    );
    const content = [
      '$ErrorActionPreference = "Stop"',
      ...envLines,
      ...(argumentListLine ? [argumentListLine] : []),
      startProcessParts.join(' '),
      '',
    ].join('\r\n');
    fs.writeFileSync(scriptPath, content, 'utf8');
    return scriptPath;
  }

  private resolveNapcatAppLauncherDir(packageDir: string): string {
    if (isNapcatAppLauncherDir(packageDir)) return packageDir;
    return resolveNapcatWindowsOneKeyShellLayout(packageDir)?.napcatAppDir ?? '';
  }

  private resolveWindowsQqExecutablePath(
    packageDir: string,
  ): { path: string; source: 'configured' | 'packaged' | 'system' } {
    const configured = this.config.qq_path?.trim();
    if (configured) {
      const configuredPath = this.resolveConfiguredPath(configured, this.resolveWorkspaceRoot());
      if (fs.existsSync(configuredPath)) return { path: configuredPath, source: 'configured' };
      this.logger.warn('[napcat] configured QQ executable path does not exist', {
        qq_path: configuredPath,
      });
    }

    const packaged = this.resolvePackagedWindowsQqExecutablePath(packageDir);
    if (packaged) return { path: packaged, source: 'packaged' };

    const keys = [
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
      'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
    ];

    for (const key of keys) {
      try {
        const output = execFileSync('reg', ['query', key, '/v', 'UninstallString'], {
          encoding: 'utf8',
          windowsHide: true,
        });
        const uninstallPath = this.parseRegistryStringValue(output);
        if (!uninstallPath) continue;
        const qqPath = path.join(path.dirname(uninstallPath), 'QQ.exe');
        if (fs.existsSync(qqPath)) return { path: qqPath, source: 'system' };
      } catch {
        // Try the next registry key.
      }
    }

    return { path: '', source: 'system' };
  }

  private resolvePackagedWindowsQqExecutablePath(packageDir: string): string {
    const directCandidates = [
      path.join(packageDir, 'QQ.exe'),
      path.join(packageDir, 'QQ', 'QQ.exe'),
      path.join(packageDir, 'QQNT', 'QQ.exe'),
      path.join(packageDir, 'Tencent', 'QQNT', 'QQ.exe'),
    ];
    const direct = directCandidates.find((candidate) => fs.existsSync(candidate));
    if (direct) return direct;

    return this.findFileByName(packageDir, 'QQ.exe', 4);
  }

  private findFileByName(rootDir: string, fileName: string, maxDepth: number): string {
    if (maxDepth < 0 || !fs.existsSync(rootDir)) return '';
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(rootDir, { withFileTypes: true });
    } catch {
      return '';
    }
    for (const entry of entries) {
      const current = path.join(rootDir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
        return current;
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const found = this.findFileByName(path.join(rootDir, entry.name), fileName, maxDepth - 1);
      if (found) return found;
    }
    return '';
  }

  private findConflictingQqProcesses(launch: LaunchSpec): ExistingQqProcess[] {
    if (!launch.injectionSensitive || !launch.targetQqPath) return [];
    return this.preexistingQqProcesses.filter((processInfo) => (
      isQqProcessConflict(processInfo, launch.targetQqPath ?? '', launch.targetQqSource)
    ));
  }

  private detectExistingQqProcesses(): ExistingQqProcess[] {
    if (process.platform !== 'win32') return [];
    try {
      const output = execFileSync('powershell.exe', [
        '-NoProfile',
        '-Command',
        [
          `$items = Get-CimInstance Win32_Process -Filter "name = 'QQ.exe'"`,
          '| Select-Object ProcessId,CreationDate,ExecutablePath;',
          '$items | ConvertTo-Json -Compress',
        ].join(' '),
      ], {
        encoding: 'utf8',
        windowsHide: true,
      }).trim();
      if (!output) return [];
      const parsed = JSON.parse(output) as unknown;
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return rows
        .map((row) => normalizeQqProcess(row))
        .filter((row): row is ExistingQqProcess => Boolean(row));
    } catch (err) {
      this.logger.warn('[napcat] failed to inspect existing QQ processes', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  private parseRegistryStringValue(output: string): string {
    for (const line of output.split(/\r?\n/)) {
      const match = line.match(/UninstallString\s+REG_\w+\s+(.+)$/u);
      if (!match) continue;
      return match[1].trim().replace(/^"|"$/g, '');
    }
    return '';
  }

  private resolveLoginMarkerPath(workDir: string): string {
    return path.join(workDir, 'state', 'login-ready.json');
  }

  private extractLoginAccount(loginInfo: unknown): string {
    if (!loginInfo || typeof loginInfo !== 'object') return '';
    const data = loginInfo as Record<string, unknown>;
    const userId = data['user_id'] ?? data['uin'] ?? data['account'];
    return userId === undefined || userId === null ? '' : String(userId);
  }

  private resolveWorkspaceRoot(): string {
    const configured = process.env.GLIMMER_CRADLE_APP_ROOT?.trim()
      || process.env.GLIMMER_CRADLE_REPO_ROOT?.trim()
      || '';
    if (configured) return path.resolve(configured);

    let current = process.cwd();
    while (true) {
      if (
        fs.existsSync(path.join(current, 'pnpm-workspace.yaml')) ||
        fs.existsSync(path.join(current, '.git'))
      ) {
        return current;
      }
      const parent = path.dirname(current);
      if (parent === current) return process.cwd();
      current = parent;
    }
  }

  private resolveDataRoot(workspaceRoot: string): string {
    const configured = process.env.GLIMMER_CRADLE_DATA_ROOT?.trim();
    return configured ? path.resolve(configured) : path.join(workspaceRoot, 'data');
  }

  private resolveConfiguredPath(value: string, workspaceRoot: string): string {
    if (path.isAbsolute(value)) return value;
    const normalized = value.replace(/\\/g, '/');
    if (normalized === 'data') return this.resolveDataRoot(workspaceRoot);
    if (normalized.startsWith('data/')) {
      return path.resolve(this.resolveDataRoot(workspaceRoot), normalized.slice('data/'.length));
    }
    return path.resolve(workspaceRoot, value);
  }
}

export function resolveNapcatWindowsOneKeyShellLayout(packageDir: string): NapcatWindowsOneKeyShellLayout | null {
  const bootMainPath = path.join(packageDir, 'NapCatWinBootMain.exe');
  const qqPath = path.join(packageDir, 'QQ.exe');
  const versionsConfigPath = path.join(packageDir, 'versions', 'config.json');
  if (!fs.existsSync(bootMainPath) || !fs.existsSync(qqPath) || !fs.existsSync(versionsConfigPath)) {
    return null;
  }

  for (const versionName of resolveNapcatVersionNames(packageDir, versionsConfigPath)) {
    const versionDir = path.join(packageDir, 'versions', versionName);
    const appRootDir = path.join(versionDir, 'resources', 'app');
    const appPackageJsonPath = path.join(appRootDir, 'package.json');
    const napcatAppDir = resolveNapcatAppDirFromPackage(appRootDir, appPackageJsonPath);
    if (!napcatAppDir) continue;
    const napcatMainPath = path.join(napcatAppDir, 'napcat.mjs');
    return {
      bootMainPath,
      qqPath,
      versionsConfigPath,
      versionDir,
      appRootDir,
      appPackageJsonPath,
      napcatAppDir,
      napcatMainPath,
    };
  }

  return null;
}

function resolveNapcatVersionNames(packageDir: string, versionsConfigPath: string): string[] {
  const names: string[] = [];
  try {
    const config = JSON.parse(fs.readFileSync(versionsConfigPath, 'utf8')) as Record<string, unknown>;
    for (const key of ['curVersion', 'baseVersion']) {
      const value = config[key];
      if (typeof value === 'string' && value.trim()) names.push(value.trim());
    }
  } catch {
    // Fall back to directory scanning below.
  }

  const versionsDir = path.join(packageDir, 'versions');
  try {
    for (const entry of fs.readdirSync(versionsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) names.push(entry.name);
    }
  } catch {
    return [...new Set(names)];
  }

  return [...new Set(names)];
}

function resolveNapcatAppDirFromPackage(appRootDir: string, appPackageJsonPath: string): string {
  const mainDir = resolveNapcatMainDirFromPackageJson(appRootDir, appPackageJsonPath);
  if (mainDir && isNapcatAppLauncherDir(mainDir)) return mainDir;

  const defaultDir = path.join(appRootDir, 'napcat');
  if (isNapcatAppLauncherDir(defaultDir)) return defaultDir;

  return '';
}

function resolveNapcatMainDirFromPackageJson(appRootDir: string, appPackageJsonPath: string): string {
  if (!fs.existsSync(appPackageJsonPath)) return '';
  try {
    const parsed = JSON.parse(fs.readFileSync(appPackageJsonPath, 'utf8')) as Record<string, unknown>;
    const main = parsed['main'];
    if (typeof main !== 'string' || !main.trim()) return '';
    const mainPath = path.resolve(appRootDir, main);
    if (path.basename(mainPath).toLowerCase() !== 'napcat.mjs') return '';
    return path.dirname(mainPath);
  } catch {
    return '';
  }
}

function isNapcatAppLauncherDir(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'napcat.mjs')) &&
    fs.existsSync(path.join(dir, 'qqnt.json')) &&
    fs.existsSync(path.join(dir, 'NapCatWinBootMain.exe')) &&
    fs.existsSync(path.join(dir, 'NapCatWinBootHook.dll'));
}

export function buildNapcatStartupRecoveryActions(
  hasConflictingQq: boolean,
  targetQqSource?: 'configured' | 'packaged' | 'system',
): string[] {
  const actions = [
    '确认 NapCat WebUI 与扩展分配的 OneBot 回环端点未被防火墙或其他进程阻断。',
    '检查 data/state/extensions/lociere.napcat-adapter/napcat/config/webui.json 与 onebot11 配置是否仍指向摇篮声明的端口。',
  ];
  if (hasConflictingQq) {
    actions.unshift(
      targetQqSource === 'system'
        ? '当前使用系统 QQ 作为 NapCat 启动目标；请关闭该 QQ，或改用包含内置 QQ 的 NapCat Shell Windows OneKey 包以避免影响日常 QQ。'
        : targetQqSource === 'configured'
          ? '当前配置的 NapCat 专用 QQ 已在运行；请关闭该专用 QQ，或把 external_dependency.qq_path 指向另一个专用 QQ。'
        : '关闭 NapCat 受管包内的 QQ.exe 后，从摇篮重新启动 NapCat Adapter，让官方 direct launcher 重新注入。',
    );
  }
  return actions;
}

export function isQqProcessConflict(
  processInfo: ExistingQqProcess,
  targetQqPath: string,
  targetQqSource?: 'configured' | 'packaged' | 'system',
): boolean {
  if (!targetQqPath) return false;
  const executablePath = processInfo.executablePath
    ? normalizeWindowsPath(processInfo.executablePath)
    : '';
  if (!executablePath) return targetQqSource === 'system';
  return executablePath === normalizeWindowsPath(targetQqPath);
}

function normalizeWindowsPath(value: string): string {
  return path.resolve(value).toLowerCase();
}

function normalizeQqProcess(value: unknown): ExistingQqProcess | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const pid = Number(record['ProcessId']);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const startedAt = parseWmiDate(record['CreationDate']);
  const executablePath = typeof record['ExecutablePath'] === 'string' ? record['ExecutablePath'] : undefined;
  return {
    pid,
    ...(startedAt ? { startedAt } : {}),
    ...(executablePath ? { executablePath } : {}),
  };
}

function parseWmiDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length < 14) return undefined;
  const match = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/u);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second] = match;
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}`).toISOString();
}

function terminateWindowsProcessTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.once('error', () => resolve());
    killer.once('exit', () => resolve());
  });
}
