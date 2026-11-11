/**
 * agentdesk daemon 入口。
 * 启动: npm run daemon [-- --data-dir ./data/agentdesk --port 8787 --config path]
 */
import { readFileSync, existsSync } from 'node:fs';
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
  console.log(`agentdesk daemon 启动中…`);
  console.log(`  dataDir=${cfg.dataDir}  并发=${cfg.scheduler.concurrency}  超时=${cfg.scheduler.taskTimeoutMin}min`);
  if (cfg.proxy.httpsProxy) console.log(`  容器代理=${cfg.proxy.httpsProxy}`);

  const store = new Store(cfg.dataDir);
  const notifiers = buildNotifiers(cfg.notify.channels, cfg.server.publicUrl);
  const events = new EventBus(notifiers);
  const docker = new Docker();
  const runner = new Runner({ docker, cfg, store, events });
  const scheduler = new Scheduler(cfg, store, runner);
  const app = buildServer({ cfg, store, scheduler, docker, notifiers });

  await app.listen({ host: cfg.server.host, port: cfg.server.port });
  console.log(`✅ API 就绪 http://${cfg.server.host}:${cfg.server.port}（token 鉴权${cfg.server.token ? '开' : '关'}）`);
  scheduler.start();

  const shutdown = async () => {
    console.log('\n👋 优雅停机…');
    scheduler.stop();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch(e => { console.error('daemon 启动失败:', e); process.exit(1); });
