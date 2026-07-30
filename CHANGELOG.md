# Changelog

## v1.7.0 — Fuel stock tracking, Team search, Dashboard polish

- **Fuel stock (Phase 5, MVP).** New `js/stock.js` module tracks per-product tank levels. `stations/{id}/stock/current` holds `levels: { [product]: litres }`; `stations/{id}/stockLog/{logId}` records each delivery, dip reading, adjustment, or test measure with signed volume delta, before/after levels, note, and staff name.
- **Config → Fuel stock** section (manager-only): current level per product with low/empty colour coding, last-updated timestamp, and a "Manage stock" button opening a modal that lets managers pick a product, choose entry type (Delivery / Dip / Adjustment / Test), enter litres and a note, and see the 8 most recent entries.
- **Dashboard stock card** (`stockCardHTML`): same product/level grid visible to every signed-in station member, plus a "Manage stock" button for managers. Wired through `pumplog:dataChanged` so it refreshes after a stock entry is saved.
- **Team search** now matches phone numbers and employee IDs (was limited to name/email/username). Placeholder updated.
- **User-created success dialog** now shows phone instead of email for phone-only accounts, and the Copy button formats the sign-in line correctly for phone logins.
- CSS additions under `.stock-card`, `.stock-row`, `.stock-level` (`.stock-warn` / `.stock-empty` / `.stock-ok` colour states), `.stock-form-grid`, and `.stock-log` for the stock modal.
- `firestore.rules` adds read (any signed-in station member) and write (station manager) rules for `stock/current` and append-only `stockLog/{logId}` documents with field-level validation. **Requires re-publishing `firestore.rules`.**
- Version bumped to `1.7.0` across `index.html`, `js/profile.js`, `version.json`, and the release tracker.

## v1.6.0 — PIN reset flows, phone-login hardening, disabled-user filter

- **PIN reset (manager-initiated).** Config → Team "Reset PIN" now uses Firebase Auth's built-in password-reset email for email accounts: click sends a one-time reset link to the staff member's real email; they land on the new `set-pin.html` page and pick their own 4–8 digit Cloud PIN directly. No temporary PIN is stored in Firestore and no Cloud Functions are required.
- **Self-service PIN reset from the sign-in screen.** New "Forgot Cloud PIN?" link under the sign-in form (shown only when Email + Cloud PIN is enabled) asks for an email and sends the same reset link. Phone-only accounts cannot receive email; the UI and DEPLOYMENT.md explain this.
- **Custom PIN-reset landing page** (`set-pin.html`) — verifies the `oobCode`, enforces the 4–8 digit PIN rule, applies the `pumplog-pin:` prefix so Firebase Auth's 6-char minimum is satisfied, and signs the user in through the normal flow afterward. Added minimal CSS hooks under `.reset-body` / `.reset-container`.
- **Phone + Cloud PIN sign-in reworked to be pre-auth-query-free.** `signInWithPhonePin` now signs in directly against the synthetic `phone:<digits>@pumplog.local` Auth email (created at account-creation time). This removes the pre-auth Firestore `where('phoneNumber', '==')` lookup, which signed-out readers could not satisfy under `firestore.rules` and which also leaked the phone→uid mapping. Phone login is therefore restricted to accounts created via the phone-only flow (Firebase Auth identity = synthetic email); `phoneNumber` on an email-based account remains contact info only.
- **Removed `pin_temporary` field and all related sign-in fallback code.** The previous design stored a plain-text one-time PIN in Firestore and had the sign-in flow accept it as a third password candidate, which could never work because the client SDK cannot rotate another user's Firebase Auth password without Cloud Functions. `firestore.rules` was tightened to drop the field, and the self-update helper no longer lists it.
- **Add/Edit Team form guidance** updated: email is marked "recommended" (needed for self-serve PIN reset); phone-only accounts carry an explicit warning that PIN resets require admin help; editing hints note that changing the sign-in identifier requires deactivating + recreating the account (a Spark-plan limitation).
- **Team Board / picker now filters out disabled and invited profiles.** `getUsersAtStation()` in `js/store.js` now returns only `status: 'active'` users so deactivated staff no longer appear in staff pickers, roster counts, or "covered" tallies. The summary count gracefully degrades for staff who cannot list station users (it falls back to the UIDs visible from assignments and active sessions) so "of 0 staff" never reappears.
- Profile → Security "Cloud PIN" copy updated to mention phone as well as email; version bumped to `1.6.0` across `index.html`, `js/profile.js`, and the version metadata.
- `DEPLOYMENT.md` rewritten to document the new PIN reset flow, the phone sign-in identity model (no pre-auth Firestore lookup), and the one-time Firebase Auth "Authorized domains" configuration required for reset emails to land.
- **Bold re-publish requirement:** `firestore.rules` removed `pin_temporary`; republish rules on deploy.

