import { useEffect, useMemo, useState } from 'react';
import { client, STATUS_META, type Project, type Task, type Run } from './api';

/** 三栏看板：阻塞 / 运行(含排队) / 最近完成 —— 3s 轮询 */
export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState<Task | null>(null);
  const [error, setError] = useState('');

  const refresh = async () => {
    try {
      const [p, t] = await Promise.all([client.projects(), client.tasks()]);
      setProjects(p.projects);
      setTasks(t.tasks);
      setError('');
    } catch (e: any) { setError(e?.message ?? '无法连接 daemon'); }
  };

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, []);

  const projectName = useMemo(
    () => new Map(projects.map(p => [p.id, p.name])),
    [projects],
  );

  const blocked = tasks.filter(t => t.status === 'blocked');
  const active = tasks.filter(t => ['running', 'queued', 'starting'].includes(t.status));
  const settled = tasks.filter(t => !['running', 'queued', 'starting', 'blocked'].includes(t.status)).slice(0, 12);

  const act = async (id: number, type: string, feedback?: string) => {
    try {
      await client.action(id, type, feedback);
      await refresh();
    } catch (e: any) { alert(e?.message ?? '操作失败'); }
  };

  return (
    <div className="app">
      <header>
        <h1>agentdesk</h1>
        <span className={error ? 'conn err' : 'conn'}>{error ? 'daemon 离线' : 'daemon 已连接'}</span>
      </header>

      <div className="toolbar">
        <NewTask projects={projects} onCreated={() => void refresh()} />
        <AddProject onCreated={() => void refresh()} hasAny={projects.length > 0} />
      </div>

      {error && <div className="banner">{error}</div>}

      <div className="columns">
        <Column title={`⚠️ 阻塞 (${blocked.length})`} tone="warn"
          empty={blocked.length ? null : '没有阻塞任务'}>
          {blocked.map(t => (
            <Card key={t.id} task={t} project={projectName.get(t.project_id)}
              onOpen={() => setSelected(t)}
              actions={<button onClick={() => void act(t.id, 'resume', '请继续')}>继续</button>} />
          ))}
        </Column>
        <Column title={`🔄 进行中 (${active.length})`} tone="active"
          empty={active.length ? null : '队列为空'}>
          {active.map(t => (
            <Card key={t.id} task={t} project={projectName.get(t.project_id)}
              onOpen={() => setSelected(t)} />
          ))}
        </Column>
        <Column title="🗂 最近" tone="settled" empty={settled.length ? null : '暂无'}>
          {settled.map(t => (
            <Card key={t.id} task={t} project={projectName.get(t.project_id)}
              onOpen={() => setSelected(t)}
              actions={t.status === 'failed' ? <button onClick={() => void act(t.id, 'retry')}>重试</button> : undefined} />
          ))}
        </Column>
      </div>

      {selected && (
        <TaskPanel task={selected} onClose={() => setSelected(null)} onAct={act} />
      )}
    </div>
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

function Card(props: { task: Task; project?: string; onOpen: () => void; actions?: React.ReactNode }) {
  const meta = STATUS_META[props.task.status];
  return (
    <div className="card" onClick={props.onOpen}>
      <div className="card-head">
        <span className="badge" style={{ color: meta.color, background: meta.bg }}>{meta.label}</span>
        <span className="pid">#{props.task.id} · {props.project}</span>
      </div>
      <div className="prompt">{props.task.prompt}</div>
      {props.actions && <div className="card-actions" onClick={e => e.stopPropagation()}>{props.actions}</div>}
    </div>
  );
}

function TaskPanel(props: { task: Task; onClose: () => void; onAct: (id: number, type: string, fb?: string) => Promise<void> }) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [feedback, setFeedback] = useState('');
  const [log, setLog] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const d = await client.task(props.task.id);
      if (!alive) return;
      setRuns(d.runs);
      const last = d.runs.at(-1);
      if (last) {
        const r = await client.run(last.id);
        if (alive) setLog(r.logTail);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => { alive = false; clearInterval(timer); };
  }, [props.task.id]);

  const lastRun = runs.at(-1);
  const summary = lastRun?.summary_json ? JSON.parse(lastRun.summary_json) : null;

  return (
    <div className="overlay" onClick={props.onClose}>
      <div className="panel" onClick={e => e.stopPropagation()}>
        <div className="panel-head">
          <h3>#{props.task.id} · {STATUS_META[props.task.status].label}</h3>
          <button className="close" onClick={props.onClose}>✕</button>
        </div>
        <p className="prompt-full">{props.task.prompt}</p>

        {summary?.agentMessage && (
          <div className="summary">
            <b>agent 总结</b>
            <p>{summary.agentMessage}</p>
            {summary.filesChanged?.length > 0 && (
              <p className="dim">📝 改动 {summary.filesChanged.length} 个文件：{summary.filesChanged.slice(0, 6).join('、')}</p>
            )}
          </div>
        )}

        {props.task.status === 'blocked' && (
          <div className="feedback-box">
            <textarea
              placeholder="输入你的决定（如：可以合并，今晚不部署）…"
              value={feedback} onChange={e => setFeedback(e.target.value)}
            />
            <div className="row">
              <button className="primary" onClick={() => { void props.onAct(props.task.id, 'resume', feedback || '请继续'); setFeedback(''); }}>
                带决定续跑
              </button>
              <button onClick={() => void props.onAct(props.task.id, 'cancel')}>取消任务</button>
            </div>
          </div>
        )}

        <div className="runs">
          <b>Run 历史</b>
          {runs.map(r => (
            <div key={r.id} className="run-row">
              run#{r.id} · {r.kind} · [{r.status}]{r.blocked_kind ? ` · ${r.blocked_kind}` : ''}
              {r.session_id && <span className="dim"> · session {r.session_id.slice(0, 8)}</span>}
            </div>
          ))}
        </div>

        {log.length > 0 && (
          <pre className="log">{log.slice(-40).join('\n')}</pre>
        )}
      </div>
    </div>
  );
}

