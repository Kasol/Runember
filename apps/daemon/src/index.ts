/**
 * agentdesk daemon 入口。
 * 启动: npm run daemon [-- --data-dir ./data/agentdesk --log-dir logs --port 8787 --config path]
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import Docker from 'dockerode';
import { loadConfig, loadLocalEnv } from './config.js';
import { Store } from './store.js';
import { EventBus, buildNotifiers } from './notify.js';
import { DingTalkReports } from './dingtalk-reports.js';
import { DingTalkLanguage } from './dingtalk-language.js';
import { Runner } from './runner.js';
import { Scheduler } from './scheduler.js';
import { buildServer } from './server.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  loadLocalEnv();
  const cfg = loadConfig({
    configPath: arg('--config'),
    dataDir: arg('--data-dir'),
    logDir: arg('--log-dir'),
    port: arg('--port') ? Number(arg('--port')) : undefined,
  });
  const webDir = resolve(arg('--web-dir') ?? process.env.AGENTDESK_WEB_DIR ?? 'apps/web/dist');
  const instanceId = randomUUID();
  const key = randomUUID();

  // 单实例锁：多个 daemon 并存时各自持有一条钉钉 Stream 连接，
  // 钉钉把消息推给每条连接 → 指令重复执行/双回复。锁文件在 dataDir 下。
  const lockPath = join(cfg.dataDir, 'daemon.lock');
  mkdirSync(cfg.dataDir, { recursive: true });
  if (existsSync(lockPath)) {
    let prior: { pid?: number; startedAt?: string } = {};
    try { prior = JSON.parse(readFileSync(lockPath, 'utf8')); } catch { /* 下方检查文件年龄 */ }
    if (prior?.pid && Number.isSafeInteger(prior.pid) && prior.pid > 0) {
      let alive = true;
      try { process.kill(prior.pid, 0); } catch (error) {
        alive = (error as NodeJS.ErrnoException).code !== 'ESRCH';
      }
      if (alive) throw new Error(`数据目录已有 daemon 实例（PID ${prior.pid}）`);
    } else if (Date.now() - statSync(lockPath).mtimeMs < 5_000) {
      throw new Error('数据目录锁可能正在写入，请稍后重试');
    }
    unlinkSync(lockPath);
  }
  writeFileSync(lockPath, JSON.stringify({
    pid: process.pid, startedAt: new Date().toISOString(), instanceId, key, port: cfg.server.port,
  }), { flag: 'wx', mode: 0o600 });
  const unlock = () => {
    try {
      if (JSON.parse(readFileSync(lockPath, 'utf8')).instanceId === instanceId) unlinkSync(lockPath);
    } catch { /* 无需释放 */ }
  };
  process.on('exit', unlock);

  mkdirSync(join(cfg.logDir, 'runs'), { recursive: true });
  console.log(`Runember daemon 启动中…`);
  console.log(`  dataDir=${cfg.dataDir}  并发=${cfg.scheduler.concurrency}  超时=${cfg.scheduler.taskTimeoutMin}min`);
  console.log(`  logDir=${cfg.logDir}`);
  if (cfg.proxy.httpsProxy || cfg.proxy.httpProxy) console.log('  已配置容器代理');

  const store = new Store(cfg.dataDir);
  const languages = new DingTalkLanguage(store);
  const reports = cfg.notify.dingtalkReport?.executable ? new DingTalkReports(cfg.notify.dingtalkReport, store, cfg.logDir) : undefined;
  const notifiers = buildNotifiers(
    cfg.notify.channels,
    cfg.server.publicUrl,
    cfg.feedback.dingtalkStream?.clientId
      ? { clientId: cfg.feedback.dingtalkStream.clientId, clientSecret: cfg.feedback.dingtalkStream.clientSecret }
      : undefined,
    reports?.publish,
    languages.notification,
    store,
  );
  const events = new EventBus(notifiers);
  const docker = new Docker();
  const runner = new Runner({ docker, cfg, store, events });
  const scheduler = new Scheduler(cfg, store, runner);
  let feedbackChannel: import('@agentdesk/core').FeedbackChannel | undefined;
  let stopping = false;
  const app = buildServer({
    cfg, store, scheduler, docker, notifiers, webDir,
    control: { instanceId, key, stop: () => void shutdown() },
  });

  await app.listen({ host: cfg.server.host, port: cfg.server.port });
  console.log(`✅ API 就绪 http://${cfg.server.host}:${cfg.server.port}（token 鉴权${cfg.server.token ? '开' : '关'}）`);
  scheduler.start();

  // 反馈通道（配置了才启动）：@机器人 指令 → 统一动作入口 → 回复进群
  if (cfg.feedback.dingtalkStream?.clientId) {
    const { DingTalkStreamChannel } = await import('./dingtalk-stream.js');
    feedbackChannel = new DingTalkStreamChannel(cfg.feedback.dingtalkStream, undefined, languages.resolve);
    const { applyTaskAction } = await import('./actions.js');
    await feedbackChannel.start(action => applyTaskAction(store, scheduler, action, 'dingtalk'));
  } else {
    console.log('ℹ️ 未配置反馈通道（feedback.dingtalkStream）—— 阻塞反馈需走 CLI');
  }

  async function shutdown() {
    if (stopping) return;
    stopping = true;
    console.log('\n👋 优雅停机…');
    scheduler.stop();
    feedbackChannel?.stop?.();
    await app.close();
    await scheduler.drain();
    await events.drain();
    store.close();
    process.exit(0);
  }
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch(e => { console.error('daemon 启动失败:', e); process.exit(1); });
