/**
 * Rewrites the parts of README.md that repeat facts about the portfolio, from
 * the portfolio's own profile.json, so the profile follows the site instead of
 * going stale beside it (it said "twelve" labs for a month after there were
 * fourteen).
 *
 * Two kinds of marked region in README.md:
 *   <!-- site:labs -->fourteen<!-- /site:labs -->   the number of listed labs
 *   ... <!-- site:projects -->                       one bullet per project, from
 *   - **[A](...)** · ...                             the line after the opening
 *   - **[B](...)** · ... <!-- /site:projects -->     marker to the closing one
 * The markers end list lines rather than sitting on lines of their own: a
 * comment on its own line ends a Markdown list, and the bullets above and
 * below it would render as two lists with a gap between.
 *
 * When the feed cannot be read or does not look right, README.md is left as it
 * is: a stale line is better than a profile with its list wiped out.
 *
 * Usage: node scripts/sync-readme.mjs [feed]
 *   feed defaults to the live site's profile.json; a local path works too,
 *   for checking a build before it is deployed.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = "https://webpv.yimwired.workers.dev";
const README = join(dirname(fileURLToPath(import.meta.url)), "..", "README.md");

const NUMBER_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
  "eighteen", "nineteen", "twenty",
];

const inWords = (count) => NUMBER_WORDS[count] ?? String(count);

async function readFeed(source) {
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source, { headers: { "User-Agent": "yimwired-profile" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }
  return JSON.parse(await readFile(source, "utf8"));
}

function looksRight(feed) {
  return (
    Number.isInteger(feed?.labs) &&
    feed.labs > 0 &&
    Array.isArray(feed.projects) &&
    feed.projects.length > 0 &&
    feed.projects.every((project) => project.name && project.tagline && project.url)
  );
}

/** Replaces every inline region named `name` with `value`. */
function fillInline(text, name, value) {
  const pattern = new RegExp(`(<!-- site:${name} -->)[\\s\\S]*?(<!-- /site:${name} -->)`, "g");
  return text.replace(pattern, `$1${value}$2`);
}

/**
 * Replaces the lines between the end of the opening marker's line and the
 * closing marker with `lines`, the closing marker kept at the end of the last.
 * Line endings follow the file's: a Windows checkout has CRLF.
 */
function fillBlock(text, name, lines) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const pattern = new RegExp(`(<!-- site:${name} -->)\\r?\\n[\\s\\S]*? (<!-- /site:${name} -->)`);
  return text.replace(pattern, () => `<!-- site:${name} -->${eol}${lines.join(eol)} <!-- /site:${name} -->`);
}

const source = process.argv[2] ?? `${SITE}/profile.json`;

let feed;
try {
  feed = await readFeed(source);
} catch (error) {
  console.log(`README left as it is: could not read ${source} (${error.message})`);
  process.exit(0);
}
if (!looksRight(feed)) {
  console.log(`README left as it is: ${source} did not have the expected shape`);
  process.exit(0);
}

const before = await readFile(README, "utf8");
const projects = feed.projects.map((project) => `- **[${project.name}](${project.url})** · ${project.tagline}`);
const after = fillBlock(fillInline(before, "labs", inWords(feed.labs)), "projects", projects);

if (after === before) {
  console.log("README already current");
} else {
  await writeFile(README, after, "utf8");
  console.log(`README updated: ${feed.labs} labs, ${feed.projects.length} projects`);
}
