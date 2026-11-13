import { useEffect, useMemo, useState } from 'react';
import { client, STATUS_META, type Project, type Task, type Run } from './api';
import { Modal, Labeled, FormActions } from './ui';

type Scope = number | 'all';

/** 项目主导视图：顶部项目选择条 → 六栏队列（草稿/进行中/阻塞/成功/失败/取消），全部跟随所选项目 */
export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [drafts, setDrafts] = useState<Task[]>([]);
  const [selected, setSelected] = useState<Scope>('all');
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
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

  // 项目首次加载后默认选中第一个（项目主导）
  useEffect(() => {
    if (projects.length && selected === 'all' && !localStorage.getItem('agentdesk.scope-touched')) {
      setSelected(projects[0]!.id);
    }
  }, [projects, selected]);

  const scope = (list: Task[]) =>
    selected === 'all' ? list : list.filter(t => t.project_id === selected);

  const scopedDrafts = selected === 'all' ? drafts : drafts.filter(d => d.project_id === selected);
  const scoped = scope(tasks);
  const active = scoped.filter(t => ['running', 'queued', 'starting'].includes(t.status));
  const blocked = scoped.filter(t => t.status === 'blocked');
  const done = scoped.filter(t => t.status === 'done').slice(0, 12);
  const failed = scoped.filter(t => t.status === 'failed').slice(0, 12);
  const cancelled = scoped.filter(t => t.status === 'cancelled').slice(0, 12);

  const projectName = useMemo(
    () => new Map(projects.map(p => [p.id, p.name])),
    [projects],
  );

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

  const draftDelete = async (id: number) => {
    try { await client.action(id, 'cancel'); await refresh(); } catch (e: any) { alert(e?.message ?? '删除失败'); }
  };

  const selectProject = (s: Scope) => {
    localStorage.setItem('agentdesk.scope-touched', '1');
    setSelected(s);
  };

  return (
    <div className="app">
      <header>
        <h1>agentdesk</h1>
        <span className={error ? 'conn err' : 'conn'}>{error ? 'daemon 离线' : 'daemon 已连接'}</span>
      </header>

      <ProjectStrip
        projects={projects}
        selected={selected}
        onSelect={selectProject}
        tasks={tasks}
        onChanged={() => void refresh()}
      />

      <NewTask projects={projects} defaultProjectId={selected} onCreated={() => void refresh()} />

      {error && <div className="banner">{error}</div>}

      <div className="columns six">
        <Column title={`📝 草稿 (${scopedDrafts.length})`} tone="draft"
          empty={scopedDrafts.length ? null : '没有草稿'}>
          {scopedDrafts.map((t, i) => (
            <DraftCard key={t.id} task={t} index={i} total={scopedDrafts.length}
              project={projectName.get(t.project_id)}
              onOpen={() => setSelectedTask(t)}
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
        <Column title={`🔄 进行中 (${active.length})`} tone="active"
          empty={active.length ? null : '队列为空'}>
          {active.map(t => (
            <Card key={t.id} task={t} project={projectName.get(t.project_id)}
              onOpen={() => setSelectedTask(t)} />
          ))}
        </Column>
        <Column title={`⚠️ 阻塞 (${blocked.length})`} tone="warn"
          empty={blocked.length ? null : '没有阻塞任务'}>
          {blocked.map(t => (
            <Card key={t.id} task={t} project={projectName.get(t.project_id)}
              onOpen={() => setSelectedTask(t)}
              actions={<button onClick={() => void act(t.id, 'resume', '请继续')}>继续</button>} />
          ))}
        </Column>
        <Column title={`✅ 成功 (${done.length})`} tone="settled"
          empty={done.length ? null : '暂无'}>
          {done.map(t => (
            <Card key={t.id} task={t} project={projectName.get(t.project_id)}
              onOpen={() => setSelectedTask(t)} />
          ))}
        </Column>
        <Column title={`❌ 失败 (${failed.length})`} tone="failed"
          empty={failed.length ? null : '没有失败任务'}>
          {failed.map(t => (
            <Card key={t.id} task={t} project={projectName.get(t.project_id)}
              onOpen={() => setSelectedTask(t)}
              actions={<button onClick={() => void act(t.id, 'retry')}>重试</button>} />
          ))}
        </Column>
        <Column title={`🚫 取消 (${cancelled.length})`} tone="settled"
          empty={cancelled.length ? null : '暂无'}>
          {cancelled.map(t => (
            <Card key={t.id} task={t} project={projectName.get(t.project_id)}
              onOpen={() => setSelectedTask(t)} />
          ))}
        </Column>
      </div>

      {selectedTask && (
        <TaskPanel task={selectedTask} onClose={() => setSelectedTask(null)} onAct={act} />
      )}
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
  const [report, setReport] = useState<{ name: string; rows: Array<{ name: string; ok: boolean; detail: string }> } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

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
    const n = props.tasks.filter(t => t.project_id === id && ['running', 'queued', 'starting', 'blocked', 'draft'].includes(t.status)).length;
    return n > 0 ? `${n} 进行中` : '';
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
              <div className="proj-card-path">{p.workspace_path}</div>
              <div className="proj-card-actions" onClick={e => e.stopPropagation()}>
                <button title="重新检测配置" disabled={busy === p.id} onClick={() => void recheck(p)}>🔍</button>
                <button title={isCap ? '切到隔离优先（将做平台检测）' : '切到能力优先'}
                  disabled={busy === p.id}
                  onClick={() => void patch(p.id, { execution: isCap ? 'isolation' : 'capability' })}>
                  {isCap ? '🛡' : '⚡'}
                </button>
                <button title="删除项目" onClick={() => void remove(p)}>🗑</button>
              </div>
            </div>
          );
        })}
      </div>
      {report && (
        <div className="recheck-report">
          <b>🩺 「{report.name}」检测报告</b>
          {report.rows.map((r, i) => (
            <div key={i} className={r.ok ? 'ok' : 'bad'}>{r.ok ? '✅' : '❌'} {r.name} — {r.detail}</div>
          ))}
          <button onClick={() => setReport(null)}>关闭</button>
        </div>
      )}
    </section>
  );
}

