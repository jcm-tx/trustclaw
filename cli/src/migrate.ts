import { exec as _exec } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { join } from "path";
import { spinner } from "@clack/prompts";

const exec = promisify(_exec);

async function findRepoRoot(): Promise<string> {
  // Prefer git for accuracy; fall back to walking up from cwd looking for prisma/schema.prisma.
  try {
    const { stdout } = await exec("git rev-parse --show-toplevel");
    const root = stdout.trim();
    if (root && existsSync(join(root, "prisma", "schema.prisma"))) return root;
  } catch {
    // not in a git repo, or git not installed
  }

  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, "prisma", "schema.prisma"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(
    "Could not locate prisma/schema.prisma. Run this from inside your trustclaw clone.",
  );
}

interface RunMigrationArgs {
  databaseUrl: string;
  /**
   * Absolute path to a directory containing `prisma/schema.prisma`. Required
   * when the CLI is running outside any local trustclaw clone (the fork
   * deploy path) — pass the path returned by `cloneForkLocally`. If omitted,
   * we'll search for the schema in/around `process.cwd()`.
   */
  repoRoot?: string;
}

export async function runMigration(args: RunMigrationArgs): Promise<void> {
  const s = spinner();
  s.start("Running database migration (prisma db push)");

  try {
    const repoRoot = args.repoRoot ?? (await findRepoRoot());
    if (!existsSync(join(repoRoot, "prisma", "schema.prisma"))) {
      throw new Error(
        `prisma/schema.prisma not found at ${repoRoot}. The provided repoRoot is wrong.`,
      );
    }
    // The repo's prisma.config.ts does `import "dotenv/config"`. In the
    // fork-deploy path the cloned dir has no node_modules, so prisma fails
    // to load the config with "Cannot find module 'dotenv/config'". Install
    // dotenv first (--no-save keeps the lockfile clean), then run prisma.
    // Use `npx -y` so prisma itself doesn't need a global install.
    await exec("npm install --no-save --silent --no-audit --no-fund dotenv", {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: args.databaseUrl },
    });
    await exec("npx -y prisma@^7.3.0 db push --accept-data-loss", {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: args.databaseUrl },
    });
    s.stop("Schema applied");
  } catch (err) {
    s.stop("Migration failed");
    throw err;
  }
}
