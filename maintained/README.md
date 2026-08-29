# Maintained overlay review gate

This directory is the versioned source of truth for the small local overlay. It replaces the old
assumption that a clean three-way patch application means an official T3 Code update is compatible.

Run the gate against the exact official tag before exporting or applying any product patch:

```sh
node maintained/review-overlay.mjs --repo . --tag v0.0.36
```

Exit code `0` means the tag and commit exactly match the reviewed registry and all required source
contracts still match. Exit code `2` means a human review is required. Any new official tag is
blocked by default, even if every patch would apply cleanly. The report identifies changed feature
paths, possible native equivalence, required focused tests, and a deterministic report hash. A
prepared artifact must record that hash so it cannot be confused with a build reviewed against a
different upstream state.

The registry contains exactly four maintained advantages:

1. Post-readiness desktop backend watchdog.
2. Codex process-group lifecycle guardian and writer-lock recovery.
3. Single authoritative Mini backend through the official T3 Connect relay, with native Tailscale
   HTTPS bearer pairing as an optional direct fallback when Serve is enabled for the tailnet.
4. Active-work update gate with a second check immediately before launcher handoff.

The third item is configuration, not a source patch. The Mini desktop app is the sole launch owner;
the background service, SSH-launched server, and ad-hoc `npx t3 serve` must not run concurrently.
The Air normally connects to the Mini through the official T3 Connect relay, so changing Wi-Fi or
hotspot networks does not create another Mini backend. A Tailscale HTTPS bearer connection is an
optional direct fallback only after Tailscale Serve is enabled for the tailnet; SSH remains a
diagnostic/admin transport rather than a T3 backend launch owner.

Modifying an official `.app` invalidates its Apple signature. A custom artifact must be unsigned,
ad-hoc signed, or signed with the owner's Developer ID. The only path to an official T3 signature is
upstream acceptance followed by an official release containing the accepted changes.
