import { statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';

/** Prompts longer than this go through a file, well under the Windows command-line limit (32k chars). */
export const INLINE_LIMIT = 24_000;

export interface Launch {
  file: string;
  args: string[];
  /** Windows .cmd/.bat shims only start through cmd.exe: run `commandLine` with shell: true. */
  shell: boolean;
  commandLine?: string;
}

function envPath(env: NodeJS.ProcessEnv): string {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  return (key ? env[key] : '') ?? '';
}

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Find a command the way a shell would: an explicit path, or the first match on PATH (with PATHEXT on Windows). */
export function resolveExecutable(cmd: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const win = platform === 'win32';
  const exts = win ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const hasExt = (p: string) => exts.some((e) => e !== '' && extname(p).toUpperCase() === e.toUpperCase());
  const candidates = (base: string): string[] => (!win ? [base] : hasExt(base) ? [base] : exts.map((e) => base + e));
  if (isAbsolute(cmd) || cmd.includes('/') || (win && cmd.includes('\\'))) return candidates(cmd).find(isFile) ?? null;
  for (const dir of envPath(env).split(win ? ';' : delimiter).filter(Boolean)) {
    for (const c of candidates(join(dir, cmd))) if (isFile(c)) return c;
  }
  return null;
}

/**
 * Quote one argument for cmd.exe. Plain tokens pass as they are; anything else is wrapped in double quotes.
 * cmd.exe expands % even inside quotes and cannot carry " or a newline inside one argument, so those are refused.
 */
export function quoteForCmd(arg: string): string {
  if (/^[A-Za-z0-9_.:\\/=+@,-]+$/.test(arg)) return arg;
  if (/["%\r\n]/.test(arg)) throw new Error(`Cannot pass this argument through cmd.exe: ${JSON.stringify(arg.slice(0, 80))}`);
  return `"${arg}"`;
}

export function fill(template: string[], vars: Record<string, string>): string[] {
  return template.map((a) => a.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m));
}

export const pointerLine = (promptFile: string): string => `Read the file ${promptFile} and follow the instructions in it exactly.`;

/** Turn an agent template plus a prompt into something child_process.spawn can run on this platform. */
export function buildLaunch(
  template: string[],
  opts: { prompt: string; promptFile: string },
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Launch {
  const [cmd, ...rest] = template as [string, ...string[]];
  const file = resolveExecutable(cmd, env, platform);
  if (!file) throw new Error(`Agent command "${cmd}" was not found on PATH. Install it or fix the template in config.json.`);
  const shell = platform === 'win32' && /\.(cmd|bat)$/i.test(file);
  const viaFile = shell || opts.prompt.length > INLINE_LIMIT;
  const args = fill(rest, { prompt: viaFile ? pointerLine(opts.promptFile) : opts.prompt });
  if (!shell) return { file, args, shell };
  return { file, args, shell, commandLine: [file, ...args].map(quoteForCmd).join(' ') };
}

/** One readable line for --dry-run output. */
export function describeLaunch(l: Launch): string {
  if (l.commandLine) return l.commandLine;
  const short = (a: string) => (a.length > 120 || a.includes('\n') ? `${a.replace(/\s+/g, ' ').slice(0, 60)}...` : a);
  const q = (a: string) => (/[\s"'$`;&|<>]/.test(a) || a === '' ? `"${short(a)}"` : a);
  return [l.file, ...l.args].map(q).join(' ');
}
