/**
 * CLI installer for Claude Code PostToolUse hook.
 *
 * Safely merges the Aperture visual-file-check hook into
 * .claude/settings.json without clobbering existing hooks.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const APERTURE_HOOK = {
  matcher: 'Edit|Write',
  hooks: [
    {
      type: 'command',
      command:
        'if echo "$TOOL_INPUT" | grep -qE \'\\.(css|scss|tsx|jsx|astro|svelte|vue|html)\'; then echo \'Visual file changed — consider calling has_changed() or smart_check()\' >&2; fi',
    },
  ],
};

export async function installHook(): Promise<void> {
  const claudeDir = join(process.cwd(), '.claude');
  const settingsPath = join(claudeDir, 'settings.json');

  // Ensure .claude/ exists
  await mkdir(claudeDir, { recursive: true });

  let settings: Record<string, unknown> = {};

  try {
    const raw = await readFile(settingsPath, 'utf-8');
    settings = JSON.parse(raw);
  } catch {
    // File doesn't exist or invalid JSON — start fresh
  }

  // Ensure hooks.PostToolUse is an array
  if (!settings.hooks || typeof settings.hooks !== 'object') {
    settings.hooks = {};
  }
  const hooks = settings.hooks as Record<string, unknown>;

  if (!Array.isArray(hooks.PostToolUse)) {
    hooks.PostToolUse = [];
  }
  const postToolUse = hooks.PostToolUse as Array<Record<string, unknown>>;

  // Check if an Aperture hook already exists (by matching the command substring)
  const alreadyInstalled = postToolUse.some((entry) => {
    if (!Array.isArray(entry.hooks)) return false;
    return (entry.hooks as Array<Record<string, unknown>>).some(
      (h) => typeof h.command === 'string' && h.command.includes('has_changed') && h.command.includes('Visual file changed')
    );
  });

  if (alreadyInstalled) {
    console.log('Aperture hook already installed in .claude/settings.json');
    return;
  }

  postToolUse.push(APERTURE_HOOK);

  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log('Installed Aperture PostToolUse hook in .claude/settings.json');
  console.log('The agent will now be reminded to check visual changes after editing UI files.');
}
