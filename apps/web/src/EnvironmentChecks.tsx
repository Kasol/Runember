import type { EnvironmentCheck } from '@agentdesk/core';

export interface EnvironmentRow extends EnvironmentCheck {
  name: string;
  detail: string;
  evidence?: Array<{ source: string; text: string }>;
  suggestions?: string[];
}

/** Tools share one row across the diagnostic center and project checks. */
export function EnvironmentChecks({ rows }: { rows: EnvironmentRow[] }) {
  return <ul className="environment-checks">{rows.map((row, index) => <li className={`environment-check ${row.ok ? 'passed' : 'failed'}`} key={`${row.name}-${index}`}>
    <div className="check-identity"><span className="check-result" aria-label={row.ok ? '正常' : '失败'}>{row.ok ? '✅ 正常' : '❌ 失败'}</span><strong>{row.name}</strong></div>
    <span className="check-version">{row.version ? row.version.replace(/^codex(?:-cli)?\s+/i, '') : row.path && /CLI|Git/.test(row.name) ? '版本未提供' : ''}</span>
    <div className="check-location">{row.path ? <code>{row.path}</code> : row.detail}</div>
    <span className="check-auth">{row.status}</span>
    {(!row.ok && row.path || !!row.evidence?.length || !!row.suggestions?.length) && <div className="check-support">
      {!row.ok && row.path && <p>{row.detail}</p>}
      {row.evidence?.map((item, i) => <div className="diagnostic-evidence" key={i}><span>{item.source}</span><pre>{item.text}</pre></div>)}
      {!!row.suggestions?.length && <ul>{row.suggestions.map((item, i) => <li key={i}>{item}</li>)}</ul>}
    </div>}
  </li>)}</ul>;
}
