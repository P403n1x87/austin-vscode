#!/usr/bin/env node

// Collates changelog fragments from changelog/ that were added since the
// previous release tag, and prepends them to CHANGELOG.md in the working
// directory (for packaging purposes only — nothing is committed back).
//
// Usage: node scripts/collate-changelog.js <version> [--delta <file>]
//
// The script uses git to find the previous release tag and diff the
// changelog/ directory to discover which fragments are new. If --delta
// is given, the new version section is written to that file (for use
// as a GitHub release description).

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const CATEGORY_MAP = {
  feat: "What's New",
  fix: "Bug Fixes",
  perf: "Other Improvements",
};

const CATEGORY_ORDER = ["feat", "fix", "perf"];

const args = process.argv.slice(2);
const deltaIdx = args.indexOf("--delta");
let deltaFile = null;
if (deltaIdx !== -1) {
  deltaFile = args[deltaIdx + 1];
  if (!deltaFile) {
    console.error("--delta requires a file path");
    process.exit(1);
  }
  args.splice(deltaIdx, 2);
}

const version = args[0];
if (!version) {
  console.error("Usage: collate-changelog.js <version> [--delta <file>]");
  process.exit(1);
}

const root = path.join(__dirname, "..");
const changelogDir = path.join(root, "changelog");
const changelogFile = path.join(root, "CHANGELOG.md");

// Find the most recent ancestor tag that looks like a semver version
// (vX.Y.Z), excluding the current release tag.
function getPreviousTag() {
  const currentTag = `v${version}`;
  try {
    // List tags reachable from HEAD, nearest first
    const tags = execSync("git tag --merged HEAD --sort=-version:refname", {
      cwd: root,
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean);

    for (const tag of tags) {
      if (tag === currentTag) continue;
      if (/^v\d+\.\d+\.\d+$/.test(tag)) return tag;
    }
  } catch {
    // no tags at all
  }
  return null;
}

const prevTag = getPreviousTag();

// Get fragment files added since the previous tag
let fragmentFiles;
if (prevTag) {
  const diff = execSync(`git diff --name-only --diff-filter=A ${prevTag}..HEAD -- changelog/`, {
    cwd: root,
    encoding: "utf8",
  });
  fragmentFiles = diff
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((f) => path.basename(f))
    .filter((f) => CATEGORY_ORDER.some((cat) => f.endsWith(`.${cat}.md`)));
} else {
  // No previous tag — pick all fragments
  fragmentFiles = fs
    .readdirSync(changelogDir)
    .filter((f) => CATEGORY_ORDER.some((cat) => f.endsWith(`.${cat}.md`)));
}

if (fragmentFiles.length === 0) {
  console.error("No new changelog fragments found since " + (prevTag || "the beginning") + ".");
  process.exit(1);
}

// Collect entries grouped by category
const entries = {};
for (const cat of CATEGORY_ORDER) {
  entries[cat] = [];
}

for (const file of fragmentFiles) {
  const cat = CATEGORY_ORDER.find((c) => file.endsWith(`.${c}.md`));
  const content = fs.readFileSync(path.join(changelogDir, file), "utf8").trim();
  entries[cat].push(content);
}

// Wrap an entry as a markdown bullet: "- " for the first line, "  " for
// continuation lines, with lines no longer than 79 characters total.
function wrapBullet(entry) {
  const MAX = 79;
  const words = entry.replace(/^- /, "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "- ";
  for (const word of words) {
    const prefix = lines.length === 0 ? "- " : "  ";
    if (line.length + (line === prefix ? 0 : 1) + word.length > MAX) {
      lines.push(line);
      line = `  ${word}`;
    } else {
      line += (line === prefix ? "" : " ") + word;
    }
  }
  if (line.trim()) lines.push(line);
  return lines.join("\n");
}

// Build a section block with configurable heading level for categories.
// headingLevel: 2 → "## Category", 3 → "### Category"
function buildSection(headingLevel) {
  const hashes = "#".repeat(headingLevel);
  let out = "";
  for (const cat of CATEGORY_ORDER) {
    if (entries[cat].length === 0) continue;
    out += `${hashes} ${CATEGORY_MAP[cat]}\n\n`;
    for (const entry of entries[cat]) {
      out += `${wrapBullet(entry)}\n\n`;
    }
  }
  return out;
}

// Read the repo URL from package.json for the releases link
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const repoUrl = (pkg.repository && pkg.repository.url) || pkg.repository || "";
const releasesUrl = repoUrl.replace(/\.git$/, "") + "/releases";

// Write CHANGELOG.md: version heading, ### category sections, separator, link
const changelogSection = buildSection(3);
const changelog =
  `# Change Log\n\n## [${version}]\n\n${changelogSection}` +
  `----\n\n` +
  `For the full change log, see the [releases page](${releasesUrl}).\n`;
fs.writeFileSync(changelogFile, changelog);

// Write the delta: ## category sections, no version heading
if (deltaFile) {
  fs.writeFileSync(deltaFile, buildSection(2).trimEnd() + "\n");
}
