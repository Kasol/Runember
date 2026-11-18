import { useEffect, useId, useState } from 'react';
import { client, type AgentInfo } from './api';

export function AgentFields(props: {
  agent: string; model: string; disabled?: boolean;
  onAgent: (agent: string) => void; onModel: (model: string) => void;
}) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [error, setError] = useState('');
  const list = useId();
  useEffect(() => {
    let active = true;
    client.agents().then(value => { if (active) setAgents(value.details); }).catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, []);
  const selected = agents.find(agent => agent.id === props.agent);
  return <div className="agent-fields">
    <div className="labeled"><label htmlFor={`${list}-agent`}>执行 Agent</label>
      <select id={`${list}-agent`} value={props.agent} disabled={props.disabled || !agents.length}
        onChange={event => { props.onAgent(event.target.value); props.onModel(''); }}>
        {agents.length ? agents.map(agent => <option key={agent.id} value={agent.id}>
          {agent.label}{agent.available ? '' : '（未检测到 CLI）'}
        </option>) : <option value={props.agent}>{props.agent}</option>}
      </select>
    </div>
    <div className="labeled"><label htmlFor={`${list}-model`}>模型（可选）</label>
      <input id={`${list}-model`} list={list} value={props.model} disabled={props.disabled}
        placeholder={selected?.defaultModel ? `默认：${selected.defaultModel}` : '留空沿用该 Agent 的配置'}
        onChange={event => props.onModel(event.target.value)} />
      <datalist id={list}>{selected?.models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}</datalist>
      <p className="field-help">留空时沿用 Agent 自身的模型配置。</p>
    </div>
    {selected?.executable && <div className="agent-runtime-note"><span>当前 CLI</span><code>{selected.executable}</code></div>}
    {props.agent === 'zcode' && <p className="dim">ZCode 模型使用「供应商/模型」格式，可从输入框建议中选择。</p>}
    {selected && !selected.available && <p className="form-err">尚未检测到 {selected.label} CLI，请先安装客户端或配置执行路径。</p>}
    {error && <p className="form-err" role="alert">无法读取 Agent 列表：{error}</p>}
  </div>;
}
