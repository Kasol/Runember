// Compatibility entry.
if (process.platform !== 'win32') throw new Error('请在 Windows 上构建 Windows 运行时。');
await import('./release-runtime.mjs');
