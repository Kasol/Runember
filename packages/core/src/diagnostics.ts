export interface DiagnosticFinding {
  code: string;
  level: 'error' | 'warning' | 'info';
  certainty: 'confirmed' | 'possible';
  title: string;
  detail: string;
  evidence: Array<{ source: string; text: string }>;
  suggestions: string[];
}

export interface DiagnosticReport {
  schemaVersion: 1;
  product: 'Runember';
  generatedAt: string;
  scope: 'environment' | 'task';
  platform: { os: string; arch: string; node: string; version: string };
  taskId?: number;
  runId?: number;
  findings: DiagnosticFinding[];
}

/** Reports contain selected evidence, never entire log files or credential files. */
export function redactDiagnosticText(text: string): string {
  return text
    .replace(/(\b(?:cookie|set-cookie)\s*[:=]\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/https?:\/\/[^\s<>"'\\]+/g, value => {
      try {
        const url = new URL(value);
        if (url.username || url.password) { url.username = 'REDACTED'; url.password = ''; }
        for (const key of [...url.searchParams.keys()]) if (/token|secret|password|key|signature|credential|code/i.test(key)) url.searchParams.set(key, 'REDACTED');
        return url.href;
      } catch { return '[URL REDACTED]'; }
    })
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization|cookie|credential)[\w-]*["'\\\s]*[:=]["'\\\s]*)([^\s,"'\\}\]]+)/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]');
}

export function sanitizeDiagnosticReport(report: DiagnosticReport, home?: string): DiagnosticReport {
  const clean = (value: unknown): unknown => typeof value === 'string'
    ? (home ? redactDiagnosticText(value).split(home).join('<HOME>') : redactDiagnosticText(value))
    : Array.isArray(value) ? value.map(clean) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, value]) => [key, clean(value)])) : value;
  return clean(report) as DiagnosticReport;
}

const rules: Array<{ code: string; pattern: RegExp; title: string; detail: string; suggestions: string[] }> = [
  { code: 'port_in_use', pattern: /EADDRINUSE|address already in use|端口.*占用/i,
    title: '后台服务端口已被占用', detail: '启动日志记录了监听端口冲突。',
    suggestions: ['检查是否已有 Runember 后台服务，确认数据目录和运行时一致。', '确认占用进程的归属后再停止旧实例或更改端口。'] },
  { code: 'provider_config_missing', pattern: /无法定位.*Provider Config|供应商配置不存在|provider.*config.*(?:not found|missing)|Missing provider runtime paths/i,
    title: 'Agent 供应商配置缺失或路径不正确', detail: 'Agent 在建立模型连接前无法读取所需配置。',
    suggestions: ['在环境设置中重新检测 Agent 的 CLI 路径。', '在该 Agent 客户端完成供应商配置和登录；保留原有用户配置。', '如果 Agent 本身可以正常启动，更新 Runember 后重试。'] },
  { code: 'authentication_failed', pattern: /auth_missing|未登录|无法确认登录|not.authenticated|invalid.api.key|authentication.failed|unauthorized|HTTP\s*401/i,
    title: 'Agent 或通知渠道认证失败', detail: '运行记录中存在明确的认证错误。',
    suggestions: ['使用运行后台服务的系统账号，在对应 Agent 中重新登录。', '如果错误来自通知渠道，检查机器人或文档授权；不要把密钥贴进任务提示词。'] },
  { code: 'permission_denied', pattern: /EACCES|EPERM|access.*denied|permission denied|拒绝访问|无权访问/i,
    title: '文件或执行权限不足', detail: '运行时访问文件、目录或启动进程被系统拒绝。',
    suggestions: ['检查出错路径是否可访问、可写，以及 CLI 是否可执行。', '核对后台服务的运行账号；先保留工作区现场，再处理具体权限。'] },
  { code: 'network_failed', pattern: /ECONNRESET|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|TLS|SSL|fetch failed|connection.*(?:failed|reset)|网络.*(?:失败|超时)/i,
    title: '外部连接异常', detail: '日志包含网络、DNS、代理或 TLS 连接错误；具体原因仍需结合目标服务确认。',
    suggestions: ['检查对应服务能否连接，以及当前代理设置是否有效。', '区分模型服务、MCP 和通知连接；先检查错误证据中的来源。'] },
  { code: 'executable_missing', pattern: /ENOENT|未发现.*CLI|找不到.*CLI|not recognized|command not found|executable.*not found/i,
    title: '执行入口或依赖未找到', detail: '运行记录显示执行入口或其依赖不存在。',
    suggestions: ['打开环境设置，检测或手动选择实际 CLI 文件。', '安装对应 Agent 后完成登录，再运行环境诊断。'] },
];

export function classifyDiagnosticError(text: string, source: string): DiagnosticFinding | undefined {
  const match = rules.find(rule => rule.pattern.test(text));
  if (!match) return;
  const line = text.split(/\r?\n/).find(line => match.pattern.test(line)) ?? text;
  return { code: match.code, level: 'error', certainty: match.code === 'network_failed' ? 'possible' : 'confirmed',
    title: match.title, detail: match.detail, suggestions: match.suggestions,
    evidence: [{ source, text: redactDiagnosticText(line).slice(0, 1400) }] };
}
