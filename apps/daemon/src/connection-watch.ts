import { executionFailure, type RunConnection } from '@agentdesk/core';

/** Observes transport failures; never stops a process or starts a new run. */
export class ConnectionWatch {
  private state?: RunConnection;
  private lastProgress: string;
  private warningSent = false;
  private recoverySent = false;
  constructor(private options: {
    now?: () => number; warningAfterMs?: number;
    changed: (state: RunConnection) => void;
    notify: (kind: 'run.connection_warning' | 'run.connection_recovered', state: RunConnection) => void;
    previous?: RunConnection;
  }) {
    this.state = options.previous;
    this.lastProgress = options.previous?.lastProgressAt ?? this.iso();
    this.warningSent = !!options.previous?.warnedAt;
    this.recoverySent = !!options.previous?.recoveredAt && this.warningSent;
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private iso() { return new Date(this.now()).toISOString(); }
  stderr(text: string): void {
    if (!/analytics|telemetry|MCP|rmcp|plugins|skills|shell_snapshot|models_manager/i.test(text)) this.error(text);
  }
  error(text: string): void {
    const failure = executionFailure(text);
    if (failure?.code !== 'network_failed') return;
    if (this.state?.state === 'retrying') return;
    this.state = { state: 'retrying', since: this.iso(), lastProgressAt: this.lastProgress,
      reason: failure.fingerprint === 'workspace_routing' ? 'Agent 工作区服务路由连接失败' : 'Agent 报告网络连接错误',
      ...(this.warningSent ? { warnedAt: this.state?.warnedAt } : {}) };
    this.options.changed(this.state);
  }
  progress(): void {
    this.lastProgress = this.iso();
    if (this.state?.state !== 'retrying') return;
    this.state = { ...this.state, state: 'recovered', lastProgressAt: this.lastProgress, recoveredAt: this.iso() };
    this.options.changed(this.state);
    if (this.warningSent && !this.recoverySent) {
      this.recoverySent = true;
      this.options.notify('run.connection_recovered', this.state);
    }
  }
  tick(): void {
    if (this.state?.state !== 'retrying' || this.warningSent || this.now() - Date.parse(this.state.since) < (this.options.warningAfterMs ?? 120_000)) return;
    this.warningSent = true;
    this.state = { ...this.state, warnedAt: this.iso() };
    this.options.changed(this.state);
    this.options.notify('run.connection_warning', this.state);
  }
}
