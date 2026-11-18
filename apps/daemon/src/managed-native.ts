import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { runNative } from './native.js';
import type { NativeSpawnOpts } from './native.js';
import type { Run } from '@agentdesk/core';

// A Windows Job tracks descendants even if their parent exits. The worker is
// assigned before it can start, and closing the supervisor kills a live job.
const windowsJob = String.raw`
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class AgentdeskJob {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct Startup {
    public int Size;
    public string Reserved, Desktop, Title;
    public int X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
    public short Show, ReservedSize;
    public IntPtr ReservedBytes, In, Out, Error;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct Child {
    public IntPtr Process, Thread;
    public int Pid, Tid;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ProcessLimit;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct Limits {
    public BasicLimits Basic;
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct Accounting {
    public long User, Kernel, PeriodUser, PeriodKernel;
    public uint PageFaults, Total, Active, Terminated;
  }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateJobObject(IntPtr attrs, string name);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int kind, ref Limits limits, int size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, int size, IntPtr used);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcess(string name, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit,
    uint flags, IntPtr env, string cwd, ref Startup startup, out Child child);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll")]
  static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetExitCodeProcess(IntPtr process, out uint status);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);

  static void Check(bool ok, string operation) {
    if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
  }
  static string Quote(string arg) {
    var command = new StringBuilder("\"");
    int slashes = 0;
    foreach (char ch in arg) {
      if (ch == '\\') { slashes++; continue; }
      command.Append('\\', ch == '"' ? 2 * slashes + 1 : slashes).Append(ch);
      slashes = 0;
    }
    return command.Append('\\', 2 * slashes).Append('"').ToString();
  }
  static void Save(string control, string fields) {
    string result = control + ".result";
    File.WriteAllText(result + ".tmp", "{\"stoppedAt\":\"" + DateTime.UtcNow.ToString("o") + "\"," + fields + "}");
    File.Move(result + ".tmp", result);
  }
  static uint Active(IntPtr job) {
    Accounting info;
    Check(QueryInformationJobObject(job, 1, out info, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero),
      "QueryInformationJobObject");
    return info.Active;
  }
  public static uint CheckJob(string name) {
    IntPtr job = OpenJobObject(4, false, name); // JOB_OBJECT_QUERY
    if (job == IntPtr.Zero && Marshal.GetLastWin32Error() == 2) return 0;
    Check(job != IntPtr.Zero, "OpenJobObject");
    try { return Active(job); }
    finally { CloseHandle(job); }
  }
  public static void Run(string[] args, string control, int timeout, string name) {
    const uint stopped = 0xec0000ad;
    string cancel = control + ".cancel";
    if (File.Exists(cancel)) { Save(control, "\"exitCode\":null,\"cancelled\":true"); return; }
    IntPtr job = CreateJobObject(IntPtr.Zero, name);
    int createError = Marshal.GetLastWin32Error();
    Check(job != IntPtr.Zero, "CreateJobObject");
    if (createError == 183) {
      CloseHandle(job);
      throw new Win32Exception(createError, "CreateJobObject");
    }
    Child child = new Child();
    try {
      var limits = new Limits();
      limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      int limitSize = Marshal.SizeOf(limits);
      Check(SetInformationJobObject(job, 9, ref limits, limitSize), "SetInformationJobObject");
      var startup = new Startup { Flags = 0x100, In = GetStdHandle(-10), Out = GetStdHandle(-11), Error = GetStdHandle(-12) };
      startup.Size = Marshal.SizeOf(startup);
      var command = new StringBuilder(String.Join(" ", Array.ConvertAll(args, Quote)));
      Check(CreateProcess(args[0], command, IntPtr.Zero, IntPtr.Zero, true, 0x08000004, IntPtr.Zero, null, ref startup, out child),
        "CreateProcess");
      if (!AssignProcessToJobObject(job, child.Process)) {
        int error = Marshal.GetLastWin32Error();
        TerminateProcess(child.Process, stopped);
        WaitForSingleObject(child.Process, 0xffffffff);
        throw new Win32Exception(error, "AssignProcessToJobObject");
      }
      File.WriteAllText(control + ".active", name + "\n" + child.Pid.ToString());
      bool cancelled = File.Exists(cancel);
      bool timedOut = false;
      if (!cancelled) {
        Check(ResumeThread(child.Thread) != 0xffffffff, "ResumeThread");
        var timer = Stopwatch.StartNew();
        while (true) {
          uint state = WaitForSingleObject(child.Process, 150);
          if (state == 0) break;
          Check(state == 258, "WaitForSingleObject");
          cancelled = File.Exists(cancel);
          timedOut = !cancelled && timer.ElapsedMilliseconds >= timeout;
          if ((!cancelled && !timedOut) || WaitForSingleObject(child.Process, 0) == 0) {
            cancelled = timedOut = false;
            continue;
          }
          break;
        }
      }
      if (cancelled || timedOut) {
        Check(TerminateJobObject(job, stopped), "TerminateJobObject");
        while (Active(job) > 0) Thread.Sleep(100);
      }
      uint exit;
      Check(GetExitCodeProcess(child.Process, out exit), "GetExitCodeProcess");
      if (exit == stopped && (cancelled || timedOut)) {
        Save(control, cancelled ? "\"exitCode\":null,\"cancelled\":true" : "\"exitCode\":null,\"timedOut\":true");
      } else {
        Save(control, "\"exitCode\":" + unchecked((int)exit).ToString(System.Globalization.CultureInfo.InvariantCulture));
        // Normal exits retain the previous behavior for background children.
        limits.Basic.Flags = 0;
        Check(SetInformationJobObject(job, 9, ref limits, limitSize), "SetInformationJobObject");
      }
    } finally {
      if (child.Thread != IntPtr.Zero) CloseHandle(child.Thread);
      if (child.Process != IntPtr.Zero) CloseHandle(child.Process);
      CloseHandle(job);
    }
  }
}
`;

