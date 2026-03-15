/**
 * Auth config loader.
 *
 * Reads .aperture/auth.json from CWD for cookie/localStorage injection.
 * Format:
 * {
 *   "cookies": [{ "name": "session", "value": "abc", "domain": "localhost", "path": "/" }],
 *   "localStorage": {
 *     "http://localhost:4321": { "auth_token": "xyz" }
 *   }
 * }
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { log } from './log.js';

export interface CookieParam {
  name: string;
  value: string;
  url?: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface AuthConfig {
  cookies?: CookieParam[];
  localStorage?: Record<string, Record<string, string>>;
}

// BUG-023: Zod schema for runtime validation of auth config
const cookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  url: z.string().optional(),
  domain: z.string().optional(),
  path: z.string().optional(),
  expires: z.number().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
});

const authConfigSchema = z.object({
  cookies: z.array(cookieSchema).optional(),
  localStorage: z.record(z.string(), z.record(z.string(), z.string())).optional(),
});

export async function loadAuth(): Promise<AuthConfig> {
  const configPath = join(process.cwd(), '.aperture', 'auth.json');
  try {
    const raw = await readFile(configPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    // BUG-023: Validate structure at runtime
    const config = authConfigSchema.parse(parsed);
    log(`loaded auth config from ${configPath}`);
    return config;
  } catch (err) {
    if (err instanceof z.ZodError) {
      // BUG-034: Use log() instead of console.error
      log(`invalid auth config at ${configPath}: ${err.issues.map((i) => i.message).join(', ')}`);
      return {};
    }
    // No auth config — that's fine, most dev pages don't need it
    return {};
  }
}
