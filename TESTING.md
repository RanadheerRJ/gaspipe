# Manual QA checklist

Use a station with at least two pumps, two Staff accounts, one Manager, one Station Admin, and one Super Admin. Test once at a narrow phone viewport (360px wide) and once on a larger screen. Where possible, enable network throttling and briefly go offline during a save.

## Shift-ending regression checks

- [ ] **Staff self-close, same day:** add Staff A to Pump 1 on today’s board, start a shift as Staff A, enter a higher closing reading, and end it. Confirm one shift row is saved and Pump 1 changes to **Idle**.
- [ ] **Staff self-close after midnight:** add Staff A to Pump 1, start before midnight, leave the pump active across midnight, then end it after midnight. Confirm the saved shift keeps the clock-in/day-board date and the pump becomes **Idle**.
- [ ] **Daily entry changed after start:** start Staff A on Pump 1, then as a Manager remove Staff A from Pump 1 or move them to Pump 2. Return as Staff A and end the original Pump 1 shift. Confirm it succeeds; the active pump lock, not the edited daily list, authorizes the close.
- [ ] **Standing list differs from daily board:** give Staff A a non-empty usual `pumpIds` list that does not contain Pump 1, add them to Pump 1 for today, start, and end. Confirm both writes succeed.
- [ ] **Manager closes for Staff:** start Pump 1 as Staff A. As Manager, tap **End Staff A’s shift**, complete the form, and confirm the shift is attributed to Staff A, is approved, and Pump 1 becomes **Idle**.
- [ ] **Wrong Staff is blocked:** while Staff A is active on Pump 1, sign in as Staff B. Confirm Staff B sees Pump 1 as active but sees no End shift button and cannot reach the close form from Dashboard or Pumps.
- [ ] **Stale state message:** open Staff A’s End shift form, release or close the pump from another manager device, then submit. Confirm the form says the shift is no longer showing as theirs and tells them to refresh; no raw Firebase error appears.

## Role × page/control matrix

Legend: **View** = page/data is visible, **Manage** = edit controls are visible, **Own** = only the signed-in person’s records/actions.

| Page / control | Super Admin | Station Admin | Manager | Staff |
|---|---|---|---|---|
| Dashboard and pump status | View all selected station | View assigned stations | View assigned stations | View assigned pumps; own names/data only |
| Start/end shift | Manage any pump | Manage assigned station | Manage assigned station | Start assigned pump; end own active shift only |
| Release without saving | Manage | Manage assigned station | Manage assigned station | Hidden |
| Who’s working where? | View + Manage | View + Manage assigned station | View + Manage assigned station | Full read-only pump cards |
| Add/remove staff button | Visible | Visible | Visible | Hidden (not disabled) |
| Shift history | View + correct/delete/approve | View + correct/delete/approve | View + correct/delete/approve | Own records; admin actions hidden |
| Reports | All staff picker | Assigned-station staff picker | Assigned-station staff picker | Own report; employee picker hidden |
| Settings tab | Visible | Visible | Visible | Hidden |
| Station Security / Rates / Pumps | Manage | Manage assigned station | Manage assigned station | Unreachable |
| Stations create/edit/delete topic | Manage | Hidden | Hidden | Unreachable |
| Station data reset topic | Manage selected station | Manage assigned station | Manage assigned station | Unreachable |
| Team create role choices | All roles | Manager or Staff | Staff only (no role picker) | Unreachable |
| Team edit/delete buttons | Only where `can()` passes | Only where `can()` passes | Only where `can()` passes | Unreachable |
| Profile / Cloud PIN / App Lock | Own | Own | Own | Own |

For every matrix row:

- [ ] No forbidden control is shown as a disabled button; it is absent.
- [ ] Directly navigating or calling an old handler still reaches a client `can()` guard.
- [ ] Firestore rejects a manually attempted forbidden write.
- [ ] A slow save shows a busy state, then a success toast or a specific error.
- [ ] Delete, reset, release-without-saving, and other destructive actions explain the result and require confirmation.

## One-handed phone board pass (360px)

- [ ] The page title, day controls, summary, and pump cards fit without horizontal page scrolling.
- [ ] Each pump card answers at a glance: pump name, product, **Active/Idle** icon + text, and names working there.
- [ ] Staff can read every pump card but cannot see Add/remove, clear, drag, or drop controls.
- [ ] As Manager, tap **Add or remove staff**, then tap an unselected name. Confirm “Added Name to Pump” appears with **Undo**.
- [ ] Tap **Undo** and confirm the prior pump list returns with a “Change undone” toast.
- [ ] Tap a selected name to remove them. Confirm “Removed Name from Pump” appears with **Undo**.
- [ ] Move a person who is already working on another pump. Confirm the warning explains that the current shift will not end.
- [ ] All staff rows and action buttons have comfortable 44px-or-larger tap targets; no action requires hover or dragging.
- [ ] No staff, no pumps, empty pump, loading, offline write, and paused-live-update states all show a plain-language next step.
