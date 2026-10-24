/**
 * Builds the cards shown in README.md straight from the GitHub API: the stat
 * cards, the contribution heatmap, and the status card for the systems that
 * run on their own.
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

// The first two cards sit side by side in the README, so they share one size.
const CARD = { width: 420, height: 236 };
const WIDE_CARD = { width: 860, height: 280 };
const STATUS_CARD = { width: 860, height: 244 };
const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");

// WebPV's midnight zone (its `.dark` tokens), so the profile reads as the same
// hand as the site: midnight ground, pearl ink, champagne gold as the one
// accent. Contrast on the surface: text 16.3:1, muted 8.65:1, label 6.2:1.
const PALETTE = {
  surface: "#0D1734",
  hairline: "#FFFFFF1A",
  label: "#8C9AB8",
  muted: "#AAB6CD",
  text: "#F7F6F1",
  // Gold, deep to pale, for the dots that tell the recent repos apart.
  ramp: ["#E3BD70", "#B8913F", "#F2DDAE", "#9C7A3C"],
  rest: "#26314F",
  // Contribution heat, quietest to loudest: an empty day a step above the
  // surface, then the gold at a quarter, half, three quarters and full
  // strength over midnight.
  heat: ["#19244A", "#42403F", "#786A52", "#AD9361", "#E3BD70"],
};

// GitHub shows these cards through <img>, which cannot load a web font, so the
// stack is the system's own sans-serif rather than the site's Google Sans.
const FONT_SANS =
  "ui-sans-serif, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif";
const FONT_MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/* ---------------------------------------------------------------- data ---- */

/**
 * Tokens in the order they are tried. The personal one sees private work, which
 * is the whole reason it exists; the runner's own token sees none of it but has
 * a rate limit, which sixty unauthenticated requests an hour is not: this
 * script makes more than that in one run.
 *
 * Classic tokens expire, and an expired one is still a non-empty secret, so a
 * run that insists on it 401s every night until someone looks at the Actions
 * tab. Dropping to the next token keeps the cards current in the meantime; the
 * contribution count falls back to public commits, which lands close.
 */
// Trimmed: a secret pasted with a trailing newline produces a header the API
// answers 401 to, which looks exactly like an expired token.
const TOKENS = [process.env.GITHUB_TOKEN, process.env.ACTIONS_TOKEN]
  .map((token) => token?.trim())
  .filter(Boolean);
let tokenIndex = 0;

/** True once the personal token has been rejected, so the calendar is out. */
let tokenRejected = false;

async function request(path) {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": USER };
  const token = TOKENS[tokenIndex];
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`https://api.github.com${path}`, { headers });
  if (response.status === 401 && token) {
    tokenIndex += 1;
    tokenRejected = true;
    console.warn(
      `A token was rejected (401) on ${path}. ` +
        (TOKENS[tokenIndex]
          ? "Trying the next one; private contributions will not be counted. "
          : "No token left, continuing unauthenticated. ") +
        "If this was PROFILE_TOKEN, issue a new classic token with read:user " +
        "only and set it at " +
        "https://github.com/yimwired/yimwired/settings/secrets/actions",
    );
    return request(path);
  }
  return response;
}

