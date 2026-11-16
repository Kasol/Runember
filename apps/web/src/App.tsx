import { useEffect, useMemo, useState } from 'react';
import { ApiError, client, setApiToken, STATUS_META, type Project, type Task, type Run, type MergeStatus, type ProjectFolder } from './api';
import { stripAgentctlLines } from '@agentdesk/core';
import { Modal, Labeled, FormActions } from './ui';
import { ProjectFolderPicker } from './ProjectFolderPicker';

type Scope = number | 'all';

/** 项目主导视图：顶部项目选择条 → 六栏队列（草稿/进行中/阻塞/成功/失败/取消），全部跟随所选项目 */
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

  /** 从部分完成的结果一键创建后续草稿（同项目，原任务 + 剩余清单） */
  const followup = async (t: Task) => {
    try {
      const prompt = `${t.prompt}\n\n[后续任务] 上次执行部分完成，未完成部分：${t.partial_remaining}`;
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
        <h1>agentdesk</h1>
        <span className={error ? 'conn err' : 'conn'}>{unauthorized ? '需要连接密钥' : error ? 'daemon 离线' : 'daemon 已连接'}</span>
      </header>

      <ProjectStrip
        projects={projects}
        selected={selected}
        onSelect={selectProject}
        tasks={tasks}
        onChanged={() => void refresh()}
      />

      <div className="toolbar">
        <NewTask projects={projects} defaultProjectId={selected} onCreated={() => void refresh()} />
        <button onClick={() => setShowSetup(true)}>环境检查</button>
      </div>
      {showSetup && <SetupPanel onClose={() => setShowSetup(false)} />}
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

      <div className="columns six">
        <Column title={`📝 草稿 (${scopedDrafts.length})`} tone="draft"
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
        <Column title={`🔄 进行中 (${active.length})`} tone="active"
          empty={active.length ? null : '队列为空'}>
          {active.map(t => (
            <Card key={t.id} task={t} project={projectName.get(t.project_id)}
              onOpen={() => openTask(t.id)}
              actions={t.status === 'queued' ? <button onClick={() => void act(t.id, 'cancel')}>取消</button> : undefined} />
          ))}
        </Column>
        <Column title={`⚠️ 阻塞 (${blocked.length})`} tone="warn"
          empty={blocked.length ? null : '没有阻塞任务'}>
          {blocked.map(t => (
            <Card key={t.id} task={t} project={projectName.get(t.project_id)}
              onOpen={() => openTask(t.id)}
              actions={<button onClick={() => openTask(t.id)}>处理阻塞</button>} />
          ))}
        </Column>
        <Column title={`✅ 成功 (${done.length})`} tone="settled"
          empty={done.length ? null : '暂无'}>
          {done.map(t => (
            <Card key={t.id} task={t} project={projectName.get(t.project_id)}
              onOpen={() => openTask(t.id)}
              partial={!!t.partial_remaining}
              partialRemaining={t.partial_remaining ?? undefined}
              onFollowup={followup}
              onContinue={t.partial_remaining ? () => void act(t.id, 'resume', '请继续完成剩余部分') : undefined} />
          ))}
        </Column>
        <Column title={`❌ 失败 (${failed.length})`} tone="failed"
          empty={failed.length ? null : '没有失败任务'}>
          {failed.map(t => (
            <Card key={t.id} task={t} project={projectName.get(t.project_id)}
              onOpen={() => openTask(t.id)}
              actions={<button onClick={() => void act(t.id, 'retry')}>重试</button>} />
          ))}
        </Column>
        <Column title={`🚫 取消 (${cancelled.length})`} tone="settled"
          empty={cancelled.length ? null : '暂无'}>
          {cancelled.map(t => (
            <Card key={t.id} task={t} project={projectName.get(t.project_id)}
              onOpen={() => openTask(t.id)} />
          ))}
        </Column>
      </div>

      {selectedTask && !unauthorized && (
        <TaskPanel key={selectedTask} taskId={selectedTask} onClose={() => openTask(null)} onAct={act} />
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
  const [folder, setFolder] = useState<ProjectFolder>();
  const [showFolders, setShowFolders] = useState(false);
  const [execution, setExecution] = useState<'capability' | 'isolation'>('capability');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const submit = async () => {
    if (!name.trim() || !folder || busy) return;
    setBusy(true);
    setMsg('');
    try {
      await client.createProject(name.trim(), folder.path, 'codex', execution);
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

function Card(props: {
  task: Task; project?: string; onOpen: () => void; actions?: React.ReactNode;
  partial?: boolean; partialRemaining?: string;
  onFollowup?: (t: Task) => Promise<void>; onContinue?: () => void;
}) {
  const meta = STATUS_META[props.task.status];
  return (
    <div className="card" onClick={props.onOpen}>
      <div className="card-head">
        <span className="badge" style={{ color: meta.color, background: meta.bg }}>{meta.label}</span>
        {props.partial && <span className="badge partial">⚠️ 部分</span>}
        <span className="pid">#{props.task.id} · {props.project}</span>
      </div>
      <div className="prompt">{props.task.prompt}</div>
      {props.partial && props.partialRemaining && (
        <div className="partial-note">📋 未完成：{props.partialRemaining.slice(0, 60)}</div>
      )}
      {(props.actions || (props.partial && (props.onFollowup || props.onContinue))) && (
        <div className="card-actions" onClick={e => e.stopPropagation()}>
          {props.actions}
          {props.partial && props.onContinue && (
            <button className="primary" title="同会话继续完成剩余部分" onClick={() => props.onContinue?.()}>
              ▶ 续跑
            </button>
          )}
          {props.partial && props.onFollowup && (
            <button title="以原任务+未完成清单创建后续草稿" onClick={() => void props.onFollowup!(props.task)}>
              📎 后续任务
            </button>
          )}
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

function SetupPanel({ onClose }: { onClose: () => void }) {
  const [report, setReport] = useState<Awaited<ReturnType<typeof client.setup>>['report']>([]);
  const [message, setMessage] = useState('');
  const [checking, setChecking] = useState(true);
  const check = async () => {
    setChecking(true);
    setMessage('');
    try { setReport((await client.setup()).report); }
    catch (error) { setMessage((error as Error).message); }
    finally { setChecking(false); }
  };
  useEffect(() => { void check(); }, []);
  return <Modal title="宿主环境检查" onClose={onClose} layout="setup">
    <div className="setup-check">
      <p>能力优先会以当前 Windows 用户身份在本机项目中运行。</p>
      {report.length > 0 && <ul className="setup-report">
        {report.map(row => (
          <li key={row.name}>
            <span className="setup-item">
              <span role="img" aria-label={row.ok ? '通过' : row.required ? '未通过' : '可选'}>
                {row.ok ? '✅' : row.required ? '❌' : '⚠️'}
              </span>
              <strong>{row.name}</strong>
            </span>
            <span className="setup-detail">{row.detail}</span>
          </li>
        ))}
      </ul>}
      {report.some(row => row.name === '宿主 Codex 登录' && !row.ok) && (
        <p>在发布包目录打开终端，运行 <code>.\desk.cmd auth</code>，浏览器授权后再检查。源码运行方式为 <code>npm run desk -- auth</code>。</p>
      )}
      {message && <p className="form-err" role="alert">{message}</p>}
      <div className="row">
        <button className="primary" disabled={checking} onClick={() => void check()}>{checking ? '检查中…' : '重新检查'}</button>
      </div>
    </div>
  </Modal>;
}

function TaskPanel(props: { taskId: number; onClose: () => void; onAct: (id: number, type: string, fb?: string) => Promise<void> }) {
  const [task, setTask] = useState<Task>();
  const [merge, setMerge] = useState<MergeStatus>();
  const [runs, setRuns] = useState<Run[]>([]);
  const [feedback, setFeedback] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const d = await client.task(props.taskId);
        if (!alive) return;
        setTask(d.task);
        setMerge(d.merge);
        setRuns(d.runs);
        setError('');
        const last = d.runs.at(-1);
        if (last) {
          const r = await client.run(last.id);
          if (alive) setLog(r.logTail);
        } else setLog([]);
      } catch (e) { if (alive) setError((e as Error).message); }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => { alive = false; clearInterval(timer); };
  }, [props.taskId]);

  const lastRun = runs.at(-1);
  const summary = lastRun?.summary_json ? JSON.parse(lastRun.summary_json) : null;

  return (
    <Modal title={`#${props.taskId}${task ? ` · ${STATUS_META[task.status].label}` : ''}`} onClose={props.onClose} layout="detail">
      {error && <p role="alert">{error}</p>}
      {!task && !error && <p>正在读取任务…</p>}
      {task && <p className="prompt-full">{task.prompt}</p>}
      {merge?.repo && merge.pr && (
        <p><a href={`https://github.com/${merge.repo}/pull/${merge.pr}`} target="_blank" rel="noreferrer">查看 PR #{merge.pr}</a></p>
      )}
      {merge?.verified && <p className="dim">已验证提交 <code>{merge.verified.head}</code></p>}

      {summary?.agentMessage && (
        <div className="summary">
          <b>agent 总结</b>
          <p>{stripAgentctlLines(summary.agentMessage)}</p>
          {summary.filesChanged?.length > 0 && (
            <p className="dim">📝 改动 {summary.filesChanged.length} 个文件：{summary.filesChanged.slice(0, 6).join('、')}</p>
          )}
        </div>
      )}

      {task?.status === 'blocked' && (
        <div className="feedback-box">
          {!merge && <textarea
            placeholder="输入你的决定（如：可以合并，今晚不部署）…"
            value={feedback} onChange={e => setFeedback(e.target.value)}
          />}
          <div className="row">
            {merge ? <button className="primary" onClick={() => void props.onAct(task.id, 'retry')}>核对并继续合并</button>
              : <button className="primary" onClick={() => { void props.onAct(task.id, 'resume', feedback || '请继续'); setFeedback(''); }}>
                带决定续跑
              </button>}
            <button onClick={() => void props.onAct(task.id, 'cancel')}>取消任务</button>
          </div>
        </div>
      )}

      <div className="runs">
        <b>Run 历史</b>
        {runs.map(r => (
          <div key={r.id} className="run-row">
            run#{r.id} · {r.kind} · [{r.status}]{r.blocked_kind ? ` · ${r.blocked_kind}` : ''}
            {r.session_id && <span className="dim"> · session {r.session_id.slice(0, 8)}</span>}
            {r.checkpoint_sha && <p className="dim">Git checkpoint <code>{r.checkpoint_sha}</code></p>}
          </div>
        ))}
      </div>

      {log.length > 0 && (
        <pre className="log">{log.slice(-40).join('\n')}</pre>
      )}
    </Modal>
  );
}

function NewTask(props: { projects: Project[]; defaultProjectId: Scope; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [project, setProject] = useState('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);

  // 弹窗打开时同步默认项目（跟随当前选中）；打开后允许用户自由切换，不再回写
  useEffect(() => {
    if (!open) return;
    if (typeof props.defaultProjectId === 'number') setProject(String(props.defaultProjectId));
    else if (props.projects.length && !props.projects.some(p => String(p.id) === project)) setProject(String(props.projects[0]!.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在打开瞬间初始化
  }, [open]);

  const submit = async (draft: boolean) => {
    if (!project || !prompt.trim() || busy) return;
    setBusy(true);
    try {
      await client.createTask(Number(project), prompt.trim(), draft);
      setPrompt('');
      setOpen(false);
      props.onCreated();
    } catch (e: any) { alert(e?.message ?? '派发失败'); }
    setBusy(false);
  };

  if (!open) {
    return <button className="primary" disabled={!props.projects.length} onClick={() => setOpen(true)}>＋ 新建任务</button>;
  }
  return (
    <Modal title="📝 新建任务" onClose={() => setOpen(false)}>
      <Labeled label="项目">
        <select value={project} onChange={e => setProject(e.target.value)}>
          {props.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </Labeled>
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
