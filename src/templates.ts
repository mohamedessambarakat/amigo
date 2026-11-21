import type { AgentTemplate } from './config.ts';

/**
 * Known agent CLIs: the command templates the README documents and `install-skill` adds to config.json.
 * Flags come from each tool's documentation; `amigo` is missing where the CLI cannot start an interactive session with a prompt.
 */
export const TEMPLATES: Record<string, AgentTemplate> = {
  claude: { amigo: ['claude', '{prompt}'], member: ['claude', '--permission-mode', 'auto', '{prompt}'] },
  codex: { amigo: ['codex', '{prompt}'], member: ['codex', 'exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', '{prompt}'] },
  gemini: { amigo: ['gemini', '-i', '{prompt}'], member: ['gemini', '--approval-mode', 'auto_edit', '-p', '{prompt}'] },
  antigravity: { amigo: ['agy', '-i', '{prompt}'], member: ['agy', '-p', '{prompt}'] },
  grok: { member: ['grok', '-p', '--always-approve', '{prompt}'] },
};
