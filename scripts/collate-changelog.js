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
  feat: "New Features",
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

// Build the new version section
let section = `## [${version}]\n`;

for (const cat of CATEGORY_ORDER) {
  if (entries[cat].length === 0) continue;
  section += `\n### ${CATEGORY_MAP[cat]}\n\n`;
  for (const entry of entries[cat]) {
    const lines = entry.split("\n");
    const formatted = lines
      .map((line, i) => (i === 0 && !line.startsWith("- ") ? `- ${line}` : line))
      .join("\n");
    section += `${formatted}\n\n`;
  }
}

// Read the repo URL from package.json for the releases link
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const repoUrl = (pkg.repository && pkg.repository.url) || pkg.repository || "";
const releasesUrl = repoUrl.replace(/\.git$/, "") + "/releases";

// Write CHANGELOG.md with just this release's notes and a link to full history
const changelog =
  `# Change Log\n\n${section}` +
  `For the full change log, see the [releases page](${releasesUrl}).\n`;
fs.writeFileSync(changelogFile, changelog);

// Write the new section to the delta file if requested
if (deltaFile) {
  fs.writeFileSync(deltaFile, section.trim() + "\n");
}
