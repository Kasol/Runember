import { useEffect, useId, useState } from 'react';
import { client, type AgentInfo } from './api';
import { Modal } from './ui';
import { LogDirectorySettings } from './LogDirectorySettings';

export function AgentSettings({ onClose }: { onClose: () => void }) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true); setError('');
    try { setAgents((await client.agents(true)).details); }
    catch (e) { setError((e as Error).message); }
    finally { setRefreshing(false); }
  };
  useEffect(() => { void refresh(); }, []);
  return <Modal title="环境设置" onClose={onClose} layout="setup">
    <LogDirectorySettings />
    <h4 className="settings-section-title">Agent 执行器</h4>
    <div className="agent-settings-intro"><p>自动检测已安装的 CLI 并选用可用入口，也可以为每个 Agent 指定路径。</p>
      <button disabled={refreshing} onClick={() => void refresh()}>{refreshing ? '检测中…' : '重新检测'}</button></div>
    {error && <p className="form-err" role="alert">{error}</p>}
    <div className="agent-settings-list">{agents.map(agent => <AgentPath key={agent.id} agent={agent} onSaved={value => setAgents(value)} />)}</div>
    <p className="field-help">设置保存在当前 daemon 的数据目录中，保存后对下一轮任务生效。模型在项目的 Agent 设置中选择。</p>
  </Modal>;
}

function AgentPath({ agent, onSaved }: { agent: AgentInfo; onSaved: (agents: AgentInfo[]) => void }) {
  const [path, setPath] = useState(agent.configuredPath ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const id = useId();
  useEffect(() => { setPath(agent.configuredPath ?? ''); }, [agent.configuredPath]);
  const save = async (value: string) => {
    setBusy(true); setError(''); setMessage('');
    try { onSaved((await client.updateAgentPath(agent.id, value)).details); setPath(value); setMessage('已保存，下一轮任务生效'); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <section className="agent-path-card">
    <div className="agent-path-heading"><h4>{agent.label}</h4><span className={`agent-availability ${agent.available ? 'available' : ''}`}>{agent.available ? '已检测到 CLI' : '未检测到 CLI'}</span></div>
    <div className="agent-runtime-note"><span>当前使用</span><code>{agent.executable ?? '暂无可用入口'}</code></div>
    <label htmlFor={id}>执行路径</label>
    <input id={id} list={`${id}-paths`} value={path} disabled={busy} placeholder="留空自动检测；也可输入 CLI 文件的绝对路径" onChange={e => { setPath(e.target.value); setMessage(''); }} />
    <datalist id={`${id}-paths`}>{agent.detectedPaths.map(path => <option key={path} value={path} />)}</datalist>
    {agent.detectedPaths.length > 0 && <select aria-label={`${agent.label} 检测到的路径`} value="" disabled={busy} onChange={e => { setPath(e.target.value); setMessage(''); }}>
      <option value="">选择检测到的路径（{agent.detectedPaths.length}）</option>{agent.detectedPaths.map(path => <option key={path} value={path}>{path}</option>)}</select>}
    <div className="agent-path-actions"><button className="primary" disabled={busy} onClick={() => void save(path)}>保存路径</button>
      <button disabled={busy} onClick={() => void save('')}>恢复自动检测</button>
      {message && <span role="status">{message}</span>}</div>
    {error && <p className="form-err" role="alert">{error}</p>}
  </section>;
}
