import { useEffect, useState } from 'react';
import type { LanguagePreference } from '@agentdesk/core';
import { client } from './api';
import { Modal, Labeled } from './ui';

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
    <form className="dingtalk-settings" onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="dingtalk-language-card">
      <Labeled label="回复与通知语言">
        <select value={language} disabled={loading || saving}
          onChange={event => setLanguage(event.target.value as LanguagePreference)}>
          <option value="auto">自动（跟随指令）</option>
          <option value="zh-CN">中文</option>
          <option value="en">English</option>
        </select>
      </Labeled>
      <p className="settings-note">自动模式跟随中文或英文指令，群通知沿用该群最近的指令语言。固定语言会应用于所有钉钉会话。</p>
      </div>
      <p className="settings-note">保存后立即生效，适用于帮助、状态回复和通知。任务描述与 Agent 答复保持原文。</p>
      {error && <p className="banner" role="alert">{error}</p>}
      <div className="row settings-footer">
        <button className="primary" type="submit" disabled={loading || saving} aria-busy={saving}>保存</button>
        <button type="button" onClick={onClose}>取消</button>
      </div>
    </form>
  </Modal>;
}
