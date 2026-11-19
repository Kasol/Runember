import { useEffect, useId, useState } from 'react';
import { client, type AgentInfo } from './api';
import { reasoningOption, type ReasoningOption } from '@agentdesk/core';

export function AgentFields(props: {
  agent: string; model: string; reasoningEffort: string; disabled?: boolean;
  onAgent: (agent: string) => void; onModel: (model: string) => void; onReasoningEffort: (effort: string) => void;
}) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [error, setError] = useState('');
  const [reasoning, setReasoning] = useState<ReasoningOption[]>([]);
  const [reasoningLoading, setReasoningLoading] = useState(true);
  const [reasoningError, setReasoningError] = useState('');
  const list = useId();
  useEffect(() => {
    let active = true;
    client.agents().then(value => { if (active) setAgents(value.details); }).catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let active = true;
    setReasoning([]); setReasoningLoading(true); setReasoningError('');
    const timer = setTimeout(() => void client.reasoningOptions(props.agent, props.model.trim())
      .then(value => { if (active) setReasoning(value.options); })
      .catch((e: Error) => { if (active) setReasoningError(e.message); })
      .finally(() => { if (active) setReasoningLoading(false); }), 150);
    return () => { active = false; clearTimeout(timer); };
  }, [props.agent, props.model]);
  const selected = agents.find(agent => agent.id === props.agent);
  return <div className="agent-fields">
    <div className="labeled"><label htmlFor={`${list}-agent`}>执行 Agent</label>
      <select id={`${list}-agent`} value={props.agent} disabled={props.disabled || !agents.length}
        onChange={event => { props.onAgent(event.target.value); props.onModel(''); props.onReasoningEffort(''); }}>
        {agents.length ? agents.map(agent => <option key={agent.id} value={agent.id}>
          {agent.label}{agent.available ? '' : '（未检测到 CLI）'}
        </option>) : <option value={props.agent}>{props.agent}</option>}
      </select>
    </div>
    <div className="labeled"><label htmlFor={`${list}-model`}>模型（可选）</label>
      <input id={`${list}-model`} list={list} value={props.model} disabled={props.disabled}
        placeholder={selected?.defaultModel ? `默认：${selected.defaultModel}` : '留空沿用该 Agent 的配置'}
        onChange={event => { props.onModel(event.target.value); props.onReasoningEffort(''); }} />
      <datalist id={list}>{selected?.models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}</datalist>
      <p className="field-help">留空时沿用 Agent 自身的模型配置。</p>
    </div>
    <div className="labeled"><label htmlFor={`${list}-reasoning`}>推理强度</label>
      <select id={`${list}-reasoning`} value={props.reasoningEffort} disabled={props.disabled || reasoningLoading}
        onChange={event => props.onReasoningEffort(event.target.value)}>
        <option value="">沿用 Agent 配置</option>
        {props.reasoningEffort && !reasoning.some(item => item.id === props.reasoningEffort) && <option value={props.reasoningEffort}>{reasoningOption(props.reasoningEffort).label}（已保存，待核对）</option>}
        {reasoning.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
      <p className="field-help">{reasoningLoading ? '正在读取模型支持的选项…' : reasoningError ? `无法读取推理选项：${reasoningError}` : reasoning.length ? '只对本项目的新任务生效，不修改 Agent 全局配置。' : '当前模型未提供可选推理强度，可沿用 Agent 配置。'}</p>
    </div>
    {selected?.executable && <div className="agent-runtime-note"><span>当前 CLI</span><code>{selected.executable}</code></div>}
    {props.agent === 'zcode' && <p className="dim">ZCode 模型使用「供应商/模型」格式，可从输入框建议中选择。</p>}
    {selected && !selected.available && <p className="form-err">尚未检测到 {selected.label} CLI，请先安装客户端或配置执行路径。</p>}
    {error && <p className="form-err" role="alert">无法读取 Agent 列表：{error}</p>}
  </div>;
}
