import { useEffect, useMemo, useState } from 'react';
import { ApiError, client, setApiToken, taskStatusMeta, type Project, type Task, type ProjectFolder } from './api';
import { agentLabel, readRunSummary, runStage, runTiming, TASK_STATE_LABELS, type TaskState } from '@agentdesk/core';
import { Modal, Labeled, FormActions } from './ui';
import { ProjectFolderPicker } from './ProjectFolderPicker';
import { RunLogViewer } from './RunLogViewer';
import { DingTalkSettings } from './DingTalkSettings';
import { AgentFields } from './AgentFields';
import { AgentSettings } from './AgentSettings';
import { Onboarding, hasSeenOnboarding } from './Onboarding';
import { Diagnostics } from './Diagnostics';
import { EnvironmentChecks, type EnvironmentRow } from './EnvironmentChecks';

type Scope = number | 'all';
const boardColumns = [
  { state: 'queued', tone: 'warn' },
  { state: 'running', tone: 'active' },
  { state: 'awaiting_confirmation', tone: 'warn' },
  { state: 'ended', tone: 'settled' },
  { state: 'cancelled', tone: 'settled' },
] satisfies Array<{ state: TaskState; tone: string }>;

/** 项目主导视图：顶部项目选择条和任务看板 */
export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [drafts, setDrafts] = useState<Task[]>([]);
  const [selected, setSelected] = useState<Scope>('all');
  const [selectedTask, setSelectedTask] = useState<number | null>(() => {
    const id = Number(new URLSearchParams(location.search).get('task'));
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  });
  const [error, setError] = useState('');
  const [unauthorized, setUnauthorized] = useState(false);
  const [token, setToken] = useState('');
  const [showSetup, setShowSetup] = useState(false);
  const [showDingTalk, setShowDingTalk] = useState(false);
  const [showAgents, setShowAgents] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [guideDismissed, setGuideDismissed] = useState(false);
  const openTask = (id: number | null) => {
    const url = new URL(location.href);
    if (id) url.searchParams.set('task', String(id));
    else url.searchParams.delete('task');
    history.replaceState(null, '', url);
    setSelectedTask(id);
  };

  const refresh = async () => {
    try {
      const [p, t, dr] = await Promise.all([client.projects(), client.tasks(), client.drafts()]);
      setProjects(p.projects);
      setTasks(t.tasks);
      setDrafts(dr.drafts);
      setError('');
      setUnauthorized(false);
      setLoaded(true);
    } catch (e: any) {
      setUnauthorized(e instanceof ApiError && e.status === 401);
      setError(e?.message ?? '无法连接 daemon');
    }
  };

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, []);

  // 项目首次加载后默认选中第一个（项目主导）
  useEffect(() => {
    if (projects.length && selected === 'all' && !localStorage.getItem('agentdesk.scope-touched')) {
      setSelected(projects[0]!.id);
    }
  }, [projects, selected]);

  useEffect(() => {
    if (loaded && !error && !selectedTask && !guideDismissed && !hasSeenOnboarding()) setShowGuide(true);
  }, [loaded, error, selectedTask, guideDismissed]);
  const currentProject = projects.find(project => project.id === selected);

  const scope = (list: Task[]) =>
    selected === 'all' ? list : list.filter(t => t.project_id === selected);

  const scopedDrafts = selected === 'all' ? drafts : drafts.filter(d => d.project_id === selected);
  const scoped = scope(tasks);

  const projectName = useMemo(
    () => new Map(projects.map(p => [p.id, p.name])),
    [projects],
  );

  const act = async (id: number, type: string, feedback?: string, runId?: number) => {
    try {
      await client.action(id, type, feedback, runId);
      await refresh();
    } catch (e: any) { alert(e?.message ?? '操作失败'); }
  };

  const draftOp = async (id: number, op: 'edit' | 'moveBefore' | 'enqueue', extra?: { prompt?: string; beforeId?: number }) => {
    try {
      await client.draftOp(id, op, extra);
      await refresh();
    } catch (e: any) { alert(e?.message ?? '操作失败'); }
  };

  const draftDelete = async (id: number) => {
    try { await client.action(id, 'cancel'); await refresh(); } catch (e: any) { alert(e?.message ?? '删除失败'); }
  };

  /** 从部分完成的结果一键创建后续草稿（同项目，原任务 + 剩余清单） */
  const followup = async (t: Task) => {
    try {
      const prompt = `${t.prompt}\n\n[后续任务] 上次执行待完成：${t.partial_remaining}`;
      await client.createTask(t.project_id, prompt, true);
      await refresh();
    } catch (e: any) { alert(e?.message ?? '创建失败'); }
  };

  const selectProject = (s: Scope) => {
    localStorage.setItem('agentdesk.scope-touched', '1');
    setSelected(s);
  };

  return (
    <div className="app">
      <header>
        <h1>Runember</h1>
        <span className={error ? 'conn err' : 'conn'}>{unauthorized ? '需要连接密钥' : error ? 'daemon 离线' : 'daemon 已连接'}</span>
        <nav className="environment-tools" aria-label="环境与设置">
          <button data-guide="environment" onClick={() => setShowSetup(true)}>诊断中心</button>
          <button data-guide="executors" onClick={() => setShowAgents(true)}>环境设置</button>
          <button data-guide="dingtalk" onClick={() => setShowDingTalk(true)}>钉钉设置</button>
          <button onClick={() => setShowGuide(true)}>使用引导</button>
        </nav>
      </header>

      <ProjectStrip
        projects={projects}
        selected={selected}
        onSelect={selectProject}
        tasks={tasks}
        onChanged={() => void refresh()}
      />

      <div className="toolbar project-task-tools" data-guide="new-task">
        <NewTask key={selected} project={currentProject} onCreated={() => void refresh()} />
        {currentProject ? <span className="task-project-context">{currentProject.name} · Agent：{agentLabel(currentProject.agent_id)} · {currentProject.model || '默认模型'}</span>
          : <span className="task-project-context">先选择一个项目，再新建任务</span>}
      </div>
      {showSetup && <SetupPanel onClose={() => setShowSetup(false)} />}
      {showDingTalk && <DingTalkSettings onClose={() => setShowDingTalk(false)} />}
      {showAgents && <AgentSettings onClose={() => setShowAgents(false)} />}
      {unauthorized ? (
        <form className="banner row" onSubmit={event => {
          event.preventDefault();
          setApiToken(token.trim());
          void refresh();
        }}>
          <label>连接密钥 <input type="password" value={token} onChange={event => setToken(event.target.value)} /></label>
          <button type="submit">连接</button>
        </form>
      ) : error && <div className="banner">{error}</div>}
      {!error && !projects.length && <p className="dim">首次使用可先检查环境，登录宿主 Codex，再添加一个本机 Git 项目。</p>}

      <div className="columns six" data-guide="board">
        <Column title={`${TASK_STATE_LABELS.draft} (${scopedDrafts.length})`} tone="draft"
          empty={scopedDrafts.length ? null : '没有草稿'}>
          {scopedDrafts.map((t, i) => (
            <DraftCard key={t.id} task={t} index={i} total={scopedDrafts.length}
              project={projectName.get(t.project_id)}
              onOpen={() => openTask(t.id)}
              onOp={draftOp}
              onMove={(id, dir) => {
                const neighbor = scopedDrafts[dir === -1 ? i - 1 : i + 1];
                if (!neighbor) return;
                if (dir === -1) void draftOp(id, 'moveBefore', { beforeId: neighbor.id });
                else void draftOp(neighbor.id, 'moveBefore', { beforeId: id });
              }}
              onDelete={draftDelete} />
          ))}
        </Column>
        {boardColumns.map(({ state, tone }) => {
          const items = scoped.filter(t => t.state === state);
          return <Column key={state} title={`${TASK_STATE_LABELS[state]} (${items.length})`} tone={tone}
            empty={items.length ? null : '暂无'}>
            {items.map(t => <Card key={t.id} task={t} project={projectName.get(t.project_id)}
              onOpen={() => openTask(t.id)}
              actions={t.partial_remaining && (state === 'ended' || state === 'awaiting_confirmation')
                ? <button onClick={() => void followup(t)}>创建后续草稿</button> : undefined} />)}
          </Column>;
        })}
      </div>

      {selectedTask && !unauthorized && (
        <TaskPanel key={selectedTask} taskId={selectedTask} onClose={() => openTask(null)} onAct={act} />
      )}
      {showGuide && <Onboarding onClose={() => { setShowGuide(false); setGuideDismissed(true); }} />}
    </div>
  );
}

