import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const storageKey = 'agentdesk.onboarding.v1';
export function hasSeenOnboarding(): boolean {
  try { return localStorage.getItem(storageKey) === 'seen'; } catch { return false; }
}

const steps = [
  { selector: '[data-guide="environment"]', title: '先检查运行环境', text: '这里检查宿主 Git、Agent CLI 和登录情况，并显示实际使用的 CLI 路径。环境相关操作统一放在顶部。' },
  { selector: '[data-guide="executors"]', title: '配置执行器与日志目录', text: '在环境设置中选择日志目录，并管理自动检测到的 Agent CLI。日志目录在重启后台服务后生效；执行路径对下一轮任务生效。' },
  { selector: '[data-guide="dingtalk"]', title: '设置钉钉消息语言', text: '选择自动判断、中文或英文。机器人连接与授权仍由 daemon 的配置管理。' },
  { selector: '.strip-head .new-task', title: '添加本机项目', text: '选择项目工作目录，并为项目绑定 Agent 和可选模型。先添加项目，才能新建任务。' },
  { selector: '.strip-cards', title: '选择要工作的项目', text: '点击项目卡片切换任务范围。「全部」用于查看所有项目；新建任务需要先选中一个具体项目。' },
  { selector: '.proj-card:not(.all) .proj-card-actions button', title: '项目决定 Agent 与模型', text: '在项目的 Agent 设置中更改默认执行配置。新任务使用此配置，历史任务续跑仍使用原来的 Agent。' },
  { selector: '[data-guide="new-task"]', title: '直接给当前项目派任务', text: '新建任务直接绑定当前选中的项目，这里也会显示 Agent 和模型。填写完整提示词后，可以立即执行或保存草稿。' },
  { selector: '[data-guide="board"]', title: '查看任务与运行详情', text: '看板按状态展示任务。点击任务查看 Agent 答复、最近活动和 Run 日志，并按详情中提供的操作续跑或取消。顶部「使用引导」随时可以重新打开。' },
];

export function Onboarding({ onClose }: { onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const [geometry, setGeometry] = useState<{ x: number; y: number; width: number; height: number; left: number; top: number }>();
  const dialog = useRef<HTMLDialogElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const previousFocus = useRef(document.activeElement as HTMLElement | null);
  const [available] = useState(() => steps.filter(step => document.querySelector(step.selector)));
  const step = available[index];
  const close = () => {
    try { localStorage.setItem(storageKey, 'seen'); } catch { /* Memory state still closes this visit. */ }
    onClose();
  };

  useLayoutEffect(() => {
    dialog.current?.showModal();
    return () => { dialog.current?.close(); previousFocus.current?.focus(); };
  }, []);

  useLayoutEffect(() => {
    if (!step) return;
    const target = document.querySelector(step.selector);
    if (!target) return;
    target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    const measure = () => {
        const r = target.getBoundingClientRect();
        const margin = 12;
        const width = Math.min(360, innerWidth - margin * 2);
        const height = bubble.current?.getBoundingClientRect().height ?? 230;
        const x = Math.max(4, r.left - 6), y = Math.max(4, r.top - 6);
        const right = Math.min(innerWidth - 4, r.right + 6), bottom = Math.min(innerHeight - 4, r.bottom + 6);
        const below = bottom + 14;
        const top = below + height <= innerHeight - margin ? below
          : y - height - 14 >= margin ? y - height - 14 : Math.max(margin, innerHeight - height - margin);
        setGeometry({ x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y),
          left: Math.max(margin, Math.min(r.left, innerWidth - width - margin)), top });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    if (bubble.current) observer.observe(bubble.current);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    measure();
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); };
  }, [step]);

  useEffect(() => { bubble.current?.querySelector<HTMLButtonElement>('[data-next]')?.focus(); }, [index]);

  if (!step) return null;
  return <dialog ref={dialog} className="tour-overlay" aria-labelledby="guide-title" aria-describedby="guide-description"
    onCancel={event => { event.preventDefault(); close(); }}>
    <svg className="tour-shade" aria-hidden="true" width="100%" height="100%">
      <defs><mask id="guide-cutout"><rect width="100%" height="100%" fill="white" />
        {geometry && <rect x={geometry.x} y={geometry.y} width={geometry.width} height={geometry.height} rx="8" fill="black" />}</mask></defs>
      <rect width="100%" height="100%" fill="rgba(15,23,42,.62)" mask="url(#guide-cutout)" />
      {geometry && <rect x={geometry.x} y={geometry.y} width={geometry.width} height={geometry.height} rx="8" fill="none" stroke="#75b4ff" strokeWidth="2" />}
    </svg>
    <div ref={bubble} className="tour-bubble" style={{ left: geometry?.left ?? 12, top: geometry?.top ?? 12, visibility: geometry ? 'visible' : 'hidden' }}>
      <div className="tour-step">使用引导 · {index + 1} / {available.length}<button onClick={close} aria-label="关闭引导">✕</button></div>
      <h2 id="guide-title">{step.title}</h2><p id="guide-description">{step.text}</p>
      <div className="tour-actions"><button onClick={close}>跳过</button><span />
        {index > 0 && <button onClick={() => setIndex(index - 1)}>上一步</button>}
        <button data-next className="primary" onClick={() => index === available.length - 1 ? close() : setIndex(index + 1)}>{index === available.length - 1 ? '开始使用' : '下一步'}</button>
      </div>
    </div>
  </dialog>;
}
