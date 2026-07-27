# PumpLog — Multi-Station Fuel Tracker PWA

A lightweight, installable PWA for tracking fuel station shift readings, rates, and sales across multiple stations. Built with plain HTML/CSS/JS + ES modules — no build step required.

## Features

- **5 pages**: Dashboard, Pumps (clock-in/out), Config (rates/pumps/stations/team), History, Reports
- **Live pump locks**: clocking in claims a pump session transactionally; the dashboard and Pumps page update Active/Idle state on every device within a second
- **Report Cards**: filter by station, employee, and date range, then export the visible breakdown as CSV or print it to PDF
- **Station data reset**: managers can delete shift history and session locks after typing the station name; configuration is preserved
- **Live pump feed**: the dashboard shows the current session state plus the last reading via Firestore listeners — a change on any device appears everywhere within a second
- **Role-based access control**: Super Admin, Station Admin, Staff — enforced in Firestore rules and mirrored in the UI
- **Per-pump staff assignment**: admins/managers assign one or more pumps to each staff account; staff see only their pumps and only their own readings
- **Rates owned by management**: only Super Admin / Station Admin can create, edit or delete rates; staff log readings against the configured rate (read-only)
- **Full team management**: create, edit and remove users with station assignment
- **Installable**: home-screen icon on Android and iOS, splash screen, offline app shell
- **Fast**: ~155 KB of app assets, no webfonts, no framework, cached reads
- **Accessible**: keyboard navigation, focus trapping, screen-reader labels, 44px touch targets, dark mode
- **Offline-ready**: persistent Firestore cache + service worker app shell
- **Refresh anywhere**: floating refresh button plus one in the top bar

### Home-screen icon

The app ships a proper icon set (`icons/`) built from the PumpLog brand logo —
the navy/red fuel drop with the worker crew inside: 192/512 px standard icons,
dedicated maskable icons for Android (logo stays inside the safe zone, so it is
never cropped by the launcher), and a 180 px `apple-touch-icon` for iOS. “Add to
Home Screen” therefore shows the PumpLog drop logo instead of a screenshot or
generic letter tile. `icons/logo-master.png` is the clean 1024-class master the
set is derived from, and the same logo appears on the sign-in screen.

## Firebase Setup

1. **Create a Firebase project** at https://console.firebase.google.com
2. **Enable Authentication** → Sign-in method → Email/Password
3. **Create a Firestore database** (start in test mode, then apply rules below)
4. **Register a web app** in Project Settings → General → Your apps → Add app → Web
5. **Copy the config object** (apiKey, authDomain, projectId, etc.)

### Configure PumpLog

Open `js/firebase.js` and replace the `FIREBASE_CONFIG` object with your Firebase project config:

```js
const FIREBASE_CONFIG = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'YOUR_PROJECT.firebaseapp.com',
  projectId: 'YOUR_PROJECT_ID',
  storageBucket: 'YOUR_PROJECT.appspot.com',
  messagingSenderId: 'YOUR_SENDER_ID',
  appId: 'YOUR_APP_ID',
};
```

### Firestore Security Rules

Copy `firestore.rules` into Firebase Console → Firestore Database → Rules → **Publish**.

> **Upgrading?** This release changes the rules for transactional pump locks,
> staff pump assignments, session deletes, station resets, and the new report
> fields. If you deployed an older version, **manually re-publish the latest
> `firestore.rules` in Firebase Console → Firestore Database → Rules** — pushing
> code to GitHub Pages does not update Firestore rules. Until you do, clock-in/out
> and station reset operations will fail closed. Repeat this re-publish step for
> every existing Firebase project using PumpLog.

Rules are the source of truth. `js/auth.js` mirrors them in a `can()` helper that
only decides what the UI renders — bypassing the UI still hits the server rules.

| Capability | Super Admin | Station Admin | Staff |
|---|:--:|:--:|:--:|
| Pump session live status — read | ✅ all | ✅ assigned stations | ✅ assigned stations |
| Start a pump session | ✅ | ✅ | ✅ assigned pumps |
| End own session | ✅ | ✅ | ✅ own active session |
| Force-release a session | ✅ | ✅ assigned stations | ❌ |
| Report Card | ✅ any of their stations | ✅ assigned stations | ✅ own records only |
| Reset station data (shifts + session locks) | ✅ | ✅ assigned stations | ❌ |

| Capability | Super Admin | Station Admin | Staff |
|---|:--:|:--:|:--:|
| Stations — create / edit / delete | ✅ | ❌ | ❌ |
| Rates & pumps (assigned stations) | ✅ | ✅ | 👁 read |
| Shifts — log a reading | ✅ | ✅ | ✅ assigned pumps, configured rate |
| Shifts — read | ✅ all | ✅ all | 👁 own records only |
| Shifts — edit / delete | ✅ | ✅ | ❌ |
| Assign pumps to staff | ✅ | ✅ own stations | ❌ |
| Users — create | ✅ any role | ✅ staff only | ❌ |
| Users — edit / remove | ✅ | ✅ own staff only | ❌ |
| Config page | ✅ | ✅ | ❌ |

### Pump assignment & per-person data

- In **Config → Team → Add/Edit**, admins tick the stations a staff member works
  at, and can then tick **one or more of that station's pumps**. A single user
  may hold pumps from several stations.
- Staff sign in to a scoped view: the Pumps page and the dashboard live feed
  show only their assigned pumps, and Dashboard/History totals include only
  readings they logged themselves. Managers keep the station-wide view.
- Privacy default: Station Admins and Super Admins see the active staff member's
  name in a lock; Staff see only **“In use — try again shortly”** for a colleague's
  active pump. This is a deliberate UI choice, not a security boundary.
