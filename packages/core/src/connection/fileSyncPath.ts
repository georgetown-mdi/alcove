/**
 * The path of `name` inside the file-sync directory `dir`. An empty `dir` is
 * an SFTP connection with no remote directory set, which works in the login
 * directory, so the name stays relative there rather than gaining a leading
 * slash that would name the server's root; a `dir` that already ends in `/`
 * (the root, or a Windows drive root `C:/`) takes no second separator.
 */
export function joinFileSyncPath(dir: string, name: string): string {
  if (dir === "") return name;
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}
