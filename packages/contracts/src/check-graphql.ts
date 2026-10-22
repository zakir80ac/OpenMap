// REQ-CORE-006 — GraphQL contract check: the committed schema may only change together with a version bump that
// matches the kind of change (docs/CONTRACTS.md "Versioning"): breaking changes need a major bump, additions a minor
// bump, and the version in the schema header must equal CONTRACT_VERSIONS.graphql. Run by `pnpm contracts:check`
// in CI against the pull request's base branch, or against the previous revision on main.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSchema, findBreakingChanges, findDangerousChanges, printSchema } from 'graphql';
import { CONTRACT_VERSIONS } from '@openmap/constants';

export interface Verdict {
  ok: boolean;
  messages: string[];
}

const VERSION_IN_HEADER = /^#.*\bversion\s+(\d+\.\d+\.\d+)\b/m;

/** The version named in the schema's leading comment, or null when the header does not state one. */
export function schemaVersion(sdl: string): string | null {
  const m = VERSION_IN_HEADER.exec(sdl);
  return m?.[1] ?? null;
}

function semver(v: string): [number, number, number] {
  const parts = v.split('.').map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/**
 * Compares the committed base schema with the working schema and decides whether the declared version moved the
 * way the change requires. Comment and formatting changes need no bump.
 */
export function compareSchemas(baseSdl: string, headSdl: string, declaredVersion: string): Verdict {
  const messages: string[] = [];
  const headVersion = schemaVersion(headSdl);
  if (headVersion !== declaredVersion) {
    messages.push('schema header says version ' + String(headVersion) + ' but CONTRACT_VERSIONS.graphql is ' + declaredVersion);
  }
  const base = buildSchema(baseSdl);
  const head = buildSchema(headSdl);
  if (printSchema(base) === printSchema(head)) return { ok: messages.length === 0, messages };

  const baseVersion = schemaVersion(baseSdl) ?? declaredVersion;
  const [bMajor, bMinor] = semver(baseVersion);
  const [hMajor, hMinor] = semver(headVersion ?? declaredVersion);
  const breaking = findBreakingChanges(base, head);
  const dangerous = findDangerousChanges(base, head);
  for (const c of breaking) messages.push('breaking: ' + c.description);
  for (const c of dangerous) messages.push('dangerous: ' + c.description);

  if (breaking.length > 0 && hMajor <= bMajor) {
    messages.push('breaking changes require a major version bump (base ' + baseVersion + ', head ' + String(headVersion) + ') and an ADR');
  } else if (breaking.length === 0 && !(hMajor > bMajor || (hMajor === bMajor && hMinor > bMinor))) {
    messages.push('schema additions require a minor version bump (base ' + baseVersion + ', head ' + String(headVersion) + ')');
  }
  return { ok: messages.every((m) => m.startsWith('breaking: ') || m.startsWith('dangerous: ')) && messages.length === breaking.length + dangerous.length && headVersion === declaredVersion, messages };
}

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The schema as committed at `ref`, or at the revision before `ref` when `ref` already holds the working copy. */
export function committedSchema(repoRoot: string, schemaPath: string, ref: string, workingSdl: string): string | null {
  const gitPath = relative(repoRoot, schemaPath).split(sep).join('/');
  let atRef: string;
  try {
    atRef = git(['show', ref + ':' + gitPath], repoRoot);
  } catch {
    return null;
  }
  if (atRef !== workingSdl) return atRef;
  const history = git(['log', '-2', '--format=%H', ref, '--', gitPath], repoRoot).trim().split(/\r?\n/).filter(Boolean);
  const previous = history[1];
  if (!previous) return null;
  try {
    return git(['show', previous + ':' + gitPath], repoRoot);
  } catch {
    return null;
  }
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const schemaPath = join(here, '..', 'graphql', 'schema.graphql');
  const repoRoot = git(['rev-parse', '--show-toplevel'], here).trim();
  const baseFlag = process.argv.indexOf('--base');
  const ref = baseFlag >= 0 ? (process.argv[baseFlag + 1] ?? 'HEAD') : 'HEAD';
  const working = readFileSync(schemaPath, 'utf8');
  const base = committedSchema(repoRoot, schemaPath, ref, working);
  if (base === null) {
    console.log('contracts: no earlier GraphQL schema to compare against (' + ref + '); header version ' + String(schemaVersion(working)));
    if (schemaVersion(working) !== CONTRACT_VERSIONS.graphql) {
      console.error('contracts: schema header version does not match CONTRACT_VERSIONS.graphql (' + CONTRACT_VERSIONS.graphql + ')');
      process.exitCode = 1;
    }
    return;
  }
  const verdict = compareSchemas(base, working, CONTRACT_VERSIONS.graphql);
  for (const m of verdict.messages) console.log('contracts: ' + m);
  if (!verdict.ok) {
    console.error('contracts: GraphQL schema check failed');
    process.exitCode = 1;
    return;
  }
  console.log('contracts: GraphQL schema ' + CONTRACT_VERSIONS.graphql + ' ok against ' + ref);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
