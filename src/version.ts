import { createRequire } from 'node:module';
import { z } from 'zod';

const packageJsonSchema = z.looseObject({ version: z.string(), name: z.string() });

const require = createRequire(import.meta.url);
// Resolves to <package root>/package.json both from src/ (tsx, vitest) and dist/ (built).
const parsed = packageJsonSchema.parse(require('../package.json') as unknown);

export const PACKAGE_NAME = parsed.name;
export const PACKAGE_VERSION = parsed.version;
export const USER_AGENT = `${PACKAGE_NAME}/${PACKAGE_VERSION}`;
