#!/usr/bin/env node

// Creates a new changelog fragment.
// Usage: node scripts/new-changelog.js <category> <title>
//
// Example: npm run note fix "Fixed crash on empty profile"
//
// Generates: changelog/<slug>-<short-uuid>.<category>.md

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CATEGORIES = ["feat", "fix", "perf"];

const category = process.argv[2];
const title = process.argv.slice(3).join(" ");

if (!category || !title) {
  console.error("Usage: npm run note <feat|fix|perf> <title>");
  process.exit(1);
}

if (!CATEGORIES.includes(category)) {
  console.error(`Invalid category: ${category}. Must be one of: ${CATEGORIES.join(", ")}`);
  process.exit(1);
}

const slug = title
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "");

const uuid = crypto.randomUUID().split("-")[0]; // 8-char hex
const filename = `${slug}-${uuid}.${category}.md`;
const filepath = path.join(__dirname, "..", "changelog", filename);

fs.writeFileSync(filepath, `${title}\n`);
console.log(`Created ${path.relative(process.cwd(), filepath)}`);
