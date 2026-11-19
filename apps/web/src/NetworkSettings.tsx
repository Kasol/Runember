import { useEffect, useState } from 'react';
import { client, type NetworkSettings as Settings } from './api';

export function NetworkSettings() {
  const [settings, setSettings] = useState<Settings>();
  const [custom, setCustom] = useState(false);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    client.networkSettings().then(s => { if (active) { setSettings(s); setCustom(s.mode === 'custom'); setUrl(s.url); } }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, []);
  const act = async (test: boolean) => {
    setBusy(true); setError(''); setMessage('');
    try {
      if (test) {
        const result = await client.testNetwork(custom ? url : '');
        if (result.ok) setMessage(result.message); else setError(result.message);
      } else {
        const saved = await client.updateNetwork(custom ? url : '');
        setSettings(saved); setCustom(saved.mode === 'custom'); setUrl(saved.url);
        setMessage('已保存，下一轮宿主任务生效。');
      }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <section className="agent-path-card network-settings">
    <h4>Agent 网络代理</h4>
    {settings && <div className="agent-runtime-note"><span>当前生效地址</span><code>{settings.httpsProxy || '未指定代理（沿用进程环境）'}{settings.httpProxy && settings.httpProxy !== settings.httpsProxy ? `\nHTTP：${settings.httpProxy}` : ''}</code></div>}
    <label htmlFor="native-proxy-mode">代理方式</label>
    <select id="native-proxy-mode" disabled={!settings || busy} value={custom ? 'custom' : 'inherit'} onChange={e => { setCustom(e.target.value === 'custom'); setMessage(''); setError(''); }}>
      <option value="inherit">沿用启动配置</option><option value="custom">指定代理地址</option>
    </select>
    {custom && <><label htmlFor="native-proxy-url">代理地址</label><input id="native-proxy-url" value={url} placeholder="http://127.0.0.1:7897" disabled={busy} onChange={e => { setUrl(e.target.value); setMessage(''); setError(''); }} /></>}
    <div className="agent-path-actions"><button className="primary" disabled={!settings || busy || custom && !url.trim()} onClick={() => void act(false)}>保存</button>
      <button disabled={!settings || busy || custom && !url.trim()} onClick={() => void act(true)}>{busy ? '处理中…' : '检测连接'}</button></div>
    <p className="field-help">用于宿主 Agent 及其子进程，不修改系统代理。检测 Codex 服务连接，不调用模型。</p>
    {message && <p className="field-help" role="status">{message}</p>}
    {error && <p className="form-err" role="alert">{error}</p>}
  </section>;
}
