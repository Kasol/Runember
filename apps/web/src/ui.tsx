import type { ReactNode } from 'react';

/** 通用弹窗：遮罩 + 面板 + 标题栏。点击遮罩/✕ 关闭（由父级通过 onClose 收起） */
export function Modal(props: { title: string; onClose: () => void; children: ReactNode; width?: number }) {
  return (
    <div className="overlay" onClick={props.onClose}>
      <div
        className="panel form"
        style={props.width ? { width: `min(${props.width}px, 94vw)` } : undefined}
        onClick={e => e.stopPropagation()}
      >
        <div className="panel-head">
          <h3>{props.title}</h3>
          <button className="close" onClick={props.onClose}>✕</button>
        </div>
        {props.children}
      </div>
    </div>
  );
}

/** 带标签的表单字段容器 */
export function Labeled(props: { label: string; children: ReactNode }) {
  return (
    <div className="labeled">
      <label>{props.label}</label>
      {props.children}
    </div>
  );
}

/** 底部操作行（主按钮 + 次按钮） */
export function FormActions(props: { primary: string; onPrimary: () => void; disabled?: boolean; secondary?: string; onSecondary?: () => void }) {
  return (
    <div className="row">
      <button className="primary" disabled={props.disabled} onClick={props.onPrimary}>{props.primary}</button>
      {props.secondary && <button onClick={props.onSecondary}>{props.secondary}</button>}
    </div>
  );
}
