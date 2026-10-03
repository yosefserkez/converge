import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DomainError } from '@converge/domain';

const ARTIFACTS_REMOTE = /^https:\/\/[a-z0-9]+\.artifacts\.cloudflare\.net\/git\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.git$/;

export interface RemotePolicy {
  /** Absolute directory; when set, `file://` remotes beneath it are allowed (tests only). */
  readonly fileRemoteRoot?: string;
}

export function isFileRemote(remote: string): boolean {
  return remote.startsWith('file://');
}

/** Throws FORBIDDEN unless the remote is on the allowlist. Never echoes the URL back. */
export function assertAllowedRemote(remote: string, policy: RemotePolicy): void {
  if (ARTIFACTS_REMOTE.test(remote)) return;
  if (policy.fileRemoteRoot && isFileRemote(remote) && isUnderRoot(remote, policy.fileRemoteRoot)) return;
  throw new DomainError('FORBIDDEN', 'remote is not on the broker allowlist');
}

function isUnderRoot(remote: string, root: string): boolean {
  let filePath: string;
  try {
    filePath = fileURLToPath(remote);
  } catch {
    return false;
  }
  if (!path.isAbsolute(filePath) || /[\0\n\r]/.test(filePath)) return false;
  const normalized = path.resolve(filePath);
  if (normalized !== filePath.replace(/\/+$/, '')) return false; // reject `..` and `.` segments
  const base = path.resolve(root);
  return normalized.startsWith(`${base}${path.sep}`);
}
