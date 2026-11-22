import type { AgentTemplate } from './config.ts';

/**
 * Known agent CLIs: the command templates the README documents and `install-skill` adds to config.json.
 * Flags come from each tool's documentation. Only Claude Code has an `amigo` template: amigo runs as the lead only there
 * (its Stop hook arms the watcher); the others run crew members.
 */
export const TEMPLATES: Record<string, AgentTemplate> = {
  claude: { amigo: ['claude', '{prompt}'], member: ['claude', '--permission-mode', 'auto', '{prompt}'] },
  codex: { member: ['codex', 'exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', '{prompt}'] },
  gemini: { member: ['gemini', '--approval-mode', 'auto_edit', '-p', '{prompt}'] },
  antigravity: { member: ['agy', '-p', '{prompt}'] },
  grok: { member: ['grok', '-p', '--always-approve', '{prompt}'] },
};
