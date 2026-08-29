import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

import { evaluateOverlayReview, validateManifest } from "./review-overlay.mjs";

const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const REPO = NodePath.resolve(HERE, "..");
const MANIFEST = JSON.parse(
  NodeFS.readFileSync(NodePath.resolve(HERE, "overlay-manifest.json"), "utf8"),
);

NodeTest.test("the four-feature registry is valid", () => {
  NodeAssert.equal(validateManifest(MANIFEST).features.length, 4);
  NodeAssert.deepEqual(
    MANIFEST.features.map((feature) => feature.id),
    [
      "desktop-backend-watchdog",
      "codex-process-lifecycle-guardian",
      "single-authoritative-mini-backend",
      "active-work-update-gate",
    ],
  );
});

NodeTest.test("the reviewed official v0.0.36 source is approved", () => {
  const report = evaluateOverlayReview({ repo: REPO, tag: "v0.0.36", manifest: MANIFEST });
  NodeAssert.equal(report.result, "approved");
  NodeAssert.match(report.reportSha256, /^[a-f0-9]{64}$/u);
  NodeAssert.deepEqual(
    report.features.map((feature) => feature.state),
    ["retained-reviewed", "retained-reviewed", "native-confirmed", "retained-reviewed"],
  );
});

NodeTest.test("a new official tag is blocked until the registry is reviewed", () => {
  const oldReview = structuredClone(MANIFEST);
  oldReview.reviewedThrough = {
    ...oldReview.reviewedThrough,
    tag: "v0.0.35",
    commit: "f925d639421844f02b3166d29281905dbba6d529",
  };
  const report = evaluateOverlayReview({ repo: REPO, tag: "v0.0.36", manifest: oldReview });
  NodeAssert.equal(report.result, "review_required");
  NodeAssert.ok(report.features.every((feature) => feature.state.startsWith("review-required")));
});

NodeTest.test("new native equivalence forces a retain-or-retire decision", () => {
  const staleDecision = structuredClone(MANIFEST);
  staleDecision.features[0].upstreamEquivalentEvidence = [
    {
      path: "apps/desktop/src/backend/DesktopBackendManager.ts",
      contains: "probeReadiness",
    },
  ];
  const report = evaluateOverlayReview({ repo: REPO, tag: "v0.0.36", manifest: staleDecision });
  NodeAssert.equal(report.result, "review_required");
  NodeAssert.equal(report.features[0].state, "review-required-upstream-equivalent");
});

NodeTest.test("a changed source contract fails closed", () => {
  const staleContract = structuredClone(MANIFEST);
  staleContract.features[1].requiredEvidence = [
    {
      path: "apps/server/src/provider/Layers/CodexSessionRuntime.ts",
      contains: "missing-provider-spawn-contract",
    },
  ];
  const report = evaluateOverlayReview({ repo: REPO, tag: "v0.0.36", manifest: staleContract });
  NodeAssert.equal(report.result, "review_required");
  NodeAssert.equal(report.features[1].state, "review-required-contract-changed");
});
