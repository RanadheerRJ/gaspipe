# PumpLog — Go-live checklist (v1.3.0, roster board)

Status after PR #4 was merged on 2026-07-28:

| Item | State |
|---|---|
| Code merged to `dev/roles-manager-shift-approvals` (the Pages source branch) | ✅ Done — merge commit `42d36fb` |
| GitHub Pages build | ✅ Built, no errors |
| `dev/v0.2` branch created with the same code | ✅ Done — `74ceead` |
| **Firestore rules re-published** | ❌ **YOU MUST DO THIS — the app is broken without it** |
| Composite Firestore indexes | ✅ Not needed (all new queries are single-field) |

---

## Step 1 — Publish the Firestore rules (REQUIRED, ~1 minute)

The Roster board writes to a brand-new collection,
`stations/{stationId}/assignments/{date}_{pumpId}`. **No rules for that path are
live yet**, and Firestore denies anything not explicitly allowed. Until you run
this, every roster change fails with a permission error.

From the repo root:

```bash
npx firebase-tools login          # once, opens a browser
npx firebase-tools deploy --only firestore:rules --project gass-13462
```

Expected tail of the output:

```
✔  cloud.firestore: rules file firestore.rules compiled successfully
✔  firestore: released rules firestore.rules to cloud.firestore
✔  Deploy complete!
```

If you prefer the console: Firebase Console → Firestore Database → Rules →
paste the contents of `firestore.rules` → **Publish**.

### Verify it worked
Firebase Console → Firestore → Rules → the ruleset should mention `assignments`
and the helper `rosteredForRequest`. If it does not, the deploy did not land.

---

## Step 2 — Force the new build onto devices (~1 minute)

`sw.js` cache version was bumped to `v1.3.0`, so the service worker replaces
itself automatically. Installed PWAs may need one extra app close/reopen.

To confirm a device is current: the sign-in screen shows a small
`Build: <timestamp> · <sha>` tag under the logo. It should read `42d36fb`.

If a device is stuck on old code: hard-refresh (Ctrl/Cmd+Shift+R), or
DevTools → Application → Service Workers → **Unregister** → reload.

---

## Step 3 — Smoke-test with two real accounts (~5 minutes)

This is the part worth not skipping — the rules were never executed against the
emulator (it needs Java, unavailable in the build sandbox), so they are verified
by review and structural lint only. Two accounts, side by side:

**As a Manager or Station Admin**
1. **Config → Pumps → ➕ Add pump.** Confirm a manager (not just a super admin)
   can create one and it appears at the station.
2. Open the **Roster** tab. You should see one column per pump plus
   **Available**, with your station's staff sitting on the bench.
3. Drag a staff card onto a pump — or tap the card, then tap a column.
   A toast confirms the move.
4. **If you get a permission error here, Step 1 did not work.**

**As that staff member (second device / private window)**
5. Open **Pumps**. Only the rostered pump should be listed, with the hint
   "Rostered to 1 pump today".
6. Tap **Start shift**, enter an opening reading, submit.
   → This is the exact flow that was throwing *"not authorized to start shift"*.
7. Back on the manager's **Roster** tab, that card should now show
   🟢 **On shift** with a live elapsed-time counter — no refresh needed.
8. End the shift as the staff member. The card flips to ✅ **Shift ended**
   with volume and sales.

**Regression check (the original bug)**
9. Create a fresh staff account, assign it to the station, roster it to
   *nothing*. It should still see every pump and be able to start a shift —
   "no assignment" means unrestricted, not locked out.

---

## Optional — automate future deploys

There is no `.github/workflows/` directory in this repo; `ci/deploy-firebase.yml`
and `ci/deploy-pages.yml` are reference copies only, so **nothing auto-deploys
on push today**. To turn that on:

```bash
mkdir -p .github/workflows
cp ci/deploy-firebase.yml .github/workflows/
git add .github && git commit -m "ci: enable automatic Firestore rules deploys" && git push
```

Then add a `FIREBASE_SERVICE_ACCOUNT` repository secret (Settings → Secrets and
variables → Actions). The service account needs the IAM **Editor** role — see
`DEPLOYMENT.md` for the full walkthrough and error→fix table.

---

## Optional — point Pages at `dev/v0.2` instead

Pages currently serves `dev/roles-manager-shift-approvals`, which is why the
merge published immediately. `dev/v0.2` holds the identical code if you would
rather cut over:

Settings → Pages → Source → branch **`dev/v0.2`** → `/ (root)` → Save.

---

## If something goes wrong

**Roster changes fail with a permission error** — Step 1 was not completed, or
was published to a different Firebase project. Confirm the project is
`gass-13462` (see `.firebaserc`).

**A staff member still cannot start a shift** — check, in order:
1. Their profile has the station in `stationIds` (Config → Team).
2. Their `status` is `active`, not `disabled`.
3. The pump is not already locked by someone else (the card will say so).
4. A rate exists for that product (Config → Rates) — clock-in requires one.

**Rolling back** — the previous state is commit `431f25b`. Reverting the merge
restores it, but note that any assignment documents already written will simply
be ignored by the old code rather than causing errors.
