import { loadProjects } from './config.ts';
import { samePath } from './git.ts';
import { fastForwardLive } from './landing.ts';
import { codeRoot } from './paths.ts';
import { run } from './proc.ts';
import { syncProject } from './sync.ts';

/**
 * `amigo update` (a port of the upstream self-update, for one home): bring amigo's own code folder up to origin. That
 * folder is the `live:` folder of a registered project; its clone is refreshed from origin, then the live folder is fast-forwarded
 * from the clone, both through the guarded paths (never forced, stashed or merged; anything unsafe is skipped and reported).
 * The last three lines say what the running session must do: re-read its contract, reinstall the user skills, start afresh.
 */
export function updateAmigo(env: NodeJS.ProcessEnv = process.env, root: string = codeRoot): string[] {
  const project = loadProjects(env).find((p) => p.live && samePath(p.live, root));
  if (!project) {
    return [
      `skipped: amigo's code folder ${root} is not the live folder of any registered project. Register it once: amigo add <amigo's git url> --name amigo --live ${root}`,
      ...actionLines([]),
    ];
  }
  const head = () => run('git', ['-C', root, 'rev-parse', 'HEAD']).stdout.trim();
  const before = head();
  const out = [syncProject(project), fastForwardLive(project) ?? `live ${root}: skipped: no live folder`];
  const after = head();
  const changed = before && after && before !== after ? run('git', ['-C', root, 'diff', '--name-only', before, after]).stdout.split(/\r?\n/).filter(Boolean) : [];
  return [...out, ...actionLines(changed)];
}

/** The follow-up lines, from the files the fast-forward changed. */
export function actionLines(changed: readonly string[]): string[] {
  const any = (re: RegExp) => (changed.some((f) => re.test(f)) ? 'yes' : 'no');
  return [`reread-contract: ${any(/^prompts\//)}`, `reinstall-skills: ${any(/^skills\/user\//)}`, `restart-session: ${any(/^src\//)}`];
}