/** 顶部项目选择条：突出项目概念，含模式徽章与管理操作，末尾是添加项目 */
function ProjectStrip(props: {
  projects: Project[];
  selected: Scope;
  onSelect: (s: Scope) => void;
  tasks: Task[];
  onChanged: () => void;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [report, setReport] = useState<{ name: string; rows: EnvironmentRow[] } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [editingAgent, setEditingAgent] = useState<Project | null>(null);

  const patch = async (id: number, body: Record<string, unknown>) => {
    setBusy(id);
    try { await client.updateProject(id, body); props.onChanged(); }
    catch (e: any) { alert(e?.message ?? '操作失败'); }
    setBusy(null);
  };

  const recheck = async (p: Project) => {
    setBusy(p.id);
    try {
      const d = await client.recheckProject(p.id);
      setReport({ name: p.name, rows: d.report });
    } catch (e: any) { alert(e?.message ?? '检测失败'); }
    setBusy(null);
  };

  const remove = async (p: Project) => {
    if (!confirm(`删除项目「${p.name}」？（不影响任务历史与磁盘文件）`)) return;
    try { await client.deleteProject(p.id); if (props.selected === p.id) props.onSelect('all'); props.onChanged(); }
    catch (e: any) { alert(e?.message ?? '删除失败'); }
  };

  const countFor = (id: number) => {
    const n = props.tasks.filter(t => t.project_id === id && t.state !== 'ended' && t.state !== 'cancelled').length;
    return n > 0 ? `${n} 待处理` : '';
  };

  return (
    <section className="proj-strip">
      <div className="strip-head">
        <h2>📁 项目</h2>
        <button className="new-task" onClick={() => setShowAdd(v => !v)}>＋ 添加项目</button>
      </div>
      {showAdd && <AddProject onCreated={() => { setShowAdd(false); props.onChanged(); }} />}
      <div className="strip-cards">
        <div className={`proj-card all ${props.selected === 'all' ? 'selected' : ''}`}
          onClick={() => props.onSelect('all')}>
          <div className="proj-card-name">🌐 全部</div>
          <div className="proj-card-path">所有项目的任务</div>
        </div>
        {props.projects.map(p => {
          const isCap = (p.execution ?? 'capability') === 'capability';
          const cnt = countFor(p.id);
          return (
            <div key={p.id}
              className={`proj-card ${props.selected === p.id ? 'selected' : ''}`}
              onClick={() => props.onSelect(p.id)}>
              <div className="proj-card-top">
                <span className={`mode-badge ${isCap ? 'cap' : 'iso'}`}>{isCap ? '⚡ 能力' : '🛡 隔离'}</span>
                {cnt && <span className="mini-count">{cnt}</span>}
              </div>
              <div className="proj-card-name">{p.name}</div>
              <div className="agent-info">{agentLabel(p.agent_id)} · {p.model || '默认模型'}</div>
              <div className="proj-card-path">{p.workspace_path}</div>
              <div className="proj-card-actions" onClick={e => e.stopPropagation()}>
                <button title="修改 Agent 与模型" onClick={() => setEditingAgent(p)}>Agent 设置</button>
                <button title="重新检测配置" disabled={busy === p.id} onClick={() => void recheck(p)}>🔍</button>
                <button title={p.agent_id !== 'codex' ? '此 Agent 当前支持能力优先模式' : isCap ? '切到隔离优先（将做平台检测）' : '切到能力优先'}
                  disabled={busy === p.id || p.agent_id !== 'codex'}
                  onClick={() => void patch(p.id, { execution: isCap ? 'isolation' : 'capability' })}>
                  {isCap ? '🛡' : '⚡'}
                </button>
                <button title="删除项目" onClick={() => void remove(p)}>🗑</button>
              </div>
            </div>
          );
        })}
      </div>
      {editingAgent && <ProjectAgentSettings project={editingAgent} onClose={() => setEditingAgent(null)}
        onSaved={() => { setEditingAgent(null); props.onChanged(); }} />}
      {report && (
        <div className="recheck-report">
          <b>🩺 「{report.name}」检测报告</b>
          <EnvironmentChecks rows={report.rows} />
          <button onClick={() => setReport(null)}>关闭</button>
        </div>
      )}
    </section>
  );
}

/** 添加项目弹窗：名称/路径/执行模式（注册时守门检测） */
function AddProject(props: { onCreated: () => void }) {
  const [name, setName] = useState('');
  const [folder, setFolder] = useState<ProjectFolder>();
  const [showFolders, setShowFolders] = useState(false);
  const [execution, setExecution] = useState<'capability' | 'isolation'>('capability');
  const [agent, setAgent] = useState('codex');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const submit = async () => {
    if (!name.trim() || !folder || busy) return;
    setBusy(true);
    setMsg('');
    try {
      await client.createProject(name.trim(), folder.path, agent, execution, model.trim() || null);
      props.onCreated();
    } catch (e: any) { setMsg(e?.message ?? '注册失败'); }
    setBusy(false);
  };

  if (showFolders) {
    return <ProjectFolderPicker initialPath={folder?.path} onClose={() => setShowFolders(false)} onSelect={selected => {
      if (!name.trim() || name === folder?.name) setName(selected.name);
      setFolder(selected);
      setShowFolders(false);
      setMsg('');
    }} />;
  }

  return (
    <Modal title="📁 添加项目" onClose={props.onCreated}>
      <Labeled label="项目名">
        <input placeholder="如 myapp" value={name} onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void submit(); }} />
      </Labeled>
      <Labeled label="项目文件夹">
        {folder && <p className="folder-path">{folder.path}</p>}
        <button disabled={busy} onClick={() => setShowFolders(true)}>{folder ? '更换文件夹' : '选择文件夹'}</button>
      </Labeled>
      <AgentFields agent={agent} model={model} disabled={busy} onAgent={value => {
        setAgent(value); if (value !== 'codex') setExecution('capability');
      }} onModel={setModel} />
      <Labeled label="执行模式">
        <div className="mode-select">
          <label>
            <input type="radio" checked={execution === 'capability'} onChange={() => setExecution('capability')} />
            ⚡ 能力优先（默认）— Agent 直接跑宿主，原生依赖可用
          </label>
          <label>
            <input type="radio" disabled={agent !== 'codex'} checked={execution === 'isolation'} onChange={() => setExecution('isolation')} />
            🛡 隔离优先 — Linux 容器执行（目前支持 Codex）
          </label>
        </div>
      </Labeled>
      {msg && <div className="form-err">{msg}</div>}
      <FormActions primary={busy ? '注册中…' : '注册'} onPrimary={() => void submit()}
        disabled={busy || !name.trim() || !folder} secondary="取消" onSecondary={() => props.onCreated()} />
    </Modal>
  );
}

