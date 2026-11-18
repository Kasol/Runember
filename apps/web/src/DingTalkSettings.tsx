import { useEffect, useState } from 'react';
import type { LanguagePreference } from '@agentdesk/core';
import { client } from './api';
import { Modal } from './ui';

export function DingTalkSettings({ onClose }: { onClose: () => void }) {
  const [language, setLanguage] = useState<LanguagePreference>('auto');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    client.dingtalkSettings().then(settings => {
      if (active) { setLanguage(settings.language); setLoading(false); }
    }).catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, []);
  const save = async () => {
    setSaving(true);
    setError('');
    try { await client.updateDingtalkSettings(language); onClose(); }
    catch (e) { setError((e as Error).message); setSaving(false); }
  };
  return <Modal title="钉钉设置" onClose={onClose}>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <label className="labeled">回复与通知语言
        <select value={language} disabled={loading || saving}
          onChange={event => setLanguage(event.target.value as LanguagePreference)}>
          <option value="auto">自动（跟随指令）</option>
          <option value="zh-CN">中文</option>
          <option value="en">English</option>
        </select>
      </label>
      <p className="dim">自动模式跟随中文或英文指令；群通知沿用该群最近的指令语言。选择固定语言后，对所有钉钉会话生效。</p>
      <p className="dim">设置保存后立即生效，覆盖帮助、状态回复和通知。任务描述与 Agent 答复按原文展示。</p>
      {error && <p className="banner" role="alert">{error}</p>}
      <div className="row">
        <button className="primary" type="submit" disabled={loading || saving}>{saving ? '保存中…' : '保存'}</button>
        <button type="button" onClick={onClose}>取消</button>
      </div>
    </form>
  </Modal>;
}
