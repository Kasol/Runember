import { useEffect, useState } from 'react';
import { sanitizeDiagnosticReport, type DiagnosticReport } from '@agentdesk/core';
import { client } from './api';

export function Diagnostics({ task, run }: { task?: number; run?: number }) {
  const [report, setReport] = useState<DiagnosticReport>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(false);
  const check = async () => {
    setBusy(true); setError('');
    try { setReport(await client.diagnose(task, run)); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  useEffect(() => { void check(); }, [task, run]);
  const text = report ? JSON.stringify(sanitizeDiagnosticReport(report), null, 2) : '';
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `runember-diagnostics${task ? '-task-' + task : ''}${run ? '-run-' + run : ''}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section className="diagnostics">
    <div className="row"><button className="primary" disabled={busy} onClick={() => void check()}>{busy ? '诊断中…' : '重新诊断'}</button>
      {report && <button onClick={() => setPreview(!preview)}>预览导出报告</button>}</div>
    <p className="field-help">只读取运行事实和错误证据，不执行修复，不修改任务状态。报告不包含完整提示词、代码或凭证文件。</p>
    {error && <p className="form-err" role="alert">{error}。后台服务无法连接时，可在本机运行 <code>desk doctor --json</code>。</p>}
    {report && <><p className="field-help">{report.product} · {report.platform.os} / {report.platform.arch}{report.runId ? ' · Run #' + report.runId : ''} · {new Date(report.generatedAt).toLocaleString()}</p>
      {report.findings.map((finding, index) => <article className={`diagnostic-finding ${finding.level}`} key={`${finding.code}-${index}`}>
        <strong>{finding.level === 'error' ? '❌' : finding.level === 'warning' ? '⚠️' : 'ℹ️'} {finding.title}{finding.certainty === 'possible' ? '（需进一步确认）' : ''}</strong>
        <p>{finding.detail}</p>
        {finding.evidence.map((evidence, i) => <div className="diagnostic-evidence" key={i}><span>{evidence.source}</span><pre>{evidence.text}</pre></div>)}
        {finding.suggestions.length > 0 && <ul>{finding.suggestions.map((suggestion, i) => <li key={i}>{suggestion}</li>)}</ul>}
      </article>)}
      {preview && <div className="diagnostic-preview"><p>请检查报告内容后再分享给他人。下载只保存到本机。</p><pre>{text}</pre><button onClick={download}>下载诊断报告</button></div>}
    </>}
  </section>;
}
