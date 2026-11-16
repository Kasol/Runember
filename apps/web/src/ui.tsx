import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';

export function Modal({ title, onClose, children, layout = 'form' }: {
  title: string; onClose: () => void; children: ReactNode; layout?: 'form' | 'setup' | 'detail';
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useLayoutEffect(() => {
    const dialog = dialogRef.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  return (
    <dialog ref={dialogRef} className="overlay" aria-labelledby={titleId}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      onCancel={e => { e.preventDefault(); onClose(); }}>
      <div className={`panel panel-${layout}`}>
        <div className="panel-head">
          <h3 id={titleId}>{title}</h3>
          <button className="close" type="button" aria-label="关闭" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </dialog>
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
