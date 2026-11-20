import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { detectedAgentPaths } from '../src/agent-runtime.js';
import { findHostCodex } from '../src/native.js';
test('standalone discovery works with stale PATH and preserves explicit overrides', {skip:process.platform!=='win32'}, () => {
  const root=mkdtempSync(join(tmpdir(),'codex-discovery-'));
  const old=Object.fromEntries(['LOCALAPPDATA','PATH','CODEX_INSTALL_DIR','AGENTDESK_CODEX_PATH'].map(k=>[k,process.env[k]]));
  try {
    process.env.LOCALAPPDATA=root;process.env.PATH='';delete process.env.CODEX_INSTALL_DIR;delete process.env.AGENTDESK_CODEX_PATH;
    const stable=join(root,'Programs','OpenAI','Codex','bin','codex.exe');mkdirSync(dirname(stable),{recursive:true});writeFileSync(stable,'fixture');
    const legacy=join(root,'OpenAI','Codex','bin','hash','codex.exe');mkdirSync(dirname(legacy),{recursive:true});writeFileSync(legacy,'fixture');
    assert.deepEqual(detectedAgentPaths('codex'),[stable,legacy]);assert.equal(findHostCodex(),stable);
    process.env.AGENTDESK_CODEX_PATH=legacy;assert.equal(findHostCodex(),legacy);delete process.env.AGENTDESK_CODEX_PATH;
    process.env.CODEX_INSTALL_DIR=join(root,'custom');mkdirSync(process.env.CODEX_INSTALL_DIR);const custom=join(process.env.CODEX_INSTALL_DIR,'codex.exe');writeFileSync(custom,'fixture');
    assert.equal(detectedAgentPaths('codex')[0],custom);assert.equal(findHostCodex(),custom);
    rmSync(custom);assert.equal(findHostCodex(),stable);
  } finally {for(const [k,v] of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v}rmSync(root,{recursive:true,force:true});}
});
