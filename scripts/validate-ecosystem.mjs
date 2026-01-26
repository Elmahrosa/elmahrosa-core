#!/usr/bin/env node
/**
 * TEOS / Elmahrosa - Ecosystem Governance Validator (No deps)
 *
 * What it does:
 * - Reads ecosystem-map.json
 * - For each repo entry:
 *   - Checks if teos-manifest.json exists via GitHub Contents API
 *   - Enforces strict requirements for Core/Module
 *   - Validates canonical authority URLs inside manifest (ICBC/TESL/FORGE/KERNEL)
 *
 * Fails CI on:
 * - Missing ecosystem-map.json
 * - Missing manifest for Core/Module (and optionally Apps if STRICT_APPS=true)
 * - Canonical authority mismatch in any manifest that exists
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const OWNER = "Elmahrosa";
const MAP_PATH = path.resolve("ecosystem-map.json");
const MANIFEST_NAME = "teos-manifest.json";

const token = process.env.GITHUB_TOKEN;
const strictApps = (process.env.STRICT_APPS || "false").toLowerCase() === "true";

function die(msg) {
  console.error(`\n[FAIL] ${msg}\n`);
  process.exit(1);
}

function warn(msg) {
  console.warn(`[WARN] ${msg}`);
}

function info(msg) {
  console.log(`[INFO] ${msg}`);
}

async function ghGetJson(url) {
  const headers = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "elmahrosa-core-ci"
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(url, { headers });
  if (res.status === 404) return { __not_found: true };
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API error ${res.status}: ${text}`);
  }
  return res.json();
}

async function manifestExists(repo) {
  const url = `https://api.github.com/repos/${OWNER}/${repo}/contents/${MANIFEST_NAME}`;
  const data = await ghGetJson(url);
  return !data.__not_found;
}

async function fetchManifest(repo) {
  const url = `https://api.github.com/repos/${OWNER}/${repo}/contents/${MANIFEST_NAME}`;
  const data = await ghGetJson(url);
  if (data.__not_found) return null;
  if (!data.content) throw new Error(`Manifest content missing in API response for ${repo}`);
  const decoded = Buffer.from(data.content, "base64").toString("utf8");
  try {
    return JSON.parse(decoded);
  } catch (e) {
    throw new Error(`Invalid JSON in ${repo}/${MANIFEST_NAME}: ${e.message}`);
  }
}

function getCanonicalAuthority(map) {
  const a = map?.authority;
  if (!a?.icbc || !a?.tesl_canonical || !a?.stewardship || !a?.kernel) {
    die("ecosystem-map.json missing required authority fields (icbc, tesl_canonical, stewardship, kernel).");
  }
  return {
    icbc: a.icbc,
    tesl: a.tesl_canonical,
    forge: a.stewardship,
    kernel: a.kernel
  };
}

function requireFields(obj, fields, context) {
  const missing = [];
  for (const f of fields) {
    const parts = f.split(".");
    let cur = obj;
    for (const p of parts) {
      if (cur && Object.prototype.hasOwnProperty.call(cur, p)) cur = cur[p];
      else {
        missing.push(f);
        break;
      }
    }
  }
  if (missing.length) {
    die(`${context} missing required fields: ${missing.join(", ")}`);
  }
}

function assertCanonical(manifest, canon, repoName) {
  // Minimal defensible checks (no schema dependency)
  requireFields(
    manifest,
    [
      "schema",
      "name",
      "repo",
      "role",
      "status",
      "authority.icbc",
      "authority.tesl_canonical",
      "stewardship.teos_forge",
      "stewardship.kernel"
    ],
    `${repoName}/${MANIFEST_NAME}`
  );

  // Canonical URLs must match exactly
  if (manifest.authority.icbc !== canon.icbc) {
    die(`${repoName}: authority.icbc mismatch. Expected: ${canon.icbc}`);
  }
  if (manifest.authority.tesl_canonical !== canon.tesl) {
    die(`${repoName}: authority.tesl_canonical mismatch. Expected: ${canon.tesl}`);
  }
  if (manifest.stewardship.teos_forge !== canon.forge) {
    die(`${repoName}: stewardship.teos_forge mismatch. Expected: ${canon.forge}`);
  }
  if (manifest.stewardship.kernel !== canon.kernel) {
    die(`${repoName}: stewardship.kernel mismatch. Expected: ${canon.kernel}`);
  }

  // Repo identity hygiene
  if (manifest.repo !== `${OWNER}/${repoName}`) {
    die(`${repoName}: manifest.repo must equal "${OWNER}/${repoName}" (found: "${manifest.repo}")`);
  }

  // Schema version guard
  if (manifest.schema !== "teos.manifest.v1") {
    die(`${repoName}: manifest.schema must be "teos.manifest.v1"`);
  }
}

async function main() {
  if (!fs.existsSync(MAP_PATH)) {
    die("ecosystem-map.json not found in repo root.");
  }

  const map = JSON.parse(fs.readFileSync(MAP_PATH, "utf8"));
  const canon = getCanonicalAuthority(map);

  info(`ICBC: ${canon.icbc}`);
  info(`TESL: ${canon.tesl}`);
  info(`FORGE: ${canon.forge}`);
  info(`KERNEL: ${canon.kernel}`);

  const repos = map?.repositories;
  if (!Array.isArray(repos) || repos.length === 0) {
    die("ecosystem-map.json has no repositories list.");
  }

  let failures = 0;
  let warnings = 0;

  for (const r of repos) {
    const repoName = r?.name;
    const role = r?.role;

    // Skip placeholders
    if (r?.status === "not_listed") {
      warn(`Skipping placeholder entry: ${repoName}`);
      warnings++;
      continue;
    }

    if (!repoName || !role) {
      die("Each repositories[] entry must include name and role.");
    }

    const exists = await manifestExists(repoName);

    const requireManifest =
      role === "Core" || role === "Module" || (strictApps && role === "App");

    if (!exists && requireManifest) {
      console.error(`[FAIL] ${repoName}: missing ${MANIFEST_NAME} (role=${role})`);
      failures++;
      continue;
    }

    if (!exists && !requireManifest) {
      warn(`${repoName}: missing ${MANIFEST_NAME} (role=${role}) — allowed for now.`);
      warnings++;
      continue;
    }

    // Manifest exists: validate canonical authority
    try {
      const manifest = await fetchManifest(repoName);
      if (!manifest) {
        // Should not happen since exists=true, but safe.
        console.error(`[FAIL] ${repoName}: expected manifest but could not fetch.`);
        failures++;
        continue;
      }
      assertCanonical(manifest, canon, repoName);
      info(`${repoName}: manifest OK`);
    } catch (e) {
      console.error(`[FAIL] ${repoName}: ${e.message}`);
      failures++;
    }
  }

  console.log("\n--- Summary ---");
  console.log(`Failures: ${failures}`);
  console.log(`Warnings: ${warnings}`);

  if (failures > 0) {
    process.exit(1);
  }

  info("Ecosystem governance validation passed.");
}

main().catch((e) => die(e.message));