/** 添加项目弹窗：名称/路径/执行模式（注册时守门检测） */
function AddProject(props: { onCreated: () => void }) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [execution, setExecution] = useState<'capability' | 'isolation'>('capability');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const submit = async () => {
    if (!name.trim() || !path.trim() || busy) return;
    setBusy(true);
    setMsg('');
    try {
      await client.createProject(name.trim(), path.trim(), 'codex', execution);
      setName('');
      setPath('');
      props.onCreated();
    } catch (e: any) { setMsg(e?.message ?? '注册失败'); }
    setBusy(false);
  };

  return (
    <Modal title="📁 添加项目" onClose={() => props.onCreated()} width={560}>
      <Labeled label="项目名">
        <input placeholder="如 myapp" value={name} onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void submit(); }} />
      </Labeled>
      <Labeled label="本地 git 仓库的绝对路径">
        <input placeholder="如 D:/work/myapp" value={path} onChange={e => setPath(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void submit(); }} />
      </Labeled>
      <Labeled label="执行模式">
        <div className="mode-select">
          <label>
            <input type="radio" checked={execution === 'capability'} onChange={() => setExecution('capability')} />
            ⚡ 能力优先（默认）— codex 直接跑宿主，原生依赖可用
          </label>
          <label>
            <input type="radio" checked={execution === 'isolation'} onChange={() => setExecution('isolation')} />
            🛡 隔离优先 — Linux 容器执行（注册时检测 Windows 原生组件，不兼容会拒绝）
          </label>
        </div>
      </Labeled>
      {msg && <div className="form-err">{msg}</div>}
      <FormActions primary={busy ? '注册中…' : '注册'} onPrimary={() => void submit()}
        disabled={busy || !name.trim() || !path.trim()} secondary="取消" onSecondary={() => props.onCreated()} />
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
        <span className="pid">#{t.id} · {props.project}</span>
      </div>
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

function NewTask(props: { projects: Project[]; defaultProjectId: Scope; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [project, setProject] = useState('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);

  // 跟随当前选中的项目
  useEffect(() => {
    if (typeof props.defaultProjectId === 'number') setProject(String(props.defaultProjectId));
    else if (props.projects.length && !project) setProject(String(props.projects[0]!.id));
  }, [props.defaultProjectId, props.projects, project]);

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
    <Modal title="📝 新建任务（存草稿）" onClose={() => setOpen(false)} width={560}>
      <Labeled label="项目">
        <select value={project} onChange={e => setProject(e.target.value)}>
          {props.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </Labeled>
      <Labeled label="任务描述">
        <textarea
          placeholder="保存后进入草稿队列，点「执行」才运行"
          value={prompt} onChange={e => setPrompt(e.target.value)} rows={4}
        />
      </Labeled>
      <FormActions primary={busy ? '保存中…' : '存草稿'} onPrimary={() => void submit()}
        disabled={busy || !prompt.trim()} secondary="取消" onSecondary={() => setOpen(false)} />
    </Modal>
  );
}
