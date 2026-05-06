import { exec as _exec, spawn } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { confirm, isCancel, log, select, spinner } from "@clack/prompts";

const exec = promisify(_exec);

async function runInteractive(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

export interface AuthResult {
  vercelToken: string;
  vercelTeamId: string | null;
  vercelOwnerSlug: string;
  vercelBillingPlan: string; // "hobby" | "pro" | "enterprise" | etc.
  githubToken: string;
  githubUsername: string;
}

async function readVercelTokenFromDisk(): Promise<string | null> {
  const home = homedir();
  const candidates =
    process.platform === "darwin"
      ? [
          join(home, "Library", "Application Support", "com.vercel.cli", "auth.json"),
          join(home, ".local", "share", "com.vercel.cli", "auth.json"),
        ]
      : [
          join(home, ".local", "share", "com.vercel.cli", "auth.json"),
          join(home, "Library", "Application Support", "com.vercel.cli", "auth.json"),
        ];

  for (const authPath of candidates) {
    try {
      const raw = await readFile(authPath, "utf-8");
      const parsed = JSON.parse(raw) as { token: string };
      if (parsed.token) return parsed.token;
    } catch {
      // try next candidate
    }
  }
  return null;
}

async function promptVercelLogin(reason: string): Promise<void> {
  log.warn(reason);
  const proceed = await confirm({
    message: "Run `vercel login` now?",
    initialValue: true,
  });
  if (isCancel(proceed) || !proceed) {
    throw new Error("Cancelled. Run `pnpm dlx vercel login` and re-run cli:deploy.");
  }
  const code = await runInteractive("pnpm", ["dlx", "vercel", "login"]);
  if (code !== 0) {
    throw new Error(`vercel login exited with code ${code}.`);
  }
}

async function getVercelToken(): Promise<string> {
  let token = await readVercelTokenFromDisk();
  if (!token) {
    await promptVercelLogin("No Vercel auth found on this machine.");
    token = await readVercelTokenFromDisk();
    if (!token) {
      throw new Error("Still no Vercel auth after login. Try again.");
    }
  }
  return token;
}

async function ghIsInstalled(): Promise<boolean> {
  try {
    await exec("command -v gh");
    return true;
  } catch {
    return false;
  }
}

async function tryReadGhAuth(): Promise<{ token: string; username: string } | null> {
  try {
    const { stdout: token } = await exec("gh auth token");
    const { stdout: userJson } = await exec("gh api user --jq '.login'");
    const trimmedToken = token.trim();
    const trimmedUser = userJson.trim();
    if (!trimmedToken || !trimmedUser) return null;
    return { token: trimmedToken, username: trimmedUser };
  } catch {
    return null;
  }
}

async function promptGhLogin(reason: string): Promise<void> {
  log.warn(reason);
  const proceed = await confirm({
    message: "Run `gh auth login` now?",
    initialValue: true,
  });
  if (isCancel(proceed) || !proceed) {
    throw new Error("Cancelled. Run `gh auth login` and re-run cli:deploy.");
  }
  const code = await runInteractive("gh", ["auth", "login"]);
  if (code !== 0) {
    throw new Error(`gh auth login exited with code ${code}.`);
  }
}

async function getGitHubToken(): Promise<{ token: string; username: string }> {
  if (!(await ghIsInstalled())) {
    const installCmd =
      process.platform === "darwin"
        ? "brew install gh"
        : process.platform === "linux"
          ? "see https://github.com/cli/cli/blob/trunk/docs/install_linux.md"
          : "see https://cli.github.com/";
    throw new Error(
      `GitHub CLI (\`gh\`) is not installed. Install it (${installCmd}), then re-run cli:deploy.`,
    );
  }

  let auth = await tryReadGhAuth();
  if (!auth) {
    await promptGhLogin("`gh` is installed but not authenticated.");
    auth = await tryReadGhAuth();
    if (!auth) {
      throw new Error("Still no GitHub auth after login. Try again.");
    }
  }
  return auth;
}

export async function detectAuth(): Promise<AuthResult> {
  const s = spinner();
  s.start("Detecting authentication");

  let vercelToken: string;
  let githubToken: string;
  let githubUsername: string;
  try {
    vercelToken = await getVercelToken();
    const gh = await getGitHubToken();
    githubToken = gh.token;
    githubUsername = gh.username;
  } catch (err) {
    s.stop("Authentication detection failed");
    throw err;
  }

  // If the cached Vercel token is stale (revoked / expired), prompt to log
  // in again and retry once with the fresh token.
  let userRes = await fetch("https://api.vercel.com/v2/user", {
    headers: { Authorization: `Bearer ${vercelToken}` },
  });
  if (userRes.status === 401 || userRes.status === 403) {
    s.stop("Vercel token expired or invalid");
    await promptVercelLogin(
      `Vercel returned ${userRes.status} - your saved token is likely expired or revoked.`,
    );
    const refreshed = await readVercelTokenFromDisk();
    if (!refreshed) {
      throw new Error("No Vercel auth after login. Try again.");
    }
    vercelToken = refreshed;
    s.start("Detecting authentication");
    userRes = await fetch("https://api.vercel.com/v2/user", {
      headers: { Authorization: `Bearer ${vercelToken}` },
    });
  }
  if (!userRes.ok) {
    s.stop("Vercel token invalid");
    throw new Error(`Vercel token invalid: ${userRes.status}`);
  }
  const userData = (await userRes.json()) as {
    user: {
      email: string;
      username: string;
      defaultTeamId?: string;
      billing?: { plan?: string };
    };
  };

  // List all teams the token can see, then let the user pick. SAML-enforced
  // orgs (e.g. composio) appear here even when the user's session can't
  // actually create resources under them — picking the wrong one is what
  // bit @CryogenicPlanet's tester. Defaulting to whatever they had won't
  // help in that case, so we always prompt when there's more than one.
  s.stop(`Authenticated as ${userData.user.email}`);

  interface TeamInfo {
    id: string;
    slug: string;
    name?: string;
    billing?: { plan?: string };
  }
  let teams: TeamInfo[] = [];
  try {
    const teamsRes = await fetch("https://api.vercel.com/v2/teams", {
      headers: { Authorization: `Bearer ${vercelToken}` },
    });
    if (teamsRes.ok) {
      const data = (await teamsRes.json()) as { teams?: TeamInfo[] };
      teams = data.teams ?? [];
    }
  } catch {
    // fall through with empty teams list
  }

  let chosenTeam: TeamInfo | null = null;
  if (teams.length === 1) {
    chosenTeam = teams[0]!;
  } else if (teams.length > 1) {
    const defaultId = userData.user.defaultTeamId;
    const choice = await select({
      message: "Which Vercel team should I deploy to?",
      options: teams.map((t) => ({
        value: t.id,
        label: t.name ? `${t.name} (${t.slug})` : t.slug,
        hint: t.id === defaultId ? "default" : undefined,
      })),
      initialValue: defaultId ?? teams[0]!.id,
    });
    if (isCancel(choice)) {
      throw new Error("Cancelled.");
    }
    chosenTeam = teams.find((t) => t.id === choice) ?? teams[0]!;
  }

  const teamId = chosenTeam?.id ?? userData.user.defaultTeamId ?? null;
  const ownerSlug = chosenTeam?.slug ?? userData.user.username;
  const billingPlan =
    chosenTeam?.billing?.plan ?? userData.user.billing?.plan ?? "hobby";

  log.info(
    `Deploying to ${chosenTeam ? chosenTeam.name ?? chosenTeam.slug : userData.user.username} (${billingPlan} plan)`,
  );
  log.success(`GitHub: ${githubUsername}`);

  return {
    vercelToken,
    vercelTeamId: teamId,
    vercelOwnerSlug: ownerSlug,
    vercelBillingPlan: billingPlan,
    githubToken,
    githubUsername,
  };
}
