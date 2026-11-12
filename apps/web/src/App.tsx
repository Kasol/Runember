import { useEffect, useMemo, useState } from 'react';
import { client, STATUS_META, type Project, type Task, type Run } from './api';

/** 三栏看板：阻塞 / 运行(含排队) / 最近完成 —— 3s 轮询 */
export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [drafts, setDrafts] = useState<Task[]>([]);
  const [selected, setSelected] = useState<Task | null>(null);
  const [error, setError] = useState('');

  const refresh = async () => {
    try {
      const [p, t, dr] = await Promise.all([client.projects(), client.tasks(), client.drafts()]);
      setProjects(p.projects);
      setTasks(t.tasks);
      setDrafts(dr.drafts);
      setError('');
    } catch (e: any) { setError(e?.message ?? '无法连接 daemon'); }
  };

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, []);

  // 深链支持：?task=<id>（钉钉通知的"打开任务详情"链接）
  useEffect(() => {
    const id = Number(new URLSearchParams(location.search).get('task'));
    if (id) {
      void client.task(id).then(d => setSelected(d.task)).catch(() => {});
    }
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

  const draftOp = async (id: number, op: 'edit' | 'moveBefore' | 'enqueue', extra?: { prompt?: string; beforeId?: number }) => {
    try {
      await client.draftOp(id, op, extra);
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

      <DraftQueue
        drafts={drafts}
        projects={projects}
        onOp={draftOp}
        onDelete={async (id) => { try { await client.action(id, 'cancel'); await refresh(); } catch (e: any) { alert(e?.message ?? '删除失败'); } }}
        onCreated={() => void refresh()}
      />

      {error && <div className="banner">{error}</div>}

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

/** 草稿队列：入队后不执行；可编辑/排序；点「执行」才真实入队调度 */
function DraftQueue(props: {
  drafts: Task[];
  projects: Project[];
  onOp: (id: number, op: 'edit' | 'moveBefore' | 'enqueue', extra?: { prompt?: string; beforeId?: number }) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onCreated: () => void;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [text, setText] = useState('');
  const pname = new Map(props.projects.map(p => [p.id, p.name]));

  const move = (t: Task, dir: -1 | 1) => {
    const idx = props.drafts.findIndex(d => d.id === t.id);
    const neighbor = props.drafts[idx + dir];
    // moveBefore 语义：放到 neighbor 之前（上移 = 放到前一个之前；下移 = 放到后一个之后）
    if (dir === -1) void props.onOp(t.id, 'moveBefore', { beforeId: neighbor?.id ?? null });
    else void props.onOp(neighbor!.id, 'moveBefore', { beforeId: t.id });
  };

  const saveEdit = async (t: Task) => {
    await props.onOp(t.id, 'edit', { prompt: text });
    setEditing(null);
  };

  return (
    <section className="draft-box">
      <h2>📝 草稿队列（{props.drafts.length}）<span className="dim">—— 入队后不会自动执行，点「执行」才真实入队</span></h2>
      {!props.drafts.length && <div className="empty">草稿队列为空</div>}
      {props.drafts.map((t, i) => (
        <div key={t.id} className="draft-row">
          {editing === t.id ? (
            <>
              <textarea value={text} onChange={e => setText(e.target.value)} rows={2} />
              <div className="row">
                <button className="primary" onClick={() => void saveEdit(t)}>保存</button>
                <button onClick={() => setEditing(null)}>取消</button>
              </div>
            </>
          ) : (
            <>
              <span className="draft-idx">{i + 1}.</span>
              <span className="draft-prompt" onClick={() => { setEditing(t.id); setText(t.prompt); }} title="点击编辑">
                {t.prompt}
              </span>
              <span className="draft-project">{pname.get(t.project_id)}</span>
              <div className="draft-actions">
                <button title="上移" disabled={i === 0} onClick={() => move(t, -1)}>↑</button>
                <button title="下移" disabled={i === props.drafts.length - 1} onClick={() => move(t, 1)}>↓</button>
                <button title="编辑提示词" onClick={() => { setEditing(t.id); setText(t.prompt); }}>编辑</button>
                <button className="primary" onClick={() => void props.onOp(t.id, 'enqueue')}>▶ 执行</button>
                <button title="删除草稿" onClick={() => void props.onDelete(t.id)}>🗑</button>
              </div>
            </>
          )}
        </div>
      ))}
    </section>
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
      await client.createTask(Number(project), prompt.trim(), true); // 存草稿，不自动执行
      setPrompt('');
      setOpen(false);
      props.onCreated();
    } catch (e: any) { alert(e?.message ?? '派发失败'); }
    setBusy(false);
  };

  if (!open) {
    return <button className="new-task" onClick={() => setOpen(true)}>＋ 新建任务（存草稿）</button>;
  }
  return (
    <div className="new-task-box">
      <select value={project} onChange={e => setProject(e.target.value)}>
        {props.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <textarea
        placeholder="描述任务，如：重构 utils 目录并补全单元测试（保存后进入草稿队列，点「执行」才运行）"
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
