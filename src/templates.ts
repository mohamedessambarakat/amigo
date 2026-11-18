import type { AgentTemplate } from './config.ts';

/**
 * Known agent CLIs: the command templates the README documents and `install-skill` adds to config.json.
 * Flags come from each tool's documentation; `head` is missing where the CLI cannot start an interactive session with a prompt.
 */
export const TEMPLATES: Record<string, AgentTemplate> = {
  claude: { head: ['claude', '{prompt}'], arm: ['claude', '--permission-mode', 'auto', '{prompt}'] },
  codex: { head: ['codex', '{prompt}'], arm: ['codex', 'exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', '{prompt}'] },
  gemini: { head: ['gemini', '-i', '{prompt}'], arm: ['gemini', '--approval-mode', 'auto_edit', '-p', '{prompt}'] },
  antigravity: { head: ['agy', '-i', '{prompt}'], arm: ['agy', '-p', '{prompt}'] },
  grok: { arm: ['grok', '-p', '--always-approve', '{prompt}'] },
};
