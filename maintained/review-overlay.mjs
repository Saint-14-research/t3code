#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const DEFAULT_MANIFEST = NodePath.resolve(HERE, "overlay-manifest.json");
const STABLE_TAG = /^v\d+\.\d+\.\d+$/u;

function runGit(repo, args, allowFailure = false) {
  const result = NodeChildProcess.spawnSync("/usr/bin/git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr).trim()}`);
  }
  return result;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

export function validateManifest(manifest) {
  if (manifest?.schemaVersion !== 1) throw new Error("Unsupported overlay manifest schema.");
  if (manifest.officialRepository !== "https://github.com/pingdotgg/t3code.git") {
    throw new Error("Overlay review must target the official T3 Code repository.");
  }
  if (!STABLE_TAG.test(manifest.reviewedThrough?.tag ?? "")) {
    throw new Error("reviewedThrough.tag must be an exact stable tag.");
  }
  if (!/^[a-f0-9]{40}$/u.test(manifest.reviewedThrough?.commit ?? "")) {
    throw new Error("reviewedThrough.commit must be a full Git commit.");
  }
  if (!Array.isArray(manifest.features) || manifest.features.length !== 4) {
    throw new Error("The overlay manifest must classify exactly four maintained advantages.");
  }
  const identifiers = new Set();
  for (const feature of manifest.features) {
    requireString(feature.id, "feature.id");
    if (identifiers.has(feature.id)) throw new Error(`Duplicate feature id ${feature.id}.`);
    identifiers.add(feature.id);
    if (!new Set(["retain", "native-configuration"]).has(feature.decision)) {
      throw new Error(`Unsupported decision for ${feature.id}.`);
    }
    for (const field of ["intent", "retentionCondition"])
      requireString(feature[field], `${feature.id}.${field}`);
    if (!Array.isArray(feature.reviewPaths) || feature.reviewPaths.length === 0) {
      throw new Error(`${feature.id}.reviewPaths must not be empty.`);
    }
    if (!Array.isArray(feature.requiredEvidence) || feature.requiredEvidence.length === 0) {
      throw new Error(`${feature.id}.requiredEvidence must not be empty.`);
    }
    for (const evidence of [
      ...feature.requiredEvidence,
      ...(feature.upstreamEquivalentEvidence ?? []),
    ]) {
      requireString(evidence.path, `${feature.id}.evidence.path`);
      requireString(evidence.contains, `${feature.id}.evidence.contains`);
      if (evidence.path.startsWith("/") || evidence.path.split("/").includes("..")) {
        throw new Error(`${feature.id} contains an unsafe evidence path.`);
      }
    }
  }
  return manifest;
}

function readAtCommit(repo, commit, path) {
  const result = runGit(repo, ["show", `${commit}:${path}`], true);
  return result.status === 0 ? result.stdout : null;
}

function inspectEvidence(repo, commit, evidence) {
  const content = readAtCommit(repo, commit, evidence.path);
  return {
    path: evidence.path,
    contains: evidence.contains,
    matched: content?.includes(evidence.contains) === true,
  };
}

function changedReviewPaths(repo, fromCommit, toCommit, paths) {
  if (fromCommit === toCommit) return [];
  const result = runGit(repo, ["diff", "--name-only", fromCommit, toCommit, "--", ...paths]);
  return result.stdout
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function evaluateOverlayReview({ repo, tag, manifest }) {
  const validated = validateManifest(manifest);
  if (!STABLE_TAG.test(tag)) throw new Error("Target must be an exact stable tag.");
  const repository = NodeFS.realpathSync(repo);
  const origin = runGit(repository, ["remote", "get-url", "origin"]).stdout.trim();
  if (origin !== validated.officialRepository) {
    throw new Error(
      `Repository origin is ${JSON.stringify(origin)}, not the official T3 Code repository.`,
    );
  }
  const targetCommit = runGit(repository, ["rev-parse", `${tag}^{commit}`]).stdout.trim();
  const reviewedCommit = runGit(repository, [
    "rev-parse",
    `${validated.reviewedThrough.tag}^{commit}`,
  ]).stdout.trim();
  if (reviewedCommit !== validated.reviewedThrough.commit) {
    throw new Error("The reviewed tag no longer resolves to the manifest's reviewed commit.");
  }

  const reviewedTarget =
    tag === validated.reviewedThrough.tag && targetCommit === validated.reviewedThrough.commit;
  const features = validated.features.map((feature) => {
    const requiredEvidence = feature.requiredEvidence.map((evidence) =>
      inspectEvidence(repository, targetCommit, evidence),
    );
    const equivalentEvidence = (feature.upstreamEquivalentEvidence ?? []).map((evidence) =>
      inspectEvidence(repository, targetCommit, evidence),
    );
    const requiredSatisfied = requiredEvidence.every((evidence) => evidence.matched);
    const upstreamEquivalent =
      equivalentEvidence.length > 0 && equivalentEvidence.every((evidence) => evidence.matched);
    const changedPaths = changedReviewPaths(
      repository,
      validated.reviewedThrough.commit,
      targetCommit,
      feature.reviewPaths,
    );

    let state;
    if (!requiredSatisfied) state = "review-required-contract-changed";
    else if (feature.decision === "retain" && upstreamEquivalent)
      state = "review-required-upstream-equivalent";
    else if (!reviewedTarget) state = "review-required-new-upstream";
    else state = feature.decision === "retain" ? "retained-reviewed" : "native-confirmed";

    return {
      id: feature.id,
      decision: feature.decision,
      state,
      changedPaths,
      requiredEvidence,
      equivalentEvidence,
      verify: feature.verify,
    };
  });
  const approvedStates = new Set(["retained-reviewed", "native-confirmed"]);
  const result =
    reviewedTarget && features.every((feature) => approvedStates.has(feature.state))
      ? "approved"
      : "review_required";
  const report = {
    schemaVersion: 1,
    result,
    officialRepository: validated.officialRepository,
    target: { tag, commit: targetCommit },
    reviewedThrough: validated.reviewedThrough,
    signing: validated.signing,
    topology: validated.topology,
    productPatchCommits: validated.productPatchCommits,
    features,
  };
  const reportSha256 = NodeCrypto.createHash("sha256").update(JSON.stringify(report)).digest("hex");
  return { ...report, reportSha256 };
}

function parseArguments(argv) {
  const result = { repo: ".", manifest: DEFAULT_MANIFEST, tag: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--repo" || argument === "--manifest" || argument === "--tag") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value.`);
      result[argument.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument ${argument}.`);
    }
  }
  if (result.tag === undefined) throw new Error("--tag is required.");
  return result;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const manifest = JSON.parse(NodeFS.readFileSync(NodePath.resolve(args.manifest), "utf8"));
  const report = evaluateOverlayReview({
    repo: NodePath.resolve(args.repo),
    tag: args.tag,
    manifest,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.result !== "approved") process.exitCode = 2;
}

if (
  process.argv[1] &&
  NodeFS.realpathSync(process.argv[1]) ===
    NodeFS.realpathSync(NodeURL.fileURLToPath(import.meta.url))
) {
  await main();
}
