import { execFileSync } from "node:child_process";

/**
 * Best-effort git metadata inference for `record --auto`.
 * Never throws: on any failure (not a git repo, git missing, sandbox) it
 * returns undefined so the caller falls back to explicit flags.
 */

export interface GitMetadata {
  /** Remote origin URL, normalized to "owner/repo" when possible. */
  repo?: string;
  /** Current HEAD commit hash (short form). */
  commit?: string;
}

export function detectGit(cwd = process.cwd()): GitMetadata {
  let remote: string | undefined;
  let commit: string | undefined;

  try {
    remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim() || undefined;
  } catch {
    remote = undefined;
  }

  try {
    commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim() || undefined;
  } catch {
    commit = undefined;
  }

  let normalizedRepo: string | undefined;
  if (remote) {
    normalizedRepo = normalizeRemote(remote);
  } else {
    // Fall back to the directory name when there's no remote.
    const dir = cwd.split(/[\\/]/).filter(Boolean).pop();
    if (dir) normalizedRepo = dir;
  }

  return { repo: normalizedRepo, commit };
}

/** "git@github.com:acme/api.git" / "https://github.com/acme/api" → "acme/api". */
export function normalizeRemote(remote: string): string {
  const cleaned = remote.replace(/\.git$/, "");
  // git@host:owner/repo
  const scp = cleaned.match(/(?:^|[:/])([^/:]+)\/([^/:]+)$/);
  if (scp && scp[1] && scp[2]) return `${scp[1]}/${scp[2]}`;
  return cleaned;
}