const windowsScript = Buffer.from(String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$spec = ConvertFrom-Json $env:AGENTDESK_RUN_SPEC
Remove-Item Env:\AGENTDESK_RUN_SPEC
Add-Type -TypeDefinition @'
${windowsJob}
'@
if ($spec.query) {
  [Console]::WriteLine([AgentdeskJob]::CheckJob($spec.name))
} else {
  [AgentdeskJob]::Run([string[]]$spec.cmd, $spec.control, [int]$spec.timeout, $spec.name)
}
`, 'utf16le').toString('base64');

// The POSIX supervisor owns a dedicated process group and outlives the daemon.
const posixScript = String.raw`
const { spawn, execFileSync } = require('node:child_process');
const { existsSync, writeFileSync, renameSync } = require('node:fs');
const { cmd, control, timeout } = JSON.parse(process.env.AGENTDESK_RUN_SPEC);
delete process.env.AGENTDESK_RUN_SPEC;
const requested = () => existsSync(control + '.cancel');
function finish(result) {
  writeFileSync(control + '.result.tmp', JSON.stringify({ stoppedAt: new Date().toISOString(), ...result }));
  renameSync(control + '.result.tmp', control + '.result');
  process.exitCode = 0;
}
writeFileSync(control + '.active', '');
if (requested()) { finish({ exitCode: null, cancelled: true }); process.exit(0); }
const child = spawn(cmd[0], cmd.slice(1), { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
if (child.pid) writeFileSync(control + '.active', JSON.stringify({ kind: 'posix', pgid: child.pid, control }));
const start = Date.now();
let reason, exit;
child.once('exit', (code, signal) => { exit = { code, signal }; });
child.once('error', error => { clearInterval(timer); finish({ exitCode: null, error: error.message }); });
const timer = setInterval(() => {
  if (exit && !reason) {
    clearInterval(timer);
    finish({ exitCode: exit.code });
    return;
  }
  if (!reason && (requested() || Date.now() - start >= timeout)) {
    const stop = requested() ? 'cancelled' : 'timedOut';
    try { process.kill(-child.pid, 'SIGKILL'); reason = stop; }
    catch (error) { if (error.code !== 'ESRCH') console.error(error.message); }
  }
  if (!reason || !exit) return;
  try {
    const processes = execFileSync('ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8', timeout: 2000 });
    const alive = processes.split('\n').some(line => {
      const [group, state] = line.trim().split(/\s+/);
      return Number(group) === child.pid && !state.startsWith('Z');
    });
    if (alive) return;
    clearInterval(timer);
    finish(exit.signal === 'SIGKILL' ? { exitCode: null, [reason]: true } : { exitCode: exit.code });
  } catch (error) { console.error(error.message); }
}, 150);
`;

export function nativeExecution(control: string): Run['execution'] {
  const path = control + '.result';
  if (!existsSync(path)) return;
  return JSON.parse(readFileSync(path, 'utf8')) as Run['execution'];
}

export function runManagedNative(opts: NativeSpawnOpts, control: string, onPid: (pid: number) => void) {
  const spec = JSON.stringify({ cmd: opts.cmd, timeout: opts.timeoutMs, control, name: windowsJobName(control) });
  const cmd = process.platform === 'win32' ? windowsCommand() : [process.execPath, '-e', posixScript];
  return runNative({ ...opts, cmd, env: [...(opts.env ?? []), 'AGENTDESK_RUN_SPEC=' + spec], timeoutMs: 0 },
    child => { if (child.pid) onPid(child.pid); });
}

function windowsCommand() {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  return [systemRoot + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', windowsScript];
}

function windowsJobName(control: string) {
  return 'Global\\Agentdesk-' + createHash('sha256').update(control).digest('hex');
}

/** Read-only recovery check. A PID from the prior daemon is never signalled. */
export async function stoppedWindowsJob(control: string, cwd: string): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const [name, pidText] = readFileSync(control + '.active', 'utf8').split('\n');
  const pid = Number(pidText);
  if (name !== windowsJobName(control) || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  const spec = JSON.stringify({ query: true, name });
  const result = await runNative({ cmd: windowsCommand(), cwd, env: ['AGENTDESK_RUN_SPEC=' + spec], timeoutMs: 5000 });
  if (result.exitCode !== 0 || !/^\d+$/.test(result.out.at(-1) ?? '')) {
    throw new Error(result.err.at(-1) ?? '无法读取 Windows Job 状态');
  }
  return result.out.at(-1) === '0';
}

/** POSIX recovery checks a persisted process group without signalling any PID. */
export async function stoppedNativeGroup(control: string, cwd: string): Promise<boolean> {
  if (process.platform === 'win32') return stoppedWindowsJob(control, cwd);
  let active: { kind?: string; pgid?: number; control?: string };
  try { active = JSON.parse(readFileSync(control + '.active', 'utf8')); } catch { return false; }
  if (active.kind !== 'posix' || active.control !== control || !Number.isSafeInteger(active.pgid) || active.pgid! <= 0) return false;
  const result = await runNative({ cmd: ['ps', '-axo', 'pgid=,stat='], cwd, timeoutMs: 5000 });
  if (result.exitCode !== 0) throw new Error('无法读取受管进程组状态。');
  return !result.out.some(line => {
    const [group, state] = line.trim().split(/\s+/);
    return Number(group) === active.pgid && state && !state.startsWith('Z');
  });
}