function Column(props: { title: string; tone: string; empty: string | null; children: React.ReactNode }) {
  return (
    <section className={`col tone-${props.tone}`}>
      <h2>{props.title}</h2>
      {props.empty && <div className="empty">{props.empty}</div>}
      {props.children}
    </section>
  );
}

function ProjectAgentSettings({ project, onClose, onSaved }: { project: Project; onClose: () => void; onSaved: () => void }) {
  const [agent, setAgent] = useState(project.agent_id);
  const [model, setModel] = useState(project.model ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setBusy(true); setError('');
    try {
      await client.updateProject(project.id, { agent_id: agent, model: model.trim() || null,
        ...(agent !== 'codex' ? { execution: 'capability' } : {}) });
      onSaved();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return <Modal title={`${project.name} · Agent 设置`} onClose={onClose}>
    <AgentFields agent={agent} model={model} onAgent={setAgent} onModel={setModel} disabled={busy} />
    <p className="dim">保存后新建的任务使用此配置。已有任务和草稿保留创建时的 Agent 与模型，续跑仍恢复原会话。</p>
    {error && <p className="form-err" role="alert">{error}</p>}
    <FormActions primary="保存" onPrimary={() => void save()} disabled={busy} secondary="取消" onSecondary={onClose} />
  </Modal>;
}

function Card(props: {
  task: Task; project?: string; onOpen: () => void; actions?: React.ReactNode;
}) {
  const meta = taskStatusMeta(props.task);
  return (
    <div className="card" onClick={props.onOpen}>
      <div className="card-head">
        <span className="badge" style={{ color: meta.color, background: meta.bg }}>{meta.label}</span>
        <span className="pid">#{props.task.id} · {props.project}</span>
      </div>
      <div className="agent-info">{agentLabel(props.task.agent_id)} · {props.task.model || '默认模型'}</div>
      <div className="prompt">{props.task.prompt}</div>
      {props.task.confirmation && <p className="confirmation-preview">{props.task.confirmation}</p>}
      {props.actions && (
        <div className="card-actions" onClick={e => e.stopPropagation()}>
          {props.actions}
        </div>
      )}
    </div>
  );
}

/** 草稿卡片：排序/编辑/执行/删除 */
function DraftCard(props: {
  task: Task; index: number; total: number; project?: string;
  onOpen: () => void;
  onOp: (id: number, op: 'edit' | 'moveBefore' | 'enqueue', extra?: { prompt?: string; beforeId?: number }) => Promise<void>;
  onMove: (id: number, dir: -1 | 1) => void;
  onDelete: (id: number) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const t = props.task;

  return (
    <div className="card draft">
      <div className="card-head">
        <button onClick={props.onOpen}>查看详情</button>
        <span className="pid">#{t.id} · {props.project}</span>
      </div>
      <div className="agent-info">{agentLabel(t.agent_id)} · {t.model || '默认模型'}</div>
      {editing ? (
        <>
          <textarea className="draft-edit" value={text} onChange={e => setText(e.target.value)} rows={3} />
          <div className="card-actions">
            <button className="primary" onClick={() => { void props.onOp(t.id, 'edit', { prompt: text }); setEditing(false); }}>保存</button>
            <button onClick={() => setEditing(false)}>取消</button>
          </div>
        </>
      ) : (
        <div className="prompt" onDoubleClick={() => { setEditing(true); setText(t.prompt); }} title="双击编辑">
          {t.prompt}
        </div>
      )}
      <div className="card-actions" onClick={e => e.stopPropagation()}>
        <button className="primary" onClick={() => void props.onOp(t.id, 'enqueue')}>▶ 执行</button>
        <button title="上移" disabled={props.index === 0} onClick={() => props.onMove(t.id, -1)}>↑</button>
        <button title="下移" disabled={props.index === props.total - 1} onClick={() => props.onMove(t.id, 1)}>↓</button>
        <button title="编辑" onClick={() => { setEditing(true); setText(t.prompt); }}>✎</button>
        <button title="删除" onClick={() => void props.onDelete(t.id)}>🗑</button>
      </div>
    </div>
  );
}

function SetupPanel({ onClose }: { onClose: () => void }) {
  return <Modal title="诊断中心" onClose={onClose} layout="detail">
    <Diagnostics />
  </Modal>;
}

function TaskPanel(props: { taskId: number; onClose: () => void; onAct: (id: number, type: string, fb?: string, runId?: number) => Promise<void> }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof client.task>>>();
  const [feedback, setFeedback] = useState('');
  const [selectedRunId, setSelectedRunId] = useState<number>();
  const [error, setError] = useState('');
  const [diagnosing, setDiagnosing] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const d = await client.task(props.taskId);
        if (!alive) return;
        setData(d);
        setError('');
      } catch (e) { if (alive) setError((e as Error).message); }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => { alive = false; clearInterval(timer); };
  }, [props.taskId]);

  const task = data?.task;
  const merge = data?.merge;
  const runs = data?.runs ?? [];
  const actions = data?.actions;
  const details = data?.details;
  const logRun = runs.find(run => run.id === selectedRunId) ?? runs.at(-1);
  const files = readRunSummary(runs.at(-1))?.filesChanged;

  return (
    <Modal title={`#${props.taskId}${task ? ` · ${taskStatusMeta(task).label}` : ''}`} onClose={props.onClose} layout="detail">
      {error && <p role="alert">{error}</p>}
      {!task && !error && <p>正在读取任务…</p>}
      {task?.confirmation && <dl className="confirmation"><dt>请确认</dt><dd>{task.confirmation}</dd></dl>}
      {details ? <p className="run-facts">{runTiming(details)}</p> : data?.agentId && <p className="run-facts">Agent · {data.agentId}</p>}
      {details?.cancellationRequestedAt && <dl className="run-details">
        <dt>请求取消</dt><dd>{new Date(details.cancellationRequestedAt).toLocaleString()}</dd>
        {details.stoppedAt && <><dt>执行器停止</dt><dd>{new Date(details.stoppedAt).toLocaleString()}</dd></>}
        {details.stopIssue && <><dt>停止进度</dt><dd role="status">{details.stopIssue}</dd></>}
        {!!details.filesChanged?.length && <><dt>工作区变更</dt><dd>{details.filesChanged.join('\n')}</dd></>}
      </dl>}
      {details?.diagnostic && <dl className="run-details"><dt>运行说明</dt><dd>{details.diagnostic}</dd></dl>}
      {task && <div className="task-diagnostics"><button onClick={() => setDiagnosing(!diagnosing)}>{diagnosing ? '收起运行诊断' : '诊断此轮运行'}</button>
        {diagnosing && <Diagnostics task={task.id} run={selectedRunId ?? details?.id} />}</div>}
      {merge?.repo && merge.pr && (
        <p><a href={`https://github.com/${merge.repo}/pull/${merge.pr}`} target="_blank" rel="noreferrer">查看 PR #{merge.pr}</a></p>
      )}
      {merge?.verified && <p className="dim">已验证提交 <code>{merge.verified.head}</code></p>}

      {details?.summary && (
        <div className="summary">
          <b>Agent 最终答复</b>
          <p>{details.summary}</p>
          {!!files?.length && <p className="dim">📝 改动 {files.length} 个文件</p>}
        </div>
      )}
      {details && (details.blocker || details.remaining || details.artifacts.length > 0) && (
        <dl className="run-details">
          {details.blocker && <><dt>卡点</dt><dd>{details.blocker}</dd></>}
          {details.remaining && <><dt>待完成</dt><dd>{details.remaining}</dd></>}
          {details.artifacts.length > 0 && <><dt>产物链接</dt>
            {details.artifacts.map(a => <dd key={a.location}>{a.href
              ? <a href={a.href} target="_blank" rel="noreferrer">{a.label}</a>
              : <>{a.label} · {a.location}</>}</dd>)}</>}
        </dl>
      )}
      {task && actions && (actions.resume || actions.retry || actions.cancel) && (
        <div className="feedback-box">
          {actions.resume && <textarea
            placeholder={task.confirmation ? '填写确认或补充信息' : '续跑说明（可选）'}
            value={feedback} onChange={e => setFeedback(e.target.value)}
          />}
          <div className="row">
            {actions.resume && <button className="primary" onClick={() => { void props.onAct(task.id, 'resume', feedback); setFeedback(''); }}>
              {actions.resume === 'session' ? '续跑原会话' : '以新会话继续'}
            </button>}
            {actions.retry && <button onClick={() => void props.onAct(task.id, 'retry')}>
              {merge ? '核对并继续合并' : '重试（新会话）'}
            </button>}
            {actions.cancel && <button disabled={task.stopping}
              onClick={() => void props.onAct(task.id, 'cancel', undefined, task.state === 'running' ? details?.id : undefined)}>
              {task.stopping ? '正在停止' : '取消任务'}
            </button>}
          </div>
        </div>
      )}
      {task && <p className="prompt-full">{task.prompt}</p>}

      {runs.length > 0 && <div className="runs">
        <b>Run 历史</b>
        {runs.map(r => (
          <div key={r.id} className="run-row">
            Run #{r.id} · {agentLabel(r.agent_id ?? task?.agent_id)}{r.model ? ` / ${r.model}` : ''} · {r.kind === 'resume' ? '续跑' : '执行'} · {runStage(r)}
            {r.session_id && <span className="dim"> · session {r.session_id.slice(0, 8)}</span>}
            {r.log_path && <button aria-pressed={logRun?.id === r.id} onClick={() => setSelectedRunId(r.id)}>查看日志</button>}
            {r.checkpoint_sha && <p className="dim">Git checkpoint <code>{r.checkpoint_sha}</code></p>}
          </div>
        ))}
      </div>}

      {logRun?.log_path && <RunLogViewer key={logRun.id} run={logRun} />}
    </Modal>
  );
}

