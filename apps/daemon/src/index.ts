/**
 * agentdesk daemon 入口。
 * 启动: npm run daemon [-- --data-dir ./data/agentdesk --port 8787 --config path]
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import Docker from 'dockerode';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { EventBus, buildNotifiers } from './notify.js';
import { Runner } from './runner.js';
import { Scheduler } from './scheduler.js';
import { buildServer } from './server.js';

// 开发便利：仓库根有 .env 就载入（代理等），不覆盖已有环境变量
function loadDotEnv(): void {
  const p = new URL('../../../../.env', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!;
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  loadDotEnv();
  const cfg = loadConfig({
    configPath: arg('--config'),
    dataDir: arg('--data-dir'),
    port: arg('--port') ? Number(arg('--port')) : undefined,
  });

  // 单实例锁：多个 daemon 并存时各自持有一条钉钉 Stream 连接，
  // 钉钉把消息推给每条连接 → 指令重复执行/双回复。锁文件在 dataDir 下。
  const lockPath = join(cfg.dataDir, 'daemon.lock');
  if (existsSync(lockPath)) {
    try {
      const { pid, startedAt } = JSON.parse(readFileSync(lockPath, 'utf8'));
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch { /* 死进程 */ }
      if (alive) {
        console.error(`❌ 检测到已有 daemon 实例在运行（PID ${pid}，启动于 ${startedAt}）。`);
        console.error('   多实例并存会导致钉钉重复回复/指令重复执行。');
        console.error(`   如确认是僵尸锁：删除 ${lockPath} 后重试。`);
        process.exit(1);
      }
      console.log('（发现过期锁文件，已忽略）');
    } catch { /* 损坏的锁文件，直接覆盖 */ }
  }
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  const unlock = () => { try { unlinkSync(lockPath); } catch { /* noop */ } };
  process.on('exit', unlock);

  console.log(`agentdesk daemon 启动中…`);
  console.log(`  dataDir=${cfg.dataDir}  并发=${cfg.scheduler.concurrency}  超时=${cfg.scheduler.taskTimeoutMin}min`);
  if (cfg.proxy.httpsProxy) console.log(`  容器代理=${cfg.proxy.httpsProxy}`);

  const store = new Store(cfg.dataDir);
  const notifiers = buildNotifiers(
    cfg.notify.channels,
    cfg.server.publicUrl,
    cfg.feedback.dingtalkStream?.clientId
      ? { clientId: cfg.feedback.dingtalkStream.clientId, clientSecret: cfg.feedback.dingtalkStream.clientSecret }
      : undefined,
  );
  const events = new EventBus(notifiers);
  const docker = new Docker();
  const runner = new Runner({ docker, cfg, store, events });
  const scheduler = new Scheduler(cfg, store, runner);
  const app = buildServer({ cfg, store, scheduler, docker, notifiers });

  await app.listen({ host: cfg.server.host, port: cfg.server.port });
  console.log(`✅ API 就绪 http://${cfg.server.host}:${cfg.server.port}（token 鉴权${cfg.server.token ? '开' : '关'}）`);
  scheduler.start();

  // 反馈通道（配置了才启动）：@机器人 指令 → 统一动作入口 → 回复进群
  let feedbackChannel: import('@agentdesk/core').FeedbackChannel | undefined;
  if (cfg.feedback.dingtalkStream?.clientId) {
    const { DingTalkStreamChannel } = await import('./dingtalk-stream.js');
    const { initState } = await import('./dingtalk-state.js');
    initState(cfg.dataDir); // 群标识持久化文件（应用机器人主动推送需要）
    feedbackChannel = new DingTalkStreamChannel(cfg.feedback.dingtalkStream);
    const { applyTaskAction } = await import('./actions.js');
    await feedbackChannel.start(action => applyTaskAction(store, scheduler, action));
  } else {
    console.log('ℹ️ 未配置反馈通道（feedback.dingtalkStream）—— 阻塞反馈需走 CLI');
  }

  const shutdown = async () => {
    console.log('\n👋 优雅停机…');
    scheduler.stop();
    feedbackChannel?.stop?.();
    unlock();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch(e => { console.error('daemon 启动失败:', e); process.exit(1); });