- Leaving every pump unticked in the editor means **“all pumps at the assigned
  stations”** — this keeps older staff accounts (created before pump
  assignments existed) working unchanged until you restrict them.
- Admins and managers always see and manage every pump — assignments only ever
  apply to Staff accounts.
- Rates are fully owned by people with the Station Admin or Super Admin role.
  The rate field on the shift form is read-only for staff, and readings always
  save at the configured rate.

Guardrails enforced in both the UI and the rules:

- Nobody can edit or delete **their own** account from the Team list (no self-lockout).
- Super Admin accounts cannot be deleted through the app.
- A Station Admin cannot grant a role above their own, and cannot assign a
  station they do not hold themselves — blocking privilege escalation.
- Removing a user deletes their Firestore profile, which revokes access
  instantly. Their Firebase Auth credential must be deleted from the Firebase
  Console, since browsers cannot use the Admin SDK.

### Bootstrap Account

The **first user to sign up becomes Super Admin**, recorded at `app/bootstrap`.
Later self-signups become Staff with no station access until an admin assigns them.

## Deploy to GitHub Pages

1. **Push this repo** to GitHub
2. Go to **Settings → Pages**
3. Under "Branch", select `main` (or `master`) and `/ (root)`
4. Click **Save**
5. Your app will be live at `https://<username>.github.io/<repo>/` in a few minutes

No build step required — the repo is ready to serve as-is.

## Local Development

Just serve the directory with any static server:

```bash
# Python
python3 -m http.server 8080

# Node (npx)
npx serve .
```

Then open http://localhost:8080 in your browser.

## Performance & Accessibility

Changes that keep the app quick on a phone:

- **No webfont CDN.** Uses the system font stack, removing two extra
  connections and a render-blocking stylesheet.
- **Right-sized icons.** The PWA icons were 1024x1024 files (1.17 MB total)
  served as 192px and 512px; they are now correctly sized at ~21 KB.
- **Cached data layer** (`js/store.js`). Queries are cached for 60s and
  identical concurrent requests are coalesced, so switching tabs re-renders
  with no network round-trip.
- **Batched station reads.** Assigned stations load with one `in` query
  instead of one read per station.
- **Persistent Firestore cache** (IndexedDB), so repeat visits paint from disk.
- **Parallel loading.** Page sections use `Promise.all` rather than awaiting
  each query in turn.
- **In-memory filtering** on History, which is instant and needs no composite index.
- **Skeleton screens** instead of a blank page while data loads.

Accessibility:

- Semantic landmarks, a skip link, and `aria-live` regions for async updates
- Focus trapping in dialogs, Escape to close, focus restored to the trigger
- Non-blocking toasts and an accessible confirm dialog replace `alert()`/`confirm()`
- Visible focus rings, 44px minimum targets, and `prefers-reduced-motion`,
  `prefers-contrast` and dark-mode support
- All user-supplied values are HTML-escaped before rendering

## Data Model (Firestore)

```
users/{uid}
  ├── email: string
  ├── role: "superadmin" | "stationadmin" | "staff"
  ├── stationIds: string[]      // empty for Super Admin (implicit access to all)
  ├── pumpIds: string[]         // staff only — empty means "all pumps at assigned stations"
  ├── createdBy: string (uid | "system")
  ├── createdAt: timestamp
  ├── updatedAt: timestamp      // set when an admin edits the profile
  └── updatedBy: string (uid)

stations/{id}
  ├── name: string
  ├── address: string
  └── createdAt: timestamp

stations/{id}/pumps/{id}
  ├── name: string
  └── product: string

stations/{id}/rates/{id}
  ├── product: string
  ├── rate: number
  └── effectiveDate: string (YYYY-MM-DD)

stations/{id}/pumpSessions/{pumpId}
  ├── status: "idle" | "active"
  ├── activeUid: string | null
  ├── activeName: string | null
  ├── pumpName: string
  ├── product: string
  ├── clockInAt: timestamp | null
  ├── opening: number | null
  ├── date: string (YYYY-MM-DD) | null
  ├── shiftLabel: "1" | "2" | "3" | null
  ├── updatedAt: timestamp
  └── updatedBy: string (uid, force-release/audit context)

stations/{id}/shifts/{id}
  ├── pumpId: string
  ├── pumpName: string
  ├── product: string
  ├── date: string (YYYY-MM-DD)
  ├── shiftLabel: "1" | "2" | "3"
  ├── opening: number
  ├── closing: number
  ├── volume: number
  ├── rate: number
  ├── sales: number
  ├── clockInAt: timestamp       // missing on pre-migration records
  ├── clockOutAt: timestamp      // missing on pre-migration records
  ├── hoursWorked: number        // missing on pre-migration records
  ├── staffUid: string (uid)     // same person as createdBy
  ├── staffName: string          // display name/email at clock-out
  ├── createdBy: string (uid)
  └── createdAt: timestamp
```

A shift is created only by the atomic clock-out transaction that also releases
its pump session; direct client-created shift records are rejected by the rules.
Records written before clock-in/out do not have the new session fields. The app
shows `—` for unknown hours/session times and excludes unknown hours from totals;
it does not backfill historical documents. Firestore retains data indefinitely
until a manager explicitly uses **Config → Stations → Reset station data**, which
deletes only shifts and pump session locks in batches (not pumps, rates, or team assignments).

## Tech Stack

- **Plain HTML/CSS/JS** — no bundlers, no frameworks, no webfonts
- **Firebase Auth + Firestore** — free tier, no server needed
- **ES Modules** — loaded via `<script type="module">`
- **Service Worker** — app shell caching for offline install
- **PWA Manifest** — installable on mobile and desktop

## License

MIT