## v1.5.0 — Phone + Cloud PIN sign-in (released in v1.6.0 train)

- New per-station toggle **"Phone + Cloud PIN"** alongside Email + Cloud PIN in Settings → Station Security. Uses the same synthetic-password PIN trick as email login (no SMS OTP, no Cloud Functions, no Blaze plan). Phone numbers validated as an optional `+` followed by 7–15 digits (E.164-ish).
- Sign-in screen shows method tabs when more than one method is enabled, with separate Email/Phone fields.
- Add/Edit Team forms accept email, phone, or both (at least one required); phone is normalized to E.164-ish digits.
- User list + Profile show phone number alongside email.
- `firestore.rules` validates `phoneNumber` format and adds `user.pin.reset` permission scope.
- DEPLOYMENT.md documents that no composite Firestore indexes are needed.

## v1.4.0 — Team Board & Dashboard redesign, UI cleanup

- Removed the floating `#fab-refresh` button and every related `.fab*` CSS rule (including the print-hide selector). Refresh is reachable only from the top bar `#btn-refresh`.
- Renamed the "Who's where" tab to **Team Board** consistently across `index.html`, `js/board.js` (page title, hints, empty states), `js/config-page.js`, `js/pumps.js`, and `README.md`.
- **Team Board redesign** (`js/board.js` + `css/style.css`): replaced nested card-in-a-card layout with a flat list, one row per pump, showing columns `Status dot · Pump | Assigned staff | Status | Elapsed time | Today's volume/sales`. No nested bordered cards — assignee name and status dot live inline in the row. Today's totals are computed from live shift data. Date navigation and tap-to-assign stay intact.
- **Dashboard stats strip** (`js/dashboard.js` + `css/style.css`): collapsed the four separate `MY TODAY` / `STATION` bordered stat cards into a single flat `info-stats-strip`. The Rates section is unchanged.
- Summary counters ("X of Y pumps covered · X of Y staff rostered · N active now") now count only staff actually attached to the station, fixing the "1 of 0 staff rostered" display bug.
- Added a live `watchShifts` subscription on the board so today's volume/sales totals update without a manual refresh.
- `index.html` `application-version` bumped to `1.4.0`.

## v1.3.0 — RBAC, shift ending, and daily pump board

### Staff shift ending

**Root cause:** `js/pumps.js` correctly kept an active pump visible to its owner and allowed that owner to tap **End shift**, but the `shifts/{shiftId}` create rule still called `canUsePump()`. At clock-out, that check re-read the standing `pumpIds` and the original day's `assignments/{date}_{pumpId}` document. A valid owner was therefore denied if a manager had removed or changed that daily entry after clock-in, or if their non-empty standing pump list did not include a pump they had joined from the daily board.

The rule now treats the existing active pump lock as clock-out authority: the signed-in owner may create the shift only while the same atomic transaction changes that exact active lock to idle. Starting a shift remains assignment-gated. Staff history queries now use `staffUid` rather than `createdBy`, so a shift closed by a Manager is still visible to the Staff member who worked it.

### Permission visibility audit

Every page now uses shared `ifCan()` / `applyPermission()` helpers so controls that Firestore would reject aren't shown as dead ends. Firestore remains the security boundary.

### Daily pump board

- **Before:** a horizontally scrolling Kanban board with an "Available" column, draggable cards, drop zones, and grip icons.
- **After:** vertical pump cards on phones, each showing pump name, product, icon + text status, and large staff names. Managers tap **Add or remove staff**, then tap a name. Staff see the same cards without edit controls. Changes are atomic with an **Undo** action. Touch targets are at least 44px.