async function api(path) {
  const response = await request(path);
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} on ${path}`);
  }
  return response.json();
}

const CALENDAR_QUERY = `query($login: String!) {
  user(login: $login) {
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount } }
      }
    }
  }
}`;

/**
 * The contribution calendar, which counts private work too when the token is
 * allowed to see it. Returns null when the token cannot run the query at all,
 * so the caller can fall back to public commit dates.
 */
async function fetchCalendar() {
  if (!process.env.GITHUB_TOKEN || tokenRejected) return null;

  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "User-Agent": USER,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: CALENDAR_QUERY, variables: { login: USER } }),
  });

  if (!response.ok) return null;

  const payload = await response.json();
  const calendar =
    payload.data?.user?.contributionsCollection?.contributionCalendar ?? null;
  if (!calendar) return null;

  return calendar.weeks
    .flatMap((week) => week.contributionDays)
    .map((day) => ({ date: day.date, count: day.contributionCount }));
}

const DAY_MS = 86_400_000;
const isoDay = (date) => date.toISOString().slice(0, 10);

/** A 365-day calendar rebuilt from public commit timestamps. */
function calendarFromCommits(commitDates, today) {
  const perDay = new Map();
  for (const iso of commitDates) {
    const day = iso.slice(0, 10);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }

  const days = [];
  for (let offset = 364; offset >= 0; offset -= 1) {
    const day = isoDay(new Date(today.getTime() - offset * DAY_MS));
    days.push({ date: day, count: perDay.get(day) ?? 0 });
  }
  return days;
}

/**
 * Current and longest run of consecutive active days. A quiet today does not
 * break the current streak until tomorrow, the same rule GitHub's own graph uses.
 */
function streaks(days) {
  let longest = 0;
  let run = 0;
  for (const day of days) {
    run = day.count > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }

  let current = 0;
  for (let index = days.length - 1; index >= 0; index -= 1) {
    if (days[index].count > 0) current += 1;
    else if (index !== days.length - 1) break;
  }

  return { current, longest };
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
  const commitDates = await collectCommitDates(ownRepos);

  // Prefer the contribution calendar: it sees private work, which the public
  // commit list cannot. Falling back keeps the card working without a token.
  const calendarDays = await fetchCalendar();
  const days = calendarDays ?? calendarFromCommits(commitDates, new Date());

  return {
    repoCount: ownRepos.length,
    stars: ownRepos.reduce((total, repo) => total + repo.stargazers_count, 0),
    followers: user.followers,
    languageCount: bytesPerLanguage.size,
    totalBytes,
    commits: commitDates.length,
    recent: recentlyPushed(ownRepos),
    contributions: {
      days,
      total: days.reduce((sum, day) => sum + day.count, 0),
      // A calendar reflects whatever the token may see, private work included;
      // the commit fallback is public by definition, and the card says so.
      fromCalendar: calendarDays !== null,
      ...streaks(days),
    },
  };
}

/**
 * The four repos touched most recently. Preferred over a language breakdown:
 * byte-weighted languages are dominated by one large static coursework repo,
 * which says nothing true about what this profile actually builds.
 */
// Public repos kept off the profile on Film's call (2026-10-22): the profile
// fronts the web work he sells, and an LLM budget library is not that.
const HIDDEN_REPOS = new Set(["llm-fusebox"]);

function recentlyPushed(repos, limit = 4) {
  return repos
    // The profile repo is excluded: the nightly card rebuild pushes to it, so it
    // would sit at the top of its own card every single day.
    .filter((repo) => repo.name !== USER && !HIDDEN_REPOS.has(repo.name))
    .filter((repo) => repo.pushed_at && repo.size > 0)
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
async function collectCommitDates(repos) {
  const dates = [];
  for (const repo of repos) {
    dates.push(...(await commitDatesIn(repo.name)));
  }
  return dates;
}

async function commitDatesIn(repo, maxPages = 20) {
  const dates = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const response = await request(`/repos/${USER}/${repo}/commits?per_page=100&page=${page}`);

    // 409 is GitHub's answer for an empty repository.
    if (response.status === 409) return dates;
    if (!response.ok) throw new Error(`GitHub API ${response.status} on ${repo} commits`);

    const commits = await response.json();
    for (const commit of commits) {
      if (isOwnCommit(commit)) dates.push(commit.commit.author.date);
    }

    if (commits.length < 100) break;
  }

  return dates;
}

// Local git identities that belong to USER but are not always mapped back to
// the GitHub account by the API.
const OWN_AUTHOR_NAMES = new Set(["yimwired", "Nuttapon Yimnoi"]);

function isOwnCommit(commit) {
  if (commit.author?.type === "Bot") return false;
  if (commit.author?.login) return commit.author.login === USER;
  return OWN_AUTHOR_NAMES.has(commit.commit?.author?.name ?? "");
}

/* ------------------------------------------------------------- systems --- */

// The status card reports on the systems that run with Film's PC off, from
// what they leave in public: the Shorts pipeline commits one job file per video
// to its queue, and every push to WebPV gets a Workers Builds check. Moon and
// AURUM run on the home PC and publish nothing, so they are left off the card
// rather than shown with numbers nobody can check.
const SHORTS_REPO = "YoutubeShorts";
const SITE_REPO = "WebPV";
const SITE = "https://webpv.yimwired.workers.dev";
const TIME_ZONE = "Asia/Bangkok";

// Two shorts go live a day, uploaded a day ahead with a scheduled publish time,
// so the newest 72 jobs cover the 30-day window with room to spare. A short
// counts as live once that time has passed, not when it was uploaded.
const SHORTS_WINDOW_DAYS = 30;
const SHORTS_JOBS_READ = 72;
// They publish at 08:00 and 12:00 Bangkok time; a longer silence is a missed day.
const SHORTS_QUIET_HOURS = 36;

const latest = (dates) => (dates.length ? new Date(Math.max(...dates)) : null);
const earliest = (dates) => (dates.length ? new Date(Math.min(...dates)) : null);

async function collectShorts(now) {
  // The trees API lists the queue in one call. The contents API would too, but
  // it stops at 1,000 entries and the queue only grows.
  const { tree } = await api(`/repos/${USER}/${SHORTS_REPO}/git/trees/main:queue`);
  const newestJobs = tree
    .map((entry) => ({ path: entry.path, createdAt: Number(/^job_(\d+)_/.exec(entry.path)?.[1]) }))
    .filter((job) => job.createdAt > 0)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, SHORTS_JOBS_READ);

  const publishTimes = [];
  for (const job of newestJobs) {
    // Raw files of a public repo do not count against the API's rate limit.
    const url = `https://raw.githubusercontent.com/${USER}/${SHORTS_REPO}/main/queue/${job.path}`;
    const response = await fetch(url, { headers: { "User-Agent": USER } });
    if (!response.ok) throw new Error(`HTTP ${response.status} on queue/${job.path}`);

    const { status, publish_at: publishAt } = await response.json();
    if (status === "uploaded" && publishAt) publishTimes.push(new Date(publishAt));
  }

  const windowStart = now.getTime() - SHORTS_WINDOW_DAYS * DAY_MS;
  const live = publishTimes.filter((time) => time <= now);

  return {
    liveInWindow: live.filter((time) => time.getTime() > windowStart).length,
    lastLive: latest(live),
    nextLive: earliest(publishTimes.filter((time) => time > now)),
  };
}

