# Loqii Runtime Stable Checkpoint - 2026-05-29

## Summary

Manual QA on 2026-05-29 confirmed the current Loqii app repo state as the stable runtime baseline for development start, Decart client-token startup, authoritative session registration, billing sync, stop cleanup, and start/stop/restart recovery.

Future work touching session/start/stop/auth/Decart/billing code must preserve the invariants below.

## Systems Confirmed Working

- Dev startup starts cleanly.
- Public config boot loads successfully.
- Privileged `/api/bootstrap` is skipped in normal development.
- Authenticated Decart client-token flow works.
- Dev Decart environment routing works.
- Authoritative billing session registration works.
- Billing session registration proxy returns 200.
- Manual stop billing deduction returns 200.
- Credit balance refreshes correctly.
- Start -> Stop -> Start again works.
- A fresh `session_id` is generated for the second start.
- No `409 session_not_found` occurs in the confirmed flow.
- Billing deducts once.
- Loqii app repo and Tzurah-AI server/admin repo remain separate.

## Manual QA Evidence

Representative manual log evidence:

```text
[CONFIG] public_config loaded
[BOOTSTRAP] Privileged bootstrap skipped in dev; using public config.
[DECART] client token received env=dev
[SESSION REGISTER] proxy response { status: 200, ok: true, body: { ok: true } }
[DEDUCT] Server response: 200
[DEDUCT] Server confirmed remaining: 183
```

Second start generated fresh session id:

```text
5a3ce7b2-2058-47e8-8336-a17704a588ad
```

## Runtime Invariants That Must Not Regress

- Do not call privileged `/api/bootstrap` in normal development.
- Do not expose permanent Decart keys to the renderer or app repo.
- Decart startup must use authenticated short-lived client tokens only.
- Register the authoritative billing session before timers or deduction.
- Apply selected identity before billing activation.
- Stop must always end in `idle`.
- Start must re-enable after cleanup.
- The next start must use a fresh `session_id`.
- Billing deduct must use the registered authoritative `session_id`.
- No app files go to Tzurah-AI.
- No server/admin files go to Loqii.

## Known Non-Blocking Warnings

- Electron/Node `MODULE_TYPELESS_PACKAGE_JSON` warning for `build.js`.
- Chromium STUN DNS warnings for `stun.l.google.com` can appear and did not block session or billing in the tested flow.

## Remaining Risks / Next Priorities

- Final specialized modal cleanup.
- Admin feature flag control plane follow-through.
- Beta packaging with `electron-builder`.
- Production session store hardening on backend.
- Decart approval/public repo readiness.
- OAuth success and banned-user full pass if not already fully confirmed.

## Rollback Reference / Commit References

Stable baseline includes these recent Loqii app commits:

- `1bf7da3` - fix identity handoff regression
- `3ffcc40` - fix stop lifecycle reset and start recovery
- `46c3cc1` - fix session registration diagnostics and contract
- `c3795f5` - fix authoritative billing session registration
- `62be21e` - remove dev bootstrap noise and clarify client token boot
