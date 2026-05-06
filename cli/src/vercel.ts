import { spinner, confirm, isCancel, cancel } from "@clack/prompts";

const VERCEL_API = "https://api.vercel.com";

/**
 * Decode a Vercel API error response body, surfacing actionable hints when
 * we recognize specific error codes (esp. SAML 403s, which require the user
 * to re-authenticate via the team's SSO flow).
 */
export function explainVercelError(
  status: number,
  body: string,
  context: string,
): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: string; message?: string; saml?: boolean; teamId?: string };
    };
    const e = parsed.error;
    if (status === 403 && e?.saml) {
      return (
        `${context} failed with a SAML auth error.\n` +
        `The team requires SSO re-authentication that your current Vercel CLI ` +
        `token doesn't have.\n` +
        `Fix: open https://vercel.com/teams/${e.teamId ?? "<teamId>"} in a browser, ` +
        `complete SSO, then run \`vercel logout && vercel login\` and re-run cli:deploy.\n` +
        `Or pick a different team at the start of the deploy.`
      );
    }
    if (e?.message) {
      return `${context} failed: ${status} ${e.code ?? ""} ${e.message}`;
    }
  } catch {
    // body wasn't JSON — fall through to generic
  }
  return `${context} failed: ${status} ${body}`;
}

interface CreateProjectArgs {
  token: string;
  teamId: string | null;
  projectName: string;
  githubRepoSlug: string; // "username/trustclaw"
  githubToken: string;
}

interface VercelProject {
  id: string;
  name: string;
}

interface VercelProjectFull extends VercelProject {
  link?: { type?: string; repo?: string; org?: string };
}

async function getRepoId(githubToken: string, slug: string): Promise<number> {
  const res = await fetch(`https://api.github.com/repos/${slug}`, {
    headers: { Authorization: `Bearer ${githubToken}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`Failed to read repo ${slug}: ${res.status}`);
  const data = (await res.json()) as { id: number };
  return data.id;
}

async function getExistingProject(
  token: string,
  teamId: string | null,
  projectName: string,
): Promise<VercelProjectFull | null> {
  const url = teamId
    ? `${VERCEL_API}/v9/projects/${projectName}?teamId=${teamId}`
    : `${VERCEL_API}/v9/projects/${projectName}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  return (await res.json()) as VercelProjectFull;
}

export async function createVercelProject(args: CreateProjectArgs): Promise<VercelProject> {
  const { token, teamId, projectName, githubRepoSlug, githubToken } = args;

  const s = spinner();
  s.start(`Checking for existing Vercel project "${projectName}"`);

  try {
    void (await getRepoId(githubToken, githubRepoSlug)); // sanity check the repo is accessible
  } catch (err) {
    s.stop("Could not access GitHub repo");
    throw err;
  }

  const existing = await getExistingProject(token, teamId, projectName);
  if (existing) {
    const linkedRepo =
      existing.link?.org && existing.link?.repo
        ? `${existing.link.org}/${existing.link.repo}`
        : null;

    if (linkedRepo === githubRepoSlug) {
      s.stop(`Reusing existing project: ${existing.name} (linked to ${linkedRepo})`);
      return { id: existing.id, name: existing.name };
    }

    s.stop(`Project "${projectName}" exists but is linked to ${linkedRepo ?? "a different repo"}`);
    const reuse = await confirm({
      message: `Reuse it anyway and re-link to ${githubRepoSlug}?`,
      initialValue: false,
    });
    if (isCancel(reuse) || !reuse) {
      cancel("Cancelled.");
      throw new Error(
        `Pick a different project name, or delete "${projectName}" on Vercel first.`,
      );
    }
    // Re-link the existing project to the new GitHub repo.
    const linkUrl = teamId
      ? `${VERCEL_API}/v9/projects/${existing.id}/link?teamId=${teamId}`
      : `${VERCEL_API}/v9/projects/${existing.id}/link`;
    const linkRes = await fetch(linkUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "github", repo: githubRepoSlug }),
    });
    if (!linkRes.ok) {
      const body = await linkRes.text();
      throw new Error(`Failed to re-link project: ${linkRes.status} ${body}`);
    }
    return { id: existing.id, name: existing.name };
  }

  s.message(`Creating Vercel project "${projectName}"`);
  const url = teamId
    ? `${VERCEL_API}/v9/projects?teamId=${teamId}`
    : `${VERCEL_API}/v9/projects`;

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: projectName,
      framework: "nextjs",
      gitRepository: {
        type: "github",
        repo: githubRepoSlug,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    s.stop("Vercel project creation failed");
    throw new Error(explainVercelError(res.status, body, "Vercel project creation"));
  }

  const project = (await res.json()) as VercelProject;
  s.stop(`Project created: ${project.name}`);
  return project;
}

/**
 * Disable Vercel SSO/deployment protection on the project so external services
 * (e.g. Telegram webhooks) can reach the deployment URLs without a login wall.
 *
 * Vercel turns this on by default for new projects, which means deployment URLs
 * like `<project>-<hash>-<team>.vercel.app` return an HTML 401 to anything
 * without a session cookie - including Telegram. The canonical
 * `<project>.vercel.app` is unaffected, but any registration that picks up the
 * deployment URL silently breaks the bot. Easier to just turn the wall off.
 */
export async function disableDeploymentProtection(args: {
  token: string;
  teamId: string | null;
  projectId: string;
}): Promise<void> {
  const url = args.teamId
    ? `${VERCEL_API}/v9/projects/${args.projectId}?teamId=${args.teamId}`
    : `${VERCEL_API}/v9/projects/${args.projectId}`;
  await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${args.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ssoProtection: null, passwordProtection: null }),
  }).catch(() => {
    // best-effort - failing to disable shouldn't kill the deploy
  });
}