async function collectSite() {
  const { check_runs: checks } = await api(`/repos/${USER}/${SITE_REPO}/commits/main/check-runs`);
  const build = checks.find((check) => check.name.startsWith("Workers Builds"));
  if (!build) throw new Error("no Workers Builds check on main");

  return {
    status: build.status,
    conclusion: build.conclusion,
    finishedAt: build.completed_at ? new Date(build.completed_at) : null,
    labs: await readLabCount(),
  };
}

/** The lab count the site publishes about itself, or null when it cannot be read. */
async function readLabCount() {
  try {
    const response = await fetch(`${SITE}/profile.json`, { headers: { "User-Agent": USER } });
    if (!response.ok) return null;
    const { labs } = await response.json();
    return Number.isInteger(labs) && labs > 0 ? labs : null;
  } catch {
    return null;
  }
}

/**
 * A system whose status cannot be read gets a row that says so: one failed
 * lookup should not cost every other card its morning refresh.
 */
async function settle(lookup, name) {
  try {
    return await lookup;
  } catch (error) {
    console.warn(`status: could not read ${name} (${error.message})`);
    return null;
  }
}

async function collectSystems(now = new Date()) {
  return {
    checkedAt: now,
    shorts: await settle(collectShorts(now), "the Shorts queue"),
    site: await settle(collectSite(), "the WebPV deploy"),
  };
}

/* --------------------------------------------------------------- render --- */

