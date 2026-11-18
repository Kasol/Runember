import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { client, type Run } from './api';

declare global {
  interface Window {
    agentdeskDesktop?: { openRunLogLocation(runId: number): Promise<void> };
  }
}

export function RunLogViewer({ run }: { run: Run }) {
  const [cursors, setCursors] = useState<number[]>([]);
  const [page, setPage] = useState<{ text: string; before: number | null }>();
  const [error, setError] = useState('');
  const [openError, setOpenError] = useState('');
  const log = useRef<HTMLPreElement>(null);
  const followTail = useRef(true);
  const cursor = cursors.at(-1);
  const earlier = page?.before;
  const live = ['queued', 'starting', 'running'].includes(run.status);

  useEffect(() => {
    let active = true;
    let loading = false;
    followTail.current = cursor === undefined;
    setPage(undefined);
    setError('');
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const response = await client.runLog(run.id, cursor);
        if (active) { setPage(response); setError(''); }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = live && cursor === undefined ? setInterval(() => void load(), 3000) : undefined;
    return () => { active = false; clearInterval(timer); };
  }, [run.id, live, cursor]);

  useLayoutEffect(() => {
    if (log.current && followTail.current) log.current.scrollTop = log.current.scrollHeight;
  }, [page]);

  const openLocation = async () => {
    setOpenError('');
    try { await window.agentdeskDesktop?.openRunLogLocation(run.id); }
    catch (error) { setOpenError((error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, '')); }
  };

  return <section className="run-log">
    <div className="row">
      <b>Run #{run.id} 日志</b>
      {earlier != null && <button onClick={() => setCursors([...cursors, earlier])}>更早</button>}
      {cursors.length > 0 && <button onClick={() => setCursors(cursors.slice(0, -1))}>较新</button>}
      {cursors.length > 1 && <button onClick={() => setCursors([])}>最新</button>}
      {window.agentdeskDesktop && <button onClick={() => void openLocation()}>在资源管理器中定位</button>}
    </div>
    {error && <p role="alert">{error}</p>}
    {openError && <p role="alert">{openError}</p>}
    {page?.text ? <pre ref={log} className="log" onScroll={event => {
      const view = event.currentTarget;
      followTail.current = cursor === undefined && view.scrollHeight - view.scrollTop - view.clientHeight < 24;
    }}>{page.text}</pre>
      : !error && <p className="dim" role="status">{page ? '日志暂为空' : '正在读取日志…'}</p>}
  </section>;
}
