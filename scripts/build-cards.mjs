/**
 * Builds the two stat cards shown in README.md straight from the GitHub API.
 *
 * Self-hosting the cards keeps the profile alive: the popular third-party card
 * services go down or get rate limited, and a broken image on the profile page
 * is worse than no card at all. It also lets the cards share the exact palette
 * of assets/banner.svg.
 *
 * Usage: node scripts/build-cards.mjs   (GITHUB_TOKEN optional but recommended)
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const USER = "yimwired";

// Both cards sit side by side in the README, so they share one size.
const CARD = { width: 420, height: 236 };
const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");

const PALETTE = {
  surface: "#08080C",
  hairline: "#FFFFFF14",
  label: "#52525B",
  muted: "#71717A",
  text: "#E4E4E7",
  ramp: ["#818CF8", "#22D3EE", "#A78BFA", "#5EC8F0"],
  rest: "#3F3F46",
};

const FONT_SANS =
  "Inter, ui-sans-serif, -apple-system, Segoe UI, Helvetica, Arial, sans-serif";
const FONT_MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/* ---------------------------------------------------------------- data ---- */

async function request(path) {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": USER };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return fetch(`https://api.github.com${path}`, { headers });
}

async function api(path) {
  const response = await request(path);
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} on ${path}`);
  }
  return response.json();
}

async function collectProfile() {
  const user = await api(`/users/${USER}`);
  const repos = await api(`/users/${USER}/repos?per_page=100&type=owner`);
  const ownRepos = repos.filter((repo) => !repo.fork);

  const bytesPerLanguage = new Map();
  for (const repo of ownRepos) {
    const languages = await api(`/repos/${USER}/${repo.name}/languages`);
    for (const [language, bytes] of Object.entries(languages)) {
      bytesPerLanguage.set(language, (bytesPerLanguage.get(language) ?? 0) + bytes);
    }
  }

  const totalBytes = [...bytesPerLanguage.values()].reduce((sum, bytes) => sum + bytes, 0);

  return {
    repoCount: ownRepos.length,
    stars: ownRepos.reduce((total, repo) => total + repo.stargazers_count, 0),
    followers: user.followers,
    languageCount: bytesPerLanguage.size,
    totalBytes,
    commits: await countCommits(ownRepos),
    recent: recentlyPushed(ownRepos),
  };
}

/**
 * The four repos touched most recently. Preferred over a language breakdown:
 * byte-weighted languages are dominated by one large static coursework repo,
 * which says nothing true about what this profile actually builds.
 */
function recentlyPushed(repos, limit = 4) {
  return repos
    // The profile repo is excluded: the nightly card rebuild pushes to it, so it
    // would sit at the top of its own card every single day.
    .filter((repo) => repo.name !== USER && repo.pushed_at && repo.size > 0)
    .sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at))
    .slice(0, limit)
    .map((repo) => ({
      name: repo.name,
      language: repo.language ?? "",
      pushedAt: repo.pushed_at,
    }));
}

function relativeAge(isoDate, now = new Date()) {
  const hours = Math.floor((now - new Date(isoDate)) / 3_600_000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/**
 * Commits authored by USER across their public repos.
 *
 * Three tempting shortcuts are all wrong here:
 *   /search/commits    - the index answers differently per token, so a personal
 *                        token and the Actions GITHUB_TOKEN disagreed by ~200.
 *   ?author=USER       - silently misses commits GitHub failed to map back to
 *                        the account (one repo reported 0 of its 6).
 *   every non-bot commit - counts collaborators' work as our own (one shared
 *                        repo is 28 commits by a teammate).
 * Paging and matching the author explicitly is slower but stable across runs.
 */
async function countCommits(repos) {
  let total = 0;
  for (const repo of repos) {
    total += await countCommitsIn(repo.name);
  }
  return total;
}

async function countCommitsIn(repo, maxPages = 20) {
  let count = 0;

  for (let page = 1; page <= maxPages; page += 1) {
    const response = await request(`/repos/${USER}/${repo}/commits?per_page=100&page=${page}`);

    // 409 is GitHub's answer for an empty repository.
    if (response.status === 409) return count;
    if (!response.ok) throw new Error(`GitHub API ${response.status} on ${repo} commits`);

    const commits = await response.json();
    count += commits.filter(isOwnCommit).length;

    if (commits.length < 100) break;
  }

  return count;
}

// Local git identities that belong to USER but are not always mapped back to
// the GitHub account by the API.
const OWN_AUTHOR_NAMES = new Set(["yimwired", "Nuttapon Yimnoi"]);

function isOwnCommit(commit) {
  if (commit.author?.type === "Bot") return false;
  if (commit.author?.login) return commit.author.login === USER;
  return OWN_AUTHOR_NAMES.has(commit.commit?.author?.name ?? "");
}

/* --------------------------------------------------------------- render --- */

const escapeText = (value) =>
  String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const compact = (value) =>
  value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k` : String(value);