const escapeText = (value) =>
  String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const compact = (value) =>
  value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k` : String(value);

const megabytes = (bytes) => `${(bytes / 1_000_000).toFixed(1)} MB`;

function cardShell(body, size = CARD) {
  const { width, height } = size;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">
  <defs>
    <linearGradient id="brand" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#E3BD70"/>
      <stop offset="60%" stop-color="#E3BD70" stop-opacity="0.6"/>
      <stop offset="100%" stop-color="#E3BD70" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="18"
        fill="${PALETTE.surface}" stroke="${PALETTE.hairline}"/>
${body}
</svg>
`;
}

function metric(x, y, value, label) {
  return `  <text x="${x}" y="${y}" fill="${PALETTE.text}" font-family="${FONT_SANS}" font-size="34" font-weight="600">${value}</text>
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

function renderContributionsCard(profile) {
  const { days, total, current, longest, fromCalendar } = profile.contributions;

  const CELL = 12;
  const GAP = 3;
  const GRID = { x: 32, y: 150 };
  const busiest = Math.max(...days.map((day) => day.count), 1);

  const heatAt = (count) => {
    if (count === 0) return PALETTE.heat[0];
    const level = Math.ceil((count / busiest) * (PALETTE.heat.length - 1));
    return PALETTE.heat[Math.min(level, PALETTE.heat.length - 1)];
  };

  // The calendar always starts on a Sunday, so index order fills columns cleanly.
  const cells = days
    .map((day, index) => {
      const x = GRID.x + Math.floor(index / 7) * (CELL + GAP);
      const y = GRID.y + (index % 7) * (CELL + GAP);
      return `  <rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="3" fill="${heatAt(day.count)}"><title>${day.date}: ${day.count}</title></rect>`;
    })
    .join("\n");

  const metrics = [
    [compact(total), fromCalendar ? "CONTRIBUTIONS" : "PUBLIC COMMITS"],
    [`${current}d`, "CURRENT STREAK"],
    [`${longest}d`, "LONGEST STREAK"],
  ];

  const row = metrics
    .map(([value, label], index) => {
      const x = 32 + index * 240;
      return `  <text x="${x}" y="${106}" fill="${PALETTE.text}" font-family="${FONT_SANS}" font-size="32" font-weight="600">${value}</text>
  <text x="${x}" y="${128}" fill="${PALETTE.muted}" font-family="${FONT_MONO}" font-size="11" letter-spacing="1.6">${label}</text>`;
    })
    .join("\n");

  return cardShell(
    `  <text x="32" y="46" fill="${PALETTE.label}" font-family="${FONT_MONO}" font-size="11" letter-spacing="3">CONTRIBUTIONS / LAST 12 MONTHS</text>
  <rect x="32" y="60" width="796" height="1.5" rx="0.75" fill="url(#brand)" opacity="0.75"/>
${row}
${cells}`,
    WIDE_CARD,
  );
}

// The card is redrawn once a morning, so it states clock times rather than
// "6h ago", which would be wrong by evening.
const bangkokTime = (date) =>
  date.toLocaleString("en-GB", {
    timeZone: TIME_ZONE,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

function shortsRow(shorts, now) {
  const row = {
    name: "shorts",
    about: "Thai explainer channel: researched, voiced and uploaded by a pipeline",
  };
  if (!shorts) return { ...row, ok: false, detail: "could not read the queue this morning" };

  const quiet =
    !shorts.lastLive || now - shorts.lastLive > SHORTS_QUIET_HOURS * 3_600_000;
  const parts = [`${shorts.liveInWindow} live in the last ${SHORTS_WINDOW_DAYS} days`];
  if (quiet) {
    parts.push(shorts.lastLive ? `none since ${bangkokTime(shorts.lastLive)}` : "none live yet");
  }
  if (shorts.nextLive) parts.push(`next ${bangkokTime(shorts.nextLive)}`);

  return { ...row, ok: !quiet, detail: parts.join(" · ") };
}

// Check-run conclusions, as a sentence would say them.
const DEPLOY_OUTCOMES = { failure: "failed", timed_out: "timed out", action_required: "needs attention" };

function siteRow(site) {
  const row = {
    name: "webpv",
    about: site?.labs
      ? `portfolio and ${site.labs} working labs, deployed on every push`
      : "portfolio, deployed on every push",
  };
  if (!site) return { ...row, ok: false, detail: "could not read the latest deploy" };
  if (site.status !== "completed") {
    return { ...row, ok: true, detail: "deploying now; the previous build stays live until it lands" };
  }

  const when = site.finishedAt ? ` ${bangkokTime(site.finishedAt)}` : "";
  if (site.conclusion === "success") return { ...row, ok: true, detail: `deployed${when}` };

  const outcome = DEPLOY_OUTCOMES[site.conclusion] ?? String(site.conclusion).replace(/_/g, " ");
  return { ...row, ok: false, detail: `last deploy ${outcome}${when}; the previous build is still live` };
}

function renderStatusCard(systems) {
  const rows = [shortsRow(systems.shorts, systems.checkedAt), siteRow(systems.site)]
    .map((row, index) => {
      const y = 104 + index * 60;
      // A system that is behind gets an empty ring as well as the words, so the
      // card does not lean on colour alone.
      const dot = row.ok
        ? `<circle cx="37" cy="${y - 5}" r="4" fill="${PALETTE.ramp[0]}"/>`
        : `<circle cx="37" cy="${y - 5}" r="3.5" fill="none" stroke="${PALETTE.muted}" stroke-width="1.5"/>`;

      return `  ${dot}
  <text x="52" y="${y}" fill="${PALETTE.text}" font-family="${FONT_MONO}" font-size="14">${row.name}</text>
  <text x="140" y="${y}" fill="${PALETTE.text}" font-family="${FONT_SANS}" font-size="14">${escapeText(row.about)}</text>
  <text x="140" y="${y + 22}" fill="${PALETTE.muted}" font-family="${FONT_MONO}" font-size="12">${escapeText(row.detail)}</text>`;
    })
    .join("\n");

  const checked = `CHECKED ${bangkokTime(systems.checkedAt).toUpperCase()} BANGKOK · REDRAWN EVERY MORNING BY GITHUB ACTIONS`;

  return cardShell(
    `  <text x="32" y="46" fill="${PALETTE.label}" font-family="${FONT_MONO}" font-size="12" letter-spacing="1">~ $ ./status.sh</text>
  <rect x="32" y="60" width="796" height="1.5" rx="0.75" fill="url(#brand)" opacity="0.75"/>
${rows}
  <text x="32" y="${STATUS_CARD.height - 26}" fill="${PALETTE.label}" font-family="${FONT_MONO}" font-size="11" letter-spacing="1.6">${checked}</text>`,
    STATUS_CARD,
  );
}

/* ----------------------------------------------------------------- main --- */

const profile = await collectProfile();
const systems = await collectSystems();
await mkdir(ASSETS_DIR, { recursive: true });
await writeFile(join(ASSETS_DIR, "stats.svg"), renderStatsCard(profile), "utf8");
await writeFile(join(ASSETS_DIR, "activity.svg"), renderActivityCard(profile), "utf8");
await writeFile(
  join(ASSETS_DIR, "contributions.svg"),
  renderContributionsCard(profile),
  "utf8",
);
await writeFile(join(ASSETS_DIR, "status.svg"), renderStatusCard(systems), "utf8");

const { total, current, longest, fromCalendar } = profile.contributions;
const { shorts, site } = systems;
console.log(
  `cards rebuilt - ${profile.repoCount} repos, ${profile.commits} commits, ` +
    `${profile.languageCount} languages, ${profile.recent.length} recent pushes, ` +
    `${total} contributions (source: ${fromCalendar ? "calendar" : "public commits"}), ` +
    `streak ${current}d current / ${longest}d longest; ` +
    `status: shorts ${shorts ? `${shorts.liveInWindow} live in 30d` : "unread"}, ` +
    `webpv ${site ? (site.conclusion ?? site.status) : "unread"}`,
);
