import { useEffect, useId, useState } from 'react';
import { client, type AgentInfo } from './api';
import { Modal } from './ui';
import { LogDirectorySettings } from './LogDirectorySettings';
import { NetworkSettings } from './NetworkSettings';

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
    <NetworkSettings />
    <h4 className="settings-section-title">Agent 执行器</h4>
    <p className="agent-settings-intro">{refreshing ? '正在查找可用路径…' : '选择已检测到的可用路径；点击「自动选择」会立即应用第一个检测结果。'}</p>
    {error && <p className="form-err" role="alert">{error}</p>}
    <div className="agent-settings-list">{agents.map(agent => <AgentPath key={agent.id} agent={agent} onSaved={value => setAgents(value)} />)}</div>
    <p className="field-help">设置保存在当前 daemon 的数据目录中，保存后对下一轮任务生效。模型在项目的 Agent 设置中选择。</p>
  </Modal>;
}

function AgentPath({ agent, onSaved }: { agent: AgentInfo; onSaved: (agents: AgentInfo[]) => void }) {
  const [path, setPath] = useState(agent.executable ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const id = useId();
  useEffect(() => { setPath(agent.executable ?? ''); }, [agent.executable]);
  const save = async (value: string) => {
    setBusy(true); setError(''); setMessage('');
    try { onSaved((await client.updateAgentPath(agent.id, value)).details); setPath(value); setMessage('已保存，下一轮任务生效'); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const chooseAutomatically = async () => {
    setBusy(true); setError(''); setMessage('');
    try {
      const detected = (await client.agents(true)).details;
      const first = detected.find(item => item.id === agent.id)?.detectedPaths[0];
      if (!first) { onSaved(detected); throw new Error('未检测到可用路径，请先安装对应的 Agent。'); }
      onSaved((await client.updateAgentPath(agent.id, first)).details);
      setPath(first); setMessage('已自动选择并保存，下一轮任务生效');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const choices = [...new Set([agent.executable, ...agent.detectedPaths].filter((value): value is string => !!value))];
  return <section className="agent-path-card">
    <div className="agent-path-heading"><h4>{agent.label}</h4><span className={`agent-availability ${agent.available ? 'available' : ''}`}>{agent.available ? '已检测到 CLI' : '未检测到 CLI'}</span></div>
    <div className="agent-runtime-note"><span>当前路径</span><code>{agent.executable ?? agent.configuredPath ?? '暂无可用入口'}</code></div>
    <label htmlFor={id}>可用路径</label>
    <select id={id} aria-label={`${agent.label} 可用路径`} value={path} title={path} disabled={busy || !choices.length}
      onChange={e => { setPath(e.target.value); setMessage(''); }}>
      {!path && <option value="">{choices.length ? '请选择可用路径' : '暂无可用路径'}</option>}
      {choices.map(value => <option key={value} value={value}>{value}</option>)}
    </select>
    <div className="agent-path-actions"><button className="primary" disabled={busy || !path || path === agent.executable} onClick={() => void save(path)}>保存</button>
      <button disabled={busy} onClick={() => void chooseAutomatically()}>自动选择</button>
      {message && <span role="status">{message}</span>}</div>
    {error && <p className="form-err" role="alert">{error}</p>}
  </section>;
}