const megabytes = (bytes) => `${(bytes / 1_000_000).toFixed(1)} MB`;

function cardShell(body) {
  const { width, height } = CARD;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">
  <defs>
    <linearGradient id="brand" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#818CF8"/>
      <stop offset="50%" stop-color="#22D3EE"/>
      <stop offset="100%" stop-color="#A78BFA"/>
    </linearGradient>
  </defs>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="18"
        fill="${PALETTE.surface}" stroke="${PALETTE.hairline}"/>
${body}
</svg>
`;
}

function metric(x, y, value, label) {
  return `  <text x="${x}" y="${y}" fill="${PALETTE.text}" font-family="${FONT_SANS}" font-size="34" font-weight="700">${value}</text>
  <text x="${x}" y="${y + 22}" fill="${PALETTE.muted}" font-family="${FONT_MONO}" font-size="11" letter-spacing="1.6">${label}</text>`;
}

function renderStatsCard(profile) {
  // Deliberately not stars or followers: this profile ships work, it does not farm
  // vanity counts, and a card full of zeroes reads worse than no card.
  const metrics = [
    [compact(profile.repoCount), "PUBLIC REPOS"],
    [compact(profile.commits), "COMMITS"],
    [compact(profile.languageCount), "LANGUAGES"],
    [megabytes(profile.totalBytes), "CODE SHIPPED"],
  ];

  const grid = metrics
    .map(([value, label], index) =>
      metric(32 + (index % 2) * 200, 104 + Math.floor(index / 2) * 76, value, label),
    )
    .join("\n");

  return cardShell(
    `  <text x="32" y="46" fill="${PALETTE.label}" font-family="${FONT_MONO}" font-size="11" letter-spacing="3">GITHUB / @${USER.toUpperCase()}</text>
  <rect x="32" y="60" width="356" height="1.5" rx="0.75" fill="url(#brand)" opacity="0.75"/>
${grid}`,
  );
}

function renderActivityCard(profile) {
  const ROW_HEIGHT = 36;
  // Centre the rows in the shared card height so both cards end on the same line.
  const firstRow = (CARD.height - profile.recent.length * ROW_HEIGHT) / 2 + 42;

  const rows = profile.recent
    .map((repo, index) => {
      const y = firstRow + index * ROW_HEIGHT;
      const accent = PALETTE.ramp[index % PALETTE.ramp.length];
      const language = repo.language
        ? `\n  <text x="304" y="${y}" fill="${PALETTE.muted}" font-family="${FONT_MONO}" font-size="11" text-anchor="end">${escapeText(repo.language)}</text>`
        : "";

      return `  <circle cx="37" cy="${y - 4}" r="4" fill="${accent}"/>
  <text x="52" y="${y}" fill="${PALETTE.text}" font-family="${FONT_SANS}" font-size="14">${escapeText(repo.name)}</text>${language}
  <text x="388" y="${y}" fill="${PALETTE.label}" font-family="${FONT_MONO}" font-size="11" text-anchor="end">${relativeAge(repo.pushedAt)}</text>`;
    })
    .join("\n");

  return cardShell(
    `  <text x="32" y="46" fill="${PALETTE.label}" font-family="${FONT_MONO}" font-size="11" letter-spacing="3">RECENT PUSHES</text>
  <rect x="32" y="60" width="356" height="1.5" rx="0.75" fill="url(#brand)" opacity="0.75"/>
${rows}`,
  );
}

/* ----------------------------------------------------------------- main --- */

const profile = await collectProfile();
await mkdir(ASSETS_DIR, { recursive: true });
await writeFile(join(ASSETS_DIR, "stats.svg"), renderStatsCard(profile), "utf8");
await writeFile(join(ASSETS_DIR, "activity.svg"), renderActivityCard(profile), "utf8");

console.log(
  `cards rebuilt - ${profile.repoCount} repos, ${profile.commits ?? "n/a"} commits, ` +
    `${profile.languageCount} languages, ${profile.recent.length} recent pushes`,
);
