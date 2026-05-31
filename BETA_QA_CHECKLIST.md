# Loqii Beta QA Checklist

Use this checklist before any beta packaging or external tester handoff. Mark each row Pass, Fail, or N/A and add notes with the account, environment, and commit tested.

| Area | Check | Status | Notes |
| --- | --- | --- | --- |
| App boot | `npm run electron:dev` starts cleanly |  |  |
| App boot | Public config loads successfully |  |  |
| App boot | No privileged `/api/bootstrap` 403 noise in normal dev |  |  |
| App boot | No renderer direct-backend CORS errors |  |  |
| Auth | Email/password login succeeds |  |  |
| Auth | Google login succeeds |  |  |
| Auth | Banned Google account shows safe blocked state |  |  |
| Auth | Explicit Sign Out returns to login |  |  |
| Auth | Close/reopen restores a valid session |  |  |
| Core runtime | Select an identity before start |  |  |
| Core runtime | Start session and confirm identity appears |  |  |
| Core runtime | Apply scene during active session |  |  |
| Core runtime | Apply style during active session |  |  |
| Core runtime | Stop session cleanly |  |  |
| Core runtime | Start again after stop |  |  |
| Core runtime | Start/Stop buttons never get stuck |  |  |
| Billing/session | `/session/ping` returns 200 |  |  |
| Billing/session | `/credits/deduct` returns 200 |  |  |
| Billing/session | `/session/end` returns 200 |  |  |
| Billing/session | Balance updates exactly once after stop |  |  |
| Billing/session | No `409 session_not_found` |  |  |
| Billing/session | No duplicate active sessions |  |  |
| Feature flags | Help flag toggles Help visibility |  |  |
| Feature flags | Onboarding flag toggles onboarding |  |  |
| Feature flags | Google OAuth flag controls OAuth button |  |  |
| Feature flags | Dev diagnostics remain hidden for normal user |  |  |
| Feature flags | Dev diagnostics appear for dev user when enabled |  |  |
| UI/responsive | Light mode readable |  |  |
| UI/responsive | Dark mode readable |  |  |
| UI/responsive | 1366x768 layout usable |  |  |
| UI/responsive | 1440x900 layout usable |  |  |
| UI/responsive | 1920x1080 layout expands cleanly |  |  |
| UI/responsive | Scenes tab scrolls to last scene |  |  |
| UI/responsive | Prompt panel remains bounded |  |  |
| UI/responsive | Session summary modal readable |  |  |
| UI/responsive | OBS setup modal readable |  |  |
| UI/responsive | Florence download modal readable |  |  |
| UI/responsive | Admin kill/session-ended modal readable |  |  |
| Local proxy | `/api/ensure-profile` uses localhost proxy |  |  |
| Local proxy | `/api/announcements` uses localhost proxy |  |  |
| Local proxy | `/session/end` uses localhost proxy |  |  |
| Local proxy | No renderer direct backend CORS errors |  |  |
| Admin/backend | Admin login succeeds |  |  |
| Admin/backend | Feature Flags page loads |  |  |
| Admin/backend | Dev/Test Accounts flow works |  |  |
| Admin/backend | Billing page loads |  |  |
| Admin/backend | Reconciliation status is healthy or explained |  |  |
| Admin/backend | CORS remains strict except allowed app paths |  |  |
| Failure cases | Final sync failure returns app to idle |  |  |
| Failure cases | Decart token failure shows readable error |  |  |
| Failure cases | Missing identity blocks start with readable error |  |  |
| Failure cases | Network failure fails gracefully |  |  |
| Failure cases | Session cleanup runs after error |  |  |
| Release readiness | Repo is clean except intentional local work |  |  |
| Release readiness | No secrets committed |  |  |
| Release readiness | Screenshot assets are safe |  |  |
| Release readiness | Public repo readiness reviewed |  |  |
| Release readiness | Packaging has not started in this phase |  |  |