function NewTask(props: { project?: Project; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);

  const project = props.project;

  const submit = async (draft: boolean) => {
    if (!project || !prompt.trim() || busy) return;
    setBusy(true);
    try {
      await client.createTask(project.id, prompt, draft);
      setPrompt('');
      setOpen(false);
      props.onCreated();
    } catch (e: any) { alert(e?.message ?? '派发失败'); }
    setBusy(false);
  };

  if (!open) {
    return <button className="primary" disabled={!project} onClick={() => setOpen(true)}>＋ 新建任务</button>;
  }
  return (
    <Modal title="📝 新建任务" onClose={() => setOpen(false)}>
      <div className="new-task-context"><strong>{project?.name}</strong><span>Agent · {agentLabel(project?.agent_id)} · {project?.model || '默认模型'}</span></div>
      <Labeled label="任务描述">
        <textarea
          placeholder="描述要执行的任务"
          value={prompt} onChange={e => setPrompt(e.target.value)} rows={4}
        />
      </Labeled>
      <div className="row">
        <button className="primary" disabled={busy || !project || !prompt.trim()} onClick={() => void submit(false)}>立即执行</button>
        <button disabled={busy || !project || !prompt.trim()} onClick={() => void submit(true)}>存草稿</button>
        <button onClick={() => setOpen(false)}>取消</button>
      </div>
    </Modal>
  );
}
