import { useEffect, useState } from 'react';
import { client, type LogSettings } from './api';
import { ProjectFolderPicker } from './ProjectFolderPicker';

export function LogDirectorySettings() {
  const [settings, setSettings] = useState<LogSettings>();
  const [path, setPath] = useState('');
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    let initialized = false;
    const refresh = () => client.logSettings().then(value => {
      if (!active) return;
      setSettings(value);
      if (!initialized) { setPath(value.configuredDir); setError(''); initialized = true; }
    }).catch(e => { if (active && !initialized) setError(e.message); });
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  const save = async (value: string) => {
    setBusy(true); setError(''); setMessage('');
    try {
      const next = await client.updateLogSettings(value);
      setSettings(next); setPath(next.configuredDir);
      setMessage(next.restartRequired ? '已保存，重启后台服务后生效。' : '已保存，当前已使用此目录。');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <section className="agent-path-card log-directory-settings">
    <h4>日志目录</h4>
    {settings && <div className="agent-runtime-note"><span>当前生效目录</span><code>{settings.currentDir}</code></div>}
    <label htmlFor="log-directory">日志位置</label>
    <input id="log-directory" value={path} disabled={!settings || busy} placeholder="日志目录的绝对路径，例如 D:/agentdesk/logs"
      onChange={e => { setPath(e.target.value); setMessage(''); }} />
    <div className="agent-path-actions">
      <button disabled={!settings || busy} onClick={() => setChoosing(true)}>选择文件夹</button>
      <button className="primary" disabled={!settings || busy || !path.trim()} onClick={() => void save(path)}>保存</button>
      <button disabled={!settings || busy} onClick={() => void save('')}>自动选择</button>
    </div>
    {message && <p className="field-help" role="status">{message}</p>}
    {settings?.restartRequired && <p className="log-restart-note">待生效：{settings.configuredDir}（重启后台后生效）</p>}
    {error && <p className="form-err" role="alert">{error}</p>}
    {choosing && <ProjectFolderPicker title="选择日志文件夹" initialPath={settings?.currentDir}
      onSelect={folder => { setPath(folder.path); setMessage(''); setChoosing(false); }} onClose={() => setChoosing(false)} />}
  </section>;
}
