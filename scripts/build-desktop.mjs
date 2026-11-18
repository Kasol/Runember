import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const base={absWorkingDir:root,bundle:true,platform:'node',target:'node24',external:['electron'],logLevel:'info'};
await build({...base,entryPoints:['apps/desktop/src/main.ts'],outfile:'apps/desktop/dist/main.mjs',format:'esm',
  banner:{js:"import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"}});
await build({...base,entryPoints:['apps/desktop/src/preload.ts'],outfile:'apps/desktop/dist/preload.cjs',format:'cjs'});
