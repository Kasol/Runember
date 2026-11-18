import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Docker from 'dockerode';
import { commandLanguage, DingTalkLanguage } from '../src/dingtalk-language.js';
import { applyTaskAction } from '../src/actions.js';
import { buildServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import type { Scheduler } from '../src/scheduler.js';

test('language follows the command, remembers each user, and persists fixed preferences', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdesk-language-'));
  let store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(commandLanguage('开始 selftest Write a response in English'), 'zh-CN');
  assert.equal(commandLanguage('start selftest 用中文答复'), 'en');
  assert.equal(commandLanguage('@robot 55 继续：确认'), 'zh-CN');
  assert.equal(commandLanguage('55 continue'), 'en');
  assert.equal(commandLanguage('?'), undefined);
  const languages = new DingTalkLanguage(store);
  assert.equal(languages.preference(), 'auto');
  assert.equal(languages.resolve('help', 'group', 'alice'), 'en');
  assert.equal(languages.resolve('帮助', 'group', 'bob'), 'zh-CN');
  assert.equal(languages.resolve('?', 'group', 'alice'), 'en');
  assert.equal(languages.notification('group'), 'zh-CN');
  assert.equal(languages.notification('another'), 'zh-CN');
  store.setSetting('dingtalk.language', 'en');
  assert.equal(languages.resolve('帮助', 'group', 'bob'), 'en');
  assert.equal(languages.notification('group'), 'en');
  store.close();
  store = new Store(dir);
  assert.equal(new DingTalkLanguage(store).preference(), 'en');
  store.setSetting('dingtalk.language', 'auto');
  assert.equal(new DingTalkLanguage(store).resolve('?', 'group', 'alice'), 'en');
  const dispatch = (language: 'en' | 'zh-CN') => applyTaskAction(store, {} as Scheduler, { type: 'help', language }, 'dingtalk');
  const zh = (await dispatch('zh-CN')).message;
  const en = (await dispatch('en')).message;
  assert.match(zh, /开始/);
  assert.doesNotMatch(zh, /start|resume|retry|draft|status/);
  assert.match(en, /start/);
  assert.doesNotMatch(en, /[\u4e00-\u9fff]|retry|draft \[/);
  assert.doesNotMatch(zh, /`草稿|`重试|`最近活动/);
});

test('DingTalk language settings validate input, respect authentication and apply immediately', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdesk-settings-'));
  const cfg = loadConfig({ configPath: join(dir, 'missing.json'), dataDir: dir });
  cfg.server.token = '';
  const store = new Store(dir);
  const app = buildServer({ cfg, store, scheduler: {} as Scheduler, docker: new Docker(), notifiers: [] });
  t.after(async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.deepEqual((await app.inject('/api/settings/dingtalk')).json(), { language: 'auto' });
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/settings/dingtalk', payload: { language: 'fr' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/settings/dingtalk', remoteAddress: '192.0.2.1', payload: { language: 'en' } })).statusCode, 403);
  cfg.server.token = 'fixture-settings';
  const languages = new DingTalkLanguage(store);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/settings/dingtalk', payload: { language: 'en' } })).statusCode, 401);
  const headers = { 'x-agentdesk-token': cfg.server.token };
  for (const language of ['en', 'zh-CN', 'auto'] as const) {
    const response = await app.inject({ method: 'PATCH', url: '/api/settings/dingtalk', headers, payload: { language } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { language });
    assert.equal(languages.preference(), language);
    assert.deepEqual((await app.inject({ url: '/api/settings/dingtalk', headers })).json(), { language });
  }
});
