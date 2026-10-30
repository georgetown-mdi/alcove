import { expect } from "vitest";

import { PASTED_TEXT_ESCAPING_NOTE } from "@recurring/scheduledRunCommand";

/** The blocks showing one working-folder command per shell, found by the
 * `alcove` arguments the command ends on. */
interface WorkingFolderCommandBlocks {
  posix: string | undefined;
  windows: string | undefined;
  podman: string | undefined;
}

/** The working-folder command ending on `args`, as `container` shows it for
 * each shell, matched with PowerShell's quotes set aside. */
function workingFolderCommandBlocks(
  container: HTMLElement,
  args: string,
): WorkingFolderCommandBlocks {
  const blocks = Array.from(container.querySelectorAll("pre"))
    .map((block) => block.textContent)
    .filter((code) => code.replaceAll('"', "").endsWith(args));
  return {
    posix: blocks.find(
      (code) => code.startsWith("docker run") && !code.includes("C:\\"),
    ),
    windows: blocks.find(
      (code) => code.startsWith("docker run") && code.includes("C:\\"),
    ),
    podman: blocks.find((code) => code.startsWith("podman run")),
  };
}

/** Asserts that `container` shows the working-folder command ending on `args`
 * for each shell: as the operator on Linux and macOS and with rootless Podman,
 * and with no account option and nothing for a POSIX shell to expand in
 * PowerShell, then the notes on when to leave out `--user` and on escaping
 * what the operator pastes between double quotes. `interactive`
 * expects the terminal a command that asks before it writes runs with. */
export function expectWorkingFolderCommandPerShell(
  container: HTMLElement,
  args: string,
  { interactive = false }: { interactive?: boolean } = {},
): WorkingFolderCommandBlocks {
  const blocks = workingFolderCommandBlocks(container, args);
  const run = interactive ? "run --rm -it" : "run --rm";
  expect(blocks.posix).toContain(
    `docker ${run} --user "$(id -u):$(id -g)" --mount ` +
      '"type=bind,src=/path/to/your/working-folder,dst=/work"',
  );
  expect(blocks.windows).toContain(
    `docker ${run} --mount ` +
      '"type=bind,src=C:\\path\\to\\your\\working-folder,dst=/work"',
  );
  expect(blocks.windows).not.toContain("--user");
  expect(blocks.windows).not.toContain("$(");
  expect(blocks.podman).toContain(
    `podman ${run} --userns=keep-id:uid=1000,gid=1000 --mount ` +
      '"type=bind,src=/path/to/your/working-folder,dst=/work"',
  );
  expect(container.textContent).toContain(
    "Linux/macOS, running Alcove from its Docker image:",
  );
  expect(container.textContent).toContain(
    "Windows (in PowerShell), running Alcove from its Docker image:",
  );
  expect(container.textContent).toContain(
    "The Linux and macOS command runs as your own account, as start-alcove.sh runs the console. " +
      "If the console runs as the account built into the image (started with docker run and no --user, " +
      "or with start-alcove.sh from a root login), " +
      "leave out --user so this command writes files as the console does.",
  );
  expect(container.textContent).toContain(
    "With rootless Podman, use this in place of the Linux/macOS command.",
  );
  expect(container.textContent).toContain(PASTED_TEXT_ESCAPING_NOTE);
  return blocks;
}