function AddProject(props: { onCreated: () => void; hasAny: boolean }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const submit = async () => {
    if (!name.trim() || !path.trim() || busy) return;
    setBusy(true);
    setMsg('');
    try {
      await client.createProject(name.trim(), path.trim());
      setName('');
      setPath('');
      setOpen(false);
      props.onCreated();
    } catch (e: any) { setMsg(e?.message ?? '注册失败'); }
    setBusy(false);
  };

  if (!open) {
    return <button className="new-task" onClick={() => setOpen(true)}>＋ 添加项目</button>;
  }
  return (
    <div className="new-task-box">
      <div className="field-row">
        <input
          placeholder="项目名（如 myapp）"
          value={name} onChange={e => setName(e.target.value)}
        />
        <input
          placeholder="本地 git 仓库的绝对路径（如 D:/work/myapp）"
          value={path} onChange={e => setPath(e.target.value)}
          style={{ flex: 2 }}
        />
      </div>
      {msg && <div className="form-err">{msg}</div>}
      <div className="row">
        <button className="primary" disabled={busy || !name.trim() || !path.trim()} onClick={() => void submit()}>
          {busy ? '注册中…' : '注册'}
        </button>
        <button onClick={() => setOpen(false)}>收起</button>
      </div>
    </div>
  );
}

function NewTask(props: { projects: Project[]; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [project, setProject] = useState('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (props.projects.length && !project) setProject(String(props.projects[0]!.id));
  }, [props.projects, project]);

  const submit = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    try {
      await client.createTask(Number(project), prompt.trim());
      setPrompt('');
      setOpen(false);
      props.onCreated();
    } catch (e: any) { alert(e?.message ?? '派发失败'); }
    setBusy(false);
  };

  if (!open) {
    return <button className="new-task" onClick={() => setOpen(true)}>＋ 派发任务</button>;
  }
  return (
    <div className="new-task-box">
      <select value={project} onChange={e => setProject(e.target.value)}>
        {props.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <textarea
        placeholder="描述任务，如：重构 utils 目录并补全单元测试"
        value={prompt} onChange={e => setPrompt(e.target.value)} rows={3}
      />
      <div className="row">
        <button className="primary" disabled={busy || !prompt.trim()} onClick={() => void submit()}>
          {busy ? '派发中…' : '入队'}
        </button>
        <button onClick={() => setOpen(false)}>收起</button>
      </div>
    </div>
  );
}
