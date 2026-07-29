# Changelog

## Unreleased — RBAC, shift ending, and daily pump board

### Staff shift ending

**Root cause:** `js/pumps.js` correctly kept an active pump visible to its owner and allowed that owner to tap **End shift**, but the `shifts/{shiftId}` create rule still called `canUsePump()`. At clock-out, that check re-read the standing `pumpIds` and the original day’s `assignments/{date}_{pumpId}` document. A valid owner was therefore denied if a manager had removed or changed that daily entry after clock-in, or if their non-empty standing pump list did not include a pump they had joined from the daily board. The same failure could appear after midnight because authorization was still tied to an editable assignment from the start date.

The rule now treats the existing active pump lock as clock-out authority: the signed-in owner may create the shift only while the same atomic transaction changes that exact active lock to idle. Starting a shift remains assignment-gated. The existing pump-session update rule still requires either the active owner or a station manager. The client now gives an actionable refresh message when a close is denied, and it rejects a stale active-user snapshot before writing.

The client payload and rules were compared field by field. The shift payload supplies all required identity/time/number fields, and the idle pump payload supplies exactly the fields accepted by `sessionFieldsOk()`. Staff history queries now use `staffUid` rather than `createdBy`, so a shift closed by a Manager is still visible to the Staff member who worked it (`js/store.js` and the matching read rule).

### Permission visibility audit

Files changed for permission-aware visibility:

- `js/auth.js` — added shared `ifCan()` and `applyPermission()` helpers and the station-security action.
- `js/app.js` — top-level Settings, Reports, and Who’s where tabs use `applyPermission()`.
- `js/config-page.js` — each Settings topic is independently gated; Stations is Super Admin-only; station reset has a separate station-manager topic; Team no longer shows disabled edit/delete controls; edit forms do not offer role changes Firestore will reject.
- `js/board.js` — the full board is visible to station Staff, while every edit control and write is gated by `assignment.manage`.
- `js/pumps.js` — unavailable shift actions are omitted; manager-only board and release actions use the shared helper and have visible text labels.
- `js/dashboard.js` — approval information and shift actions use action-level permissions.
- `js/history.js` — approval filters and approve/edit/delete controls use action-level permissions and visible text labels.
- `js/reports.js` — Staff no longer see a disabled employee picker; it is omitted unless `report.viewOthers` passes.
- `index.html` and `css/style.css` — navigation/action labels and responsive permission-aware controls.

Also audited with no RBAC changes required: `js/profile.js` (self-service controls only), `js/station-settings.js` (data/policy helper, no rendered controls), `js/staff-auth.js` (write helper, callers are gated), and `js/app-lock.js` (device-owner self-service only). `js/profile.js` received plain-language wording updates.

Firestore remains the security boundary; UI hiding only removes confusing dead ends.

### Daily pump board: before and after

- **Before:** a horizontally scrolling Kanban board with an “Available” column, draggable cards, drop zones, grip icons, and roster/session terminology.
- **After:** vertical pump cards on phones, each showing pump name, product, icon + text status, and large staff names. Managers tap **Add or remove staff**, then tap a name. Staff see the same cards without edit controls. Changes are atomic, confirm success in plain language, and include an **Undo** action. Empty, loading, live-update failure, and no-pump states provide a clear next step. Touch targets are at least 44px and the 360px layout does not depend on horizontal dragging or hover.
