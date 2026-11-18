/** Stdio client for ZCode Protocol. The managed supervisor owns this process and its children. */
export async function zcodeBridgeMain(): Promise<void> {
  const { spawn } = await import('node:child_process');
  const { readFileSync } = await import('node:fs');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const { createInterface } = await import('node:readline');
  const launch = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as {
    command: string[]; cwd: string; prompt: string; sessionId?: string; model?: string; modelOptions?: { reasoningLevel: string };
  };
  const child = spawn(launch.command[0]!, [...launch.command.slice(1), 'app-server', '--stdio'], {
    cwd: launch.cwd, env: process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const write = (value: unknown) => child.stdin.write(JSON.stringify(value) + '\n');
  const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
  let counter = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const request = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const id = ++counter;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`ZCode ${method} timed out`)); }, 30_000);
    pending.set(id, { resolve, reject, timer });
    write({ id, method, params });
  });
  let settle!: () => void;
  const terminal = new Promise<void>(resolve => { settle = resolve; });
  let exitCode = 0;
  let question = false;
  let sessionId: string | undefined;
  let startupError = '';
  let preferences: Record<string, unknown> = {};
  try { preferences = JSON.parse(readFileSync(join(process.env.ZCODE_DATA_BASE_DIR || homedir(), '.zcode', 'v2', 'setting.json'), 'utf8')); } catch {}
  child.stderr.on('data', data => {
    process.stderr.write(data);
    if (!sessionId) startupError = (startupError + data.toString()).slice(-4000);
  });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let frame: any;
    try { frame = JSON.parse(line); } catch { return; }
    if (frame.method && frame.id !== undefined) {
      if (frame.method === 'session/requestRuntimePreferences') {
        write({ id: frame.id, result: { nativeSearchEnhancementsEnabled: preferences.nativeSearchEnhancementsEnabled !== false,
          askUserQuestionAutoResolutionEnabled: false,
          toolSearchMode: ['off', 'auto', 'native', 'local'].includes(String(preferences.toolSearchMode)) ? preferences.toolSearchMode : 'off',
          memoryEnabled: preferences.memoryEnabled === true } });
        return;
      }
      // Optional desktop preferences have a documented compatibility fallback.
      write({ id: frame.id, error: { code: -32601, message: 'Client method unavailable' } });
      return;
    }
    if (typeof frame.id === 'number' && pending.has(frame.id)) {
      const item = pending.get(frame.id)!;
      clearTimeout(item.timer); pending.delete(frame.id);
      if (frame.error) item.reject(new Error(`ZCode: ${frame.error.message}`)); else item.resolve(frame.result);
      return;
    }
    if (frame.method !== 'session/event') return;
    const event = frame.params?.event ?? frame.params;
    if (!event || (sessionId && event.sessionId !== sessionId)) return;
    emit(event);
    if (event.type === 'permission.requested' || event.type === 'userInput.requested') { question = true; settle(); }
    if (event.type === 'turn.failed') { exitCode = 1; settle(); }
    if (event.type === 'turn.completed') settle();
  });
  child.on('error', error => {
    emit({ type: 'turn.failed', payload: { message: error.message } }); exitCode = 1; settle();
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear();
  });
  child.on('exit', code => {
    const reason = !sessionId && startupError.trim() ? `ZCode 启动失败（退出码 ${code}）：${startupError.trim()}` : `ZCode exited (${code})`;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error(reason)); } pending.clear();
    if (code) exitCode = code; settle();
  });
  try {
    const workspace = { workspacePath: launch.cwd, workspaceKey: launch.cwd };
    const slash = launch.model?.indexOf('/') ?? -1;
    if (launch.model && slash <= 0) throw new Error('ZCode 模型请使用 provider/model 格式。');
    const model = launch.model ? { providerId: launch.model.slice(0, slash), modelId: launch.model.slice(slash + 1), ...(launch.modelOptions && { options: launch.modelOptions }) } : undefined;
    const created = launch.sessionId
      ? await request('session/resume', { sessionId: launch.sessionId, workspace })
      : await request('session/create', { workspace, mode: 'yolo', ...(model && { model }), titleGenerationEnabled: false });
    sessionId = launch.sessionId ?? created.sessionId ?? created.session?.id ?? created.session?.sessionId ?? created.id;
    if (!sessionId) throw new Error(`ZCode did not return a session ID (${Object.keys(created).join(',')})`);
    emit({ type: 'session.created', sessionId, payload: {} });
    await request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' });
    await request('session/send', { sessionId, content: launch.prompt, ...(model && { modelSelection: model }) });
    await terminal;
    if (!question && !exitCode) {
      // A foreground turn may have queued notifications from managed background work.
      for (;;) {
        const snapshot = await request('session/read', { sessionId });
        const active = snapshot.runtime?.activeTurnId || ['running', 'pending', 'queued'].includes(snapshot.projection?.status)
          || snapshot.projection?.backgroundJobs?.some((job: any) => ['running', 'pending', 'queued', 'waiting'].includes(job.status));
        if (question || exitCode || !active) break;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    if (question) await request('session/stop', { sessionId }).catch(() => {});
    await request('session/close', { sessionId }).catch(() => {});
  } catch (error) {
    emit({ type: 'turn.failed', payload: { message: (error as Error).message } });
    exitCode = 1;
  } finally {
    child.stdin.end();
    // The supervisor confirms and stops remaining descendants after the bridge exits.
    setTimeout(() => process.exit(exitCode), 1000);
  }
}
