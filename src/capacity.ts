import { existsSync, readFileSync, statfsSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { configDir, home } from './paths.ts';
import { freeMemMb } from './ram.ts';
import type { Task } from './tasks.ts';

/**
 * Capacity, two optional files in config/:
 *
 * lane-capacity: how many crew members this home runs at once. The first non-comment line is the cap, a whole number, or `auto` for a
 * budget measured on every call from free memory, CPU load and disk. Keyed lines may follow (# starts a comment):
 *   min-avail-gb N   memory to keep available          min-disk-gb N   free disk to keep
 *   max-load1 X      a 1-minute load ceiling            reserve-flag <path> [label]   admit nothing while the file exists (repeatable)
 *   max-lanes N      auto only: a ceiling on lanes      admit-spawns    let the verdict hold spawns back (otherwise it only reports)
 * An unknown key, a repeated key or a malformed value makes the whole file invalid: the Boss's limits are never guessed.
 *
 * project-capacity: `<project> <N>` per line: at most N crew members of that project at once (a heavy test suite, a device). A place
 * is held by every build or survey of the project from its start until its PR is recorded or it is closed.
 *
 * A spawn beyond either stays queued and starts when a place frees (drain). A malformed file holds every new crew member back.
 */

export const laneCapacityPath = (env: NodeJS.ProcessEnv = process.env): string => join(configDir(env), 'lane-capacity');
export const projectCapacityPath = (env: NodeJS.ProcessEnv = process.env): string => join(configDir(env), 'project-capacity');

export interface LaneConfig {
  /** A fixed cap, or 'auto'. */
  cap: number | 'auto';
  minAvailGb?: number;
  minDiskGb?: number;
  maxLoad1?: number;
  maxLanes?: number;
  reserveFlags: { path: string; label: string }[];
  admitSpawns: boolean;
}

const stripComment = (line: string): string => line.replace(/(^|\s)#.*$/, '').trim();
const NUM_RE = /^\d+(\.\d+)?$/;

function expandHome(p: string): string {
  return p.startsWith('~/') || p.startsWith('~\\') ? join(os.homedir(), p.slice(2)) : p;
}

/** Parse lane-capacity; throws naming the line on anything malformed. */
export function parseLaneCapacity(text: string, where = 'lane-capacity'): LaneConfig {
  const lines = text.split(/\r?\n/).map((raw, i) => ({ n: i + 1, line: stripComment(raw) })).filter((l) => l.line);
  const first = lines.shift();
  if (!first) throw new Error(`${where}: empty: the first line must be the cap (a whole number) or auto`);
  if (first.line !== 'auto' && !/^\d{1,6}$/.test(first.line)) throw new Error(`${where} line ${first.n}: the cap must be a whole number or auto`);
  const cfg: LaneConfig = { cap: first.line === 'auto' ? 'auto' : Number(first.line), reserveFlags: [], admitSpawns: false };
  const seen = new Set<string>();
  for (const { n, line } of lines) {
    const [key = '', ...rest] = line.split(/\s+/);
    const bad = (why: string) => new Error(`${where} line ${n}: ${why}`);
    if (key !== 'reserve-flag') {
      if (seen.has(key)) throw bad(`"${key}" is given twice`);
      seen.add(key);
    }
    const num = (): number => {
      if (rest.length !== 1 || !NUM_RE.test(rest[0] as string)) throw bad(`"${key}" takes one number`);
      return Number(rest[0]);
    };
    switch (key) {
      case 'min-avail-gb':
        cfg.minAvailGb = num();
        break;
      case 'min-disk-gb':
        cfg.minDiskGb = num();
        break;
      case 'max-load1':
        cfg.maxLoad1 = num();
        break;
      case 'max-lanes':
        if (cfg.cap !== 'auto') throw bad('"max-lanes" only goes with auto');
        cfg.maxLanes = num();
        if (!Number.isInteger(cfg.maxLanes)) throw bad('"max-lanes" takes a whole number');
        break;
      case 'reserve-flag': {
        const path = rest[0];
        if (!path || !(path.startsWith('~/') || path.startsWith('~\\') || /^([A-Za-z]:[\\/]|\/)/.test(path))) throw bad('"reserve-flag" takes an absolute or ~/ path');
        cfg.reserveFlags.push({ path: expandHome(path), label: rest.slice(1).join(' ') || 'reserved' });
        break;
      }
      case 'admit-spawns':
        if (rest.length) throw bad('"admit-spawns" takes no value');
        cfg.admitSpawns = true;
        break;
      default:
        throw bad(`unknown key "${key}"`);
    }
  }
  return cfg;
}

/** Parse project-capacity: `<name> <N>` per line, the number last. A line that is `#`, starts with `# `, or starts with `#` and does not end in a number is a comment. Throws on anything else. */
export function parseProjectCapacity(text: string, where = 'project-capacity'): Map<string, number> {
  const caps = new Map<string, number>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const fields = line.split(/\s+/);
    const last = fields.at(-1) as string;
    if (line === '#' || /^#\s/.test(line) || (line.startsWith('#') && !/^\d+$/.test(last))) return;
    if (fields.length < 2 || !/^\d{1,6}$/.test(last) || Number(last) < 1) throw new Error(`${where} line ${i + 1}: expected "<project> <capacity>", a positive whole number last`);
    const name = line.slice(0, line.length - last.length).trim();
    if (caps.has(name)) throw new Error(`${where} line ${i + 1}: project "${name}" is named twice`);
    caps.set(name, Number(last));
  });
  return caps;
}

function readOptional<T>(file: string, parse: (text: string, where: string) => T): { value: T | null; error?: string } {
  if (!existsSync(file)) return { value: null };
  try {
    return { value: parse(readFileSync(file, 'utf8'), file) };
  } catch (err) {
    return { value: null, error: (err as Error).message };
  }
}

export interface Vitals {
  availMb: number | null;
  totalMb: number;
  cores: number;
  load1: number | null;
  load5: number | null;
  diskFreeMb: number | null;
}

const envNum = (env: NodeJS.ProcessEnv, key: string): number | null => (env[key] !== undefined && env[key] !== '' && Number.isFinite(Number(env[key])) ? Number(env[key]) : null);

/** Busy share of all cores over a short sample, times the cores: Windows has no load average (os.loadavg() is always 0 there). */
function sampledLoad(ms = 250): number {
  const busy = () => os.cpus().reduce((a, c) => ({ idle: a.idle + c.times.idle, total: a.total + c.times.idle + c.times.user + c.times.nice + c.times.sys + c.times.irq }), { idle: 0, total: 0 });
  const a = busy();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const b = busy();
  const total = b.total - a.total;
  return total > 0 ? ((total - (b.idle - a.idle)) / total) * os.cpus().length : 0;
}

/** This machine's readings. AMIGO_FREE_MB, AMIGO_LOAD1, AMIGO_CORES and AMIGO_DISK_FREE_MB stand in for a probe (tests). */
export function readVitals(env: NodeJS.ProcessEnv = process.env): Vitals {
  const cores = envNum(env, 'AMIGO_CORES') ?? os.availableParallelism();
  let load1 = envNum(env, 'AMIGO_LOAD1');
  let load5 = load1;
  if (load1 === null) {
    if (process.platform === 'win32') {
      load1 = load5 = sampledLoad();
    } else {
      [load1, load5] = os.loadavg() as [number, number];
    }
  }
  let diskFreeMb = envNum(env, 'AMIGO_DISK_FREE_MB');
  if (diskFreeMb === null) {
    try {
      const s = statfsSync(existsSync(home(env)) ? home(env) : os.homedir());
      diskFreeMb = Math.floor((s.bavail * s.bsize) / 1024 / 1024);
    } catch {
      diskFreeMb = null;
    }
  }
  let availMb: number | null;
  try {
    availMb = freeMemMb(env);
  } catch {
    availMb = null;
  }
  return { availMb, totalMb: Math.floor(os.totalmem() / 1024 / 1024), cores, load1, load5, diskFreeMb };
}

/** What one crew member costs before anything is measured (2 GB, 1 core, 3 GB of disk). */
export const LANE_COST = { memMb: 2048, cores: 1, diskMb: 3072 };
/** A lane started this recently reserves a full lane's cost: its footprint is not visible to the probes yet. */
export const YOUNG_MS = 180_000;

/** A task that holds a lane: started and not closed (queued tasks have not started). */
export const holdsLane = (t: Task): boolean => t.status !== 'queued' && t.status !== 'closed';

export interface Verdict {
  admit: boolean;
  /** Lanes open for queued work; null without a cap. */
  freeLanes: number | null;
  reasons: string[];
  /** Whether the verdict may hold spawns back (lane-capacity exists, is valid and declares admit-spawns; a malformed file always does). */
  gating: boolean;
}

/** The lane verdict for one more crew member. `extraYoung` counts crew members started since `tasks` was read. */
export function laneVerdict(cfg: LaneConfig, tasks: Task[], v: Vitals, now: number = Date.now(), extraYoung = 0): Omit<Verdict, 'gating'> {
  const lanes = tasks.filter(holdsLane).length + extraYoung;
  const young = tasks.filter((t) => holdsLane(t) && t.startedAt && now - Date.parse(t.startedAt) < YOUNG_MS).length + extraYoung;
  const reasons: string[] = [];
  for (const f of cfg.reserveFlags) if (existsSync(f.path)) reasons.push(`reserve: ${f.label}`);
  if (cfg.maxLoad1 !== undefined && v.load1 !== null && v.load1 >= cfg.maxLoad1) reasons.push(`load: 1-minute load ${v.load1.toFixed(2)} is at or over max-load1 ${cfg.maxLoad1}`);
  if (cfg.cap === 'auto') {
    if (v.load1 !== null && v.load1 / v.cores >= 1) reasons.push(`cpu: 1-minute load ${v.load1.toFixed(2)} is at or over ${v.cores} cores`);
    const budgets: { name: string; open: number }[] = [];
    if (v.availMb !== null) {
      const keptMb = cfg.minAvailGb !== undefined ? cfg.minAvailGb * 1024 : Math.max(v.totalMb * 0.1, 2048);
      budgets.push({ name: 'memory', open: Math.floor((v.availMb - keptMb - young * LANE_COST.memMb) / LANE_COST.memMb) });
    }
    if (v.load1 !== null) budgets.push({ name: 'cpu', open: Math.floor((v.cores * 0.85 - Math.max(v.load1, v.load5 ?? v.load1) - young * LANE_COST.cores) / LANE_COST.cores) });
    if (v.diskFreeMb !== null) {
      const keptMb = (cfg.minDiskGb ?? 10) * 1024;
      budgets.push({ name: 'disk', open: Math.floor((v.diskFreeMb - keptMb - young * LANE_COST.diskMb) / LANE_COST.diskMb) });
    }
    if (cfg.maxLanes !== undefined) budgets.push({ name: 'ceiling', open: cfg.maxLanes - lanes });
    // Memory is the one reading the budget cannot do without: then only the static ceiling counts, or nothing.
    const usable = v.availMb === null ? budgets.filter((b) => b.name === 'ceiling') : budgets;
    if (v.availMb === null) reasons.push(`memory: unmeasurable${cfg.maxLanes === undefined ? ', and no max-lanes to fall back on' : ''}`);
    const tightest = usable.reduce<{ name: string; open: number } | null>((a, b) => (a === null || b.open < a.open ? b : a), null);
    const free = Math.max(0, tightest?.open ?? 0);
    if (free === 0 && tightest) reasons.push(`${tightest.name}: no room for another lane`);
    return { admit: free > 0 && reasons.length === 0, freeLanes: free, reasons };
  }
  if (v.load1 !== null && v.load1 >= v.cores) reasons.push(`cpu: 1-minute load ${v.load1.toFixed(2)} is at or over ${v.cores} cores`);
  if (v.availMb !== null) {
    if (cfg.minAvailGb !== undefined ? v.availMb - cfg.minAvailGb * 1024 < 1024 : (v.availMb / v.totalMb) * 100 < 10) reasons.push(`memory: ${v.availMb} MB available`);
  }
  if (v.diskFreeMb !== null && (v.diskFreeMb < 5120 || (cfg.minDiskGb !== undefined && v.diskFreeMb < cfg.minDiskGb * 1024))) reasons.push(`disk: ${v.diskFreeMb} MB free`);
  const free = reasons.length ? 0 : Math.max(0, cfg.cap - lanes);
  if (!reasons.length && free === 0) reasons.push(`full: ${lanes} of ${cfg.cap} lanes in use`);
  return { admit: free > 0 && reasons.length === 0, freeLanes: free, reasons };
}

/**
 * Whether one more crew member may start now, as far as lane capacity goes. Without lane-capacity, or without admit-spawns, it is
 * not gating (drain keeps its memory check). A malformed file gates and admits nothing.
 */
export function laneAdmission(tasks: Task[], env: NodeJS.ProcessEnv, extraYoung = 0, vitals: () => Vitals = () => readVitals(env)): Verdict {
  const file = laneCapacityPath(env);
  if (!existsSync(file)) return { admit: true, freeLanes: null, reasons: [], gating: false };
  const { value: cfg, error } = readOptional(file, parseLaneCapacity);
  if (!cfg) return { admit: false, freeLanes: 0, reasons: [`invalid lane capacity: ${error}`], gating: true };
  if (!cfg.admitSpawns) return { admit: true, freeLanes: null, reasons: [], gating: false };
  return { ...laneVerdict(cfg, tasks, vitals(), Date.now(), extraYoung), gating: true };
}

/** A task that holds one of its project's places: a started build or survey of that project, until its PR is recorded or it is closed. */
const holdsPlace = (t: Task, project: string): boolean => t.project === project && !t.scratch && !t.reviewOf && holdsLane(t) && !t.pr;

/** Why a task of `project` may not start for project capacity, or null. A malformed file holds every project task back. */
export function projectCapacityProblem(project: string, tasks: Task[], env: NodeJS.ProcessEnv, extra: string[] = []): string | null {
  const { value: caps, error } = readOptional(projectCapacityPath(env), parseProjectCapacity);
  if (error) return `invalid project capacity: ${error}`;
  const cap = caps?.get(project);
  if (cap === undefined) return null;
  const holders = [...tasks.filter((t) => holdsPlace(t, project)).map((t) => t.id), ...extra];
  return holders.length >= cap ? `${project} is at its capacity of ${cap} (held by ${holders.join(', ')})` : null;
}

/** Refuse a spawn before anything is made while a capacity file is malformed. */
export function checkCapacityFiles(env: NodeJS.ProcessEnv): void {
  const lanes = readOptional(laneCapacityPath(env), parseLaneCapacity);
  if (lanes.error) throw new Error(`Fix the lane capacity before spawning: ${lanes.error}`);
  const projects = readOptional(projectCapacityPath(env), parseProjectCapacity);
  if (projects.error) throw new Error(`Fix the project capacity before spawning: ${projects.error}`);
}

/** `amigo capacity`: one machine-readable line, then a short summary. Throws (exit 1) on a malformed file, after saying why. */
export function capacityReport(tasks: Task[], env: NodeJS.ProcessEnv = process.env): { text: string; ok: boolean } {
  const v = readVitals(env);
  const lanes = tasks.filter(holdsLane).length;
  const fmt = (x: number | null, digits = 0) => (x === null ? 'unknown' : x.toFixed(digits));
  const host = `load1=${fmt(v.load1, 2)} cores=${v.cores} mem_free_pct=${v.availMb === null ? 'unknown' : Math.round((v.availMb / v.totalMb) * 100)} disk_free_mb=${fmt(v.diskFreeMb)}`;
  const lane = readOptional(laneCapacityPath(env), parseLaneCapacity);
  const projects = readOptional(projectCapacityPath(env), parseProjectCapacity);
  const lines: string[] = [];
  let ok = true;
  if (lane.error) {
    ok = false;
    lines.push(`capacity: free_lanes=0 reason=invalid-target lanes=${lanes} target=invalid ${host}`, `Invalid: ${lane.error}`);
  } else if (!lane.value) {
    lines.push(`capacity: free_lanes=unknown reason=no-target lanes=${lanes} target=none ${host}`, `${lanes} lane(s) in use. No lane capacity is set (${laneCapacityPath(env)}), so this only reports.`);
  } else {
    const verdict = laneVerdict(lane.value, tasks, v);
    const reason = verdict.reasons.length ? verdict.reasons.map((r) => r.split(':')[0]).join(',') : 'ok';
    const target = lane.value.cap === 'auto' ? `auto${lane.value.maxLanes !== undefined ? `(max ${lane.value.maxLanes})` : ''}` : String(lane.value.cap);
    lines.push(`capacity: free_lanes=${verdict.freeLanes} reason=${reason} lanes=${lanes} target=${target} ${host}`);
    lines.push(`${lanes} lane(s) in use, ${verdict.freeLanes} open${verdict.reasons.length ? `. Constrained: ${verdict.reasons.join('; ')}` : ''}.`);
    lines.push(lane.value.admitSpawns ? 'admit-spawns: a crew member beyond this stays queued.' : 'No admit-spawns: this verdict only reports; spawns are not held back by it.');
  }
  if (projects.error) {
    ok = false;
    lines.push(`Invalid: ${projects.error}`);
  } else if (projects.value?.size) {
    for (const [name, cap] of projects.value) {
      const holders = tasks.filter((t) => holdsPlace(t, name)).map((t) => t.id);
      lines.push(`project ${name}: ${holders.length} of ${cap}${holders.length ? ` (${holders.join(', ')})` : ''}`);
    }
  }
  return { text: lines.join('\n'), ok };
}
