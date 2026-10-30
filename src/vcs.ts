import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"

export type Vcs = { kind: "perforce"; client: string; root: string } | { kind: "git"; root: string } | { kind: "none" }

const inside = (dir: string, root: string) => {
  const rel = path.relative(path.resolve(root), path.resolve(dir))
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

/** The Perforce client whose root contains dir, if p4 is installed and a client applies there. */
function perforce(dir: string): Promise<Vcs | undefined> {
  return new Promise((resolve) => {
    // p4 finds its P4CONFIG file from $PWD, not the process's working directory.
    execFile("p4", ["-ztag", "-F", "%clientName%|%clientRoot%", "info"], { cwd: dir, env: { ...process.env, PWD: dir }, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(undefined)
      const [client = "", root = ""] = stdout.trim().split("|")
      resolve(client && client !== "*unknown*" && root && inside(dir, root) ? { kind: "perforce", client, root } : undefined)
    })
  })
}

function git(dir: string): Vcs | undefined {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (existsSync(path.join(d, ".git"))) return { kind: "git", root: d }
    if (path.dirname(d) === d) return undefined
  }
}

const cache = new Map<string, Promise<Vcs>>()

/** Detected once per folder: Perforce first (a Perforce tree may also hold a .git), then git. */
export function detectVcs(dir: string): Promise<Vcs> {
  let v = cache.get(dir)
  if (!v) {
    v = perforce(dir).then((p) => p ?? git(dir) ?? { kind: "none" as const })
    cache.set(dir, v)
  }
  return v
}

/** The line every agent's first message carries, so Perforce rules apply only in a Perforce workspace. */
export function vcsLine(dir: string, vcs: Vcs): string {
  switch (vcs.kind) {
    case "perforce":
      return `Working directory: ${dir}. Version control: Perforce workspace (client ${vcs.client}, root ${vcs.root}).`
    case "git":
      return `Working directory: ${dir}. Version control: git (repository ${vcs.root}). This is not a Perforce workspace: don't use p4 or the p4_* tools.`
    case "none":
      return `Working directory: ${dir}. Version control: none (not git, not a Perforce workspace): don't use p4 or the p4_* tools.`
  }
}
