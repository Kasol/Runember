export const AUTH_ERROR = /\bauth_missing\b|凭证缺失|\bunauthorized\b|not[ _-]authenticated|not logged in|未登录|无法确认登录|invalid[ _-]api[ _-]key|authentication[ _-]failed|(?:\bHTTP(?:\/[\d.]+)?\s+(?:status\s*[:=]?\s*)?|\bstatus(?:_?code)?["']?\s*[:=]\s*)401\b|\b401\s+unauthorized\b/i;
export const QUOTA_ERROR = /(?:\bHTTP(?:\/[\d.]+)?\s+(?:status\s*[:=]?\s*)?|\bstatus(?:_?code)?["']?\s*[:=]\s*)429\b|\b429\s+too many requests\b|\busage limit\b|\brate[ _-]limit|\bquota\b|额度|exceeded your/i;
export const NETWORK_ERROR = /workspace routing discovery failed|request timed out|ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|fetch failed|stream disconnected|connection.*(?:failed|reset|refused|timed out)|\b(?:TLS|SSL)\b.*(?:error|failed|reset)|网络.*(?:失败|超时)/i;

export interface ExecutionFailure {
  code: 'network_failed' | 'authentication_failed' | 'rate_limited';
  fingerprint: string;
  message: string;
}

/** Decode only error fields. Never classify a numeric substring inside an opaque ID. */
export function executionErrorMessage(text: string): string {
  try {
    const e = JSON.parse(text);
    const message = e?.error?.message ?? e?.message ?? e?.payload?.message ?? e?.item?.message;
    if (typeof message === 'string') return message;
  } catch {}
  return text;
}

export function executionFailure(text: string): ExecutionFailure | undefined {
  const message = executionErrorMessage(text);
  try {
    const e = JSON.parse(text);
    const status = e?.status ?? e?.status_code ?? e?.statusCode ?? e?.error?.status ?? e?.error?.status_code;
    if (status === 401 || status === '401') return { code: 'authentication_failed', fingerprint: 'authentication_failed', message };
    if (status === 429 || status === '429') return { code: 'rate_limited', fingerprint: 'rate_limited', message };
  } catch {}
  if (AUTH_ERROR.test(message)) return { code: 'authentication_failed', fingerprint: 'authentication_failed', message };
  if (QUOTA_ERROR.test(message)) return { code: 'rate_limited', fingerprint: 'rate_limited', message };
  if (NETWORK_ERROR.test(message)) {
    const fingerprint = /workspace routing discovery failed/i.test(message) ? 'workspace_routing'
      : /ECONNREFUSED|connection.*refused/i.test(message) ? 'connection_refused'
        : /ENOTFOUND|EAI_AGAIN/i.test(message) ? 'dns_failed'
          : /timed out|ETIMEDOUT/i.test(message) ? 'network_timeout' : 'network_connection';
    return { code: 'network_failed', fingerprint, message };
  }
}

export function failureHint(failure: ExecutionFailure, english = false): string {
  if (failure.code === 'network_failed') return english ? 'Check the Agent proxy and connection before continuing the original session.' : '先在环境设置检查 Agent 代理和连接，再继续原会话。';
  if (failure.code === 'authentication_failed') return english ? 'Verify the Agent account before continuing.' : '先在对应 Agent 中核对账号，再继续任务。';
  return english ? 'Check the provider quota or rate limit before continuing.' : '先检查供应商额度或请求限制，再继续任务。';
}
