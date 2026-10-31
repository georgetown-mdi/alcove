// Types for bundleNotices.mjs, which the TypeScript bundle configs import.

export interface PackageNotice {
  name: string;
  version: string;
  license: string | undefined;
  texts: string[];
}

export const PACKAGE_LIST_PREFIX: string;
export function packageDirOf(id: string): string | null;
export function listedPackages(path: string): string[];
export function inlinedPackageDirs(moduleIds: readonly string[]): string[];
export function chunkNotices(moduleIds: readonly string[]): PackageNotice[];
export function packageNotice(dir: string): PackageNotice;
export function commentSafe(text: string): string;
export function noticeComment(notices: readonly PackageNotice[]): string;
export function bundleNotices(): {
  name: string;
  banner(chunk: { moduleIds: readonly string[] }): string;
};
