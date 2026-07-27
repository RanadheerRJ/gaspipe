# PumpLog — Multi-Station Fuel Tracker PWA

A production-ready, installable PWA for tracking fuel station shift readings, rates, and sales across multiple stations. Built with plain HTML/CSS/JS + ES modules — no build step required — plus a trusted Firebase Cloud Functions identity service.

## Features

- **5 pages**: Dashboard, Pumps (clock-in/out), Config (security/rates/pumps/stations/team), History, Reports
- **Four sign-in methods, station-configurable**: Email + Cloud PIN, Username + Cloud PIN, Email + Password, Username + Password — each enabled or disabled per station from Config → Station Security
- **Station security policies**: per-station sign-in method toggles, App Lock requirements, and credential policies (password/PIN length, complexity, PIN rotation) applied immediately to the login screen, active sessions, and the identity service
- **Local App Lock**: an optional device-level PIN screen that locks on refresh, PWA reopen, and inactivity, with a security-question reset flow. Stored only on the device — never synced to Firebase
- **Cloud PIN**: scrypt-hashed server-side, verifiable in real time across all of a user's devices, changeable from the Profile page, with optional forced rotation
- **Production user management**: admins create accounts with temporary passwords and Cloud PINs; users replace them with their own on first login
- **Live pump locks**: clocking in claims a pump session transactionally; the dashboard and Pumps page update Active/Idle state on every device within a second
- **Report Cards**: filter by station, employee, and date range, then export the visible breakdown as CSV or print it to PDF
- **Station data reset**: managers can delete shift history and session locks after typing the station name; configuration is preserved
- **Live pump feed**: the dashboard shows the current session state plus the last reading via Firestore listeners — a change on any device appears everywhere within a second
- **Role-based access control**: Super Admin, Station Admin, Staff — enforced in Firestore rules and mirrored in the UI
- **Per-pump staff assignment**: admins/managers assign one or more pumps to each staff account; staff see only their pumps and only their own readings
- **Rates owned by management**: only Super Admin / Station Admin can create, edit or delete rates; staff log readings against the configured rate (read-only)
- **Audit trail**: sign-ins, sign-outs, failed PIN attempts, and every account change are recorded server-side
- **Installable**: home-screen icon on Android and iOS, splash screen, offline app shell
- **Fast**: ~160 KB of app assets, no webfonts, no framework, cached reads
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

## Authentication

PumpLog has three distinct credentials. Understand which is which:

| Credential | Where it lives | What it does |
|---|---|---|
| **Password** | Firebase Authentication | Signs in (with email or username), verified by Firebase Auth on the client |
| **Cloud PIN** (4–8 digits) | `staffSecrets/{uid}` — server only, scrypt-hashed | Sign-in alternative, verified by Cloud Functions; syncs across all devices in real time |
| **App Lock PIN** (4–8 digits) | This device's localStorage only — PBKDF2-hashed, **never synced** | Locks the screen on this device between uses |

### Sign-in methods

The login screen shows a station picker followed by method tabs. Each station's
managers choose which methods are available (Config → Station Security, saved to
`stations/{stationId}/settings/security`):

- **Email + Cloud PIN**
- **Username + Cloud PIN**
- **Email + Password**
- **Username + Password** — the username is mapped to the account email by the
  identity service; the password itself is verified by Firebase Authentication.

A disabled method is both **hidden from the station's login UI** and **rejected
by the Cloud Functions**, so the configuration cannot be bypassed from the
browser. At least one identifier (email/username) and one secret (password/PIN)
must stay enabled — the settings page blocks saving a combination that would
lock everyone out.

### Cloud PIN

- Verified only by Cloud Functions against a per-PIN salted **scrypt** hash.
  Hashes and salts live exclusively in `staffSecrets/{uid}`, which Firestore
  rules deny to every client.
- Five wrong attempts lock the PIN for 15 minutes; Firestore-backed rate
  limiting also throttles repeated attempts per identifier.
- Changing the PIN (Profile → Security → Cloud PIN) takes effect **immediately
  on every device**, because verification always happens server-side.
- Accounts are created with a **temporary Cloud PIN**; the owner must choose a
  personal PIN at next sign-in before the app opens.
- Stations can force **PIN rotation after N days** (0 = never). An overdue PIN
  triggers the same mandatory change screen at the next sign-in.

### Local App Lock

App Lock is a **device-level screen lock**, not account authentication. It is
enabled per station and protects a device that is left unlocked:

- **Lock immediately after a browser refresh** — the lock appears before any
  data is painted or cached content is shown.
- **Lock after the PWA is closed and reopened** — the same boot-time check
  applies to the installed app.
- **Lock after inactivity** — configurable timeout (1–120 minutes); returning
  to a backgrounded tab after the timeout also locks.
- First-time users are offered a guided setup: PIN → security questions.

The App Lock PIN and the security-question answers are PBKDF2-hashed (150k
iterations) and stored in the browser's localStorage **only** — they are never
sent to Firebase, never synced between devices, and disappear if site data is
cleared. Five wrong attempts trigger a 30-second cooldown.

**Forgot the App Lock PIN?** The lock screen offers a reset flow:
_Forgot App Lock PIN → answer your security questions → create a new App Lock
PIN_. Available questions include favorite color, favorite food, first school,
birth month, favorite movie, and childhood nickname. Answers can be rotated any
time from Profile → Security → Security questions.

### Password lifecycle

- New accounts are issued a **temporary password** by an admin. At first
  sign-in the app forces a password change (reauthenticated against Firebase
  Auth) before any data is shown.
- Passwords are also changeable voluntarily from Profile → Security → Password.
- Admins can issue a fresh temporary password from Config → Team → user →
  Credentials, without ever seeing the user's current password.

### New user onboarding

Managers create accounts from **Config → Team → ➕ Add User**:

- **Required**: first name, last name, username (4–16 chars, `a–z 0–9 _ .`),
  email, role, at least one station (except Super Admin), temporary password,
  temporary Cloud PIN.
- **Optional**: phone number, employee ID, avatar URL, pump restrictions
  (staff only), and the flags *must change password*, *must change Cloud PIN*,
  *account active*, *allow PWA sign-in*.
- The temporary credentials are shown exactly once with a copy button — share
  them privately.
- Editing supports the same fields plus deactivate/reactivate and permanent
  removal. Deactivation is reversible and keeps history for audit; removal
  deletes the profile, the secure identity, and the Firebase Auth credential.

Legacy username-only staff accounts (invited before v1.0) still work: the
"Join with code" flow and joining-code resets remain available on the login
screen, and 10-digit Station Admin invites are unchanged.

## Firebase Setup

1. **Create a Firebase project** at https://console.firebase.google.com
2. **Enable Authentication** → Sign-in method → Email/Password
3. **Create a Firestore database** (start in test mode, then apply rules below)
4. **Enable the Blaze plan** — Cloud Functions with outbound calls require pay-as-you-go (still free within quota)
5. **Register a web app** in Project Settings → General → Your apps → Add app → Web
6. **Copy the config object** (apiKey, authDomain, projectId, etc.)

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

### Trusted identity backend (Cloud Functions)

Username + Cloud PIN authentication and all privileged account operations are
implemented in `functions/` — Firebase Cloud Functions (Node 22, CommonJS).
The GitHub Pages app remains plain static HTML, CSS, and ES modules; Functions
are the trusted server boundary for operations a browser cannot safely perform.

The Functions service provides:

- **Sign-in**: `loginWithUsernamePin`, `loginWithEmailPin`,
  `resolveLoginIdentifier` (username → email mapping for password sign-in) —
  every call re-reads the station security settings and rejects disabled
  methods, disabled accounts, and PWA-blocked accounts.
- **Credential lifecycle**: `getMyPinStatus` (forced-change and rotation
  state), `changePin`, `finishPasswordSetup`, `recordLogin`, `recordLogout`.
- **Account administration**: `createUserAccount`, `updateUserAccount`,
  `adminSetPassword`, `adminSetPin`, `deleteUserAccount` (deactivate or
  permanent removal). Usernames are claimed transactionally; temporary
  Cloud PINs are scrypt-hashed before they ever touch storage.
- **Onboarding**: `listPublicStations` (login-screen station picker),
  `createStaff`, `previewJoiningCode`, `activateStaff`, `createAdminInvite`,
  `previewAdminInvite`, `activateAdminInvite`, `checkUsername`.
- **Protection**: per-identifier Firestore-backed rate limiting, five-strikes
  15-minute PIN lockout, least-privilege target checks (a Station Admin can
  only manage staff they created at their own stations), and audit events for
  sign-ins, sign-outs, failures, and every account change.

Deploy the trusted service automatically (recommended) or manually:

- **Automatic (recommended):** the repo ships a ready-to-install GitHub Actions
  workflow at `ci/deploy-firebase.yml`. Drop it into `.github/workflows/` once
  and add the one-time `FIREBASE_SERVICE_ACCOUNT` repository secret; afterwards
  every push deploys **Functions and `firestore.rules`** together — nothing to
  paste into the Firebase console. See **[DEPLOYMENT.md](DEPLOYMENT.md)** for
  the 3-step setup.
- **Manual:** from any machine with the Firebase CLI (`.firebaserc` already
  pins project `gass-13462`):

  ```bash
  npx firebase-tools deploy --only "functions,firestore:rules"
  ```

`firebase.json` points Functions at `functions/` and Firestore rules at
`firestore.rules`; there is no frontend build step. Deploying the static
GitHub Pages app alone does not deploy these backends.

> **⚠️ Mandatory for v1.0 — the backend must be deployed.** Login-method
> enforcement, temporary-credential forced changes, station security settings,
> and admin user management all depend on the current Functions **and** the
> current Firestore rules. Until they are live, the app degrades gracefully —
> it falls back to default security policies and administrator sign-in — but
> the new sign-in methods, App Lock policy, and Team management will not be
> fully enforced.

### Firestore Security Rules

The GitHub Action (above) deploys `firestore.rules` together with the
Functions on every push. If you prefer the console: copy `firestore.rules`
into Firebase Console → Firestore Database → Rules → **Publish**.

> **Upgrading?** This release adds the `stations/{id}/settings/security`
> subcollection, the server-owned `rateLimits` collection, and new user profile
> fields (`firstName`, `lastName`, `employeeId`, `avatarUrl`, `pwaLoginAllowed`,
> `password_reset_required`). If you deployed an older version, **re-deploy or
> re-publish the latest `firestore.rules`** — otherwise station security writes
> and admin edits will fail closed.

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
| Station security settings | ✅ | ✅ own stations | 👁 read |
| Rates & pumps (assigned stations) | ✅ | ✅ | 👁 read |
| Shifts — log a reading | ✅ | ✅ | ✅ assigned pumps, configured rate |
| Shifts — read | ✅ all | ✅ all | 👁 own records only |
| Shifts — edit / delete | ✅ | ✅ | ❌ |
| Assign pumps to staff | ✅ | ✅ own stations | ❌ |
| Users — create | ✅ any role | ✅ staff only | ❌ |
| Users — edit / deactivate / remove | ✅ | ✅ own staff only | ❌ |
| Issue temporary password / Cloud PIN | ✅ | ✅ own staff only | ❌ |
| Config page | ✅ | ✅ | ❌ |

**Role decision:** PumpLog intentionally keeps the existing three-role model. A
`stationadmin` is both the station pump-board administrator and the station
staff manager for their assigned station(s); there is no separate
`stationmanager` role or migration. Super Admin has the same controls across
all stations.

### Station security settings

Each station owns a `stations/{id}/settings/security` document (flag data only,
never secrets — readable before sign-in so the login screen can adapt; writes
are manager-only and re-enforced inside Cloud Functions):

| Setting | Default | Range | Effect |
|---|---|---|---|
| Enable Email Login | on | — | Email accepted as a sign-in identifier |
| Enable Username Login | on | — | Username accepted as a sign-in identifier |
| Enable Password Login | on | — | Email/username + Password method available |
| Enable Cloud PIN Login | on | — | Email/username + Cloud PIN method available |
| Enable App Lock | off | — | Devices must set a local App Lock PIN |
| Auto-lock on refresh | on | — | Lock immediately after a browser refresh |
| Auto-lock on PWA reopen | on | — | Lock when the installed app is closed and reopened |
| Auto-lock after inactivity | on | — | Lock when nobody interacts with the app |
| Auto-lock timeout | 3 | 1–120 min | Inactivity/backgrounded-tab threshold |
| Minimum password length | 8 | 6–64 | New + temporary passwords |
| Minimum Cloud PIN length | 4 | 4–8 | New + temporary Cloud PINs |
| Password complexity | letters + numbers | none / lettersNumbers / strong | New + temporary passwords |
| Cloud PIN complexity | standard | digits / standard | `standard` blocks repeats (1111) and sequences (1234) |
| Force Cloud PIN rotation after (days) | 0 | 0–365 | 0 = never; overdue PIN forces a change at next sign-in |

Changes apply **immediately**: the login screen re-renders live (Firestore
listener), armed sessions re-read the policy, and the identity service checks
the flags on every call. When a user belongs to several stations, method
toggles and App Lock merge permissively (any station allows/requires), while
credential policies use the **strictest** value across their stations.

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
- A manager may remove a pump assignment without ending an in-progress session.
  The active owner keeps that pump visible long enough to clock out; after it is
  idle, the pump remains unavailable until the manager assigns it again.
- Leaving every pump unticked in the editor means **“all pumps at the assigned
  stations”** — this keeps older staff accounts (created before pump
  assignments existed) working unchanged until you restrict them.
- Admins and managers always see and manage every pump — assignments only ever
  apply to Staff accounts.
- Rates are fully owned by people with the Station Admin or Super Admin role.
  The rate field on the shift form is read-only for staff, and readings always
  save at the configured rate.

Guardrails enforced in both the UI, the rules, and the Cloud Functions:

- Nobody can edit or delete **their own** account from the Team list (no self-lockout).
- Super Admin accounts cannot be deactivated or deleted through the app.
- A Station Admin cannot grant a role above their own, and cannot assign a
  station they do not hold themselves — blocking privilege escalation.
- Permanent removal deletes the Firestore profile, the secure identity record,
  the username reservation, **and** the Firebase Auth credential (server-side) —
  access is revoked instantly.

### First-Time Setup

The **first Firebase Auth account to sign in with no matching profile becomes
Super Admin**, recorded once at `app/bootstrap`. On a fresh deployment:

1. Publish the rules and deploy Functions (above).
2. Create the first user in Firebase Console → Authentication → Add user.
3. Sign in with that email + password on the login screen (“Administrator
   sign-in” station option). The app claims Super Admin automatically.
4. Create your first station in Config → Stations, then issue 10-digit
   Station Admin invites or create users directly in Config → Team.

## Deploy to GitHub Pages

1. **Push this repo** to GitHub
2. Go to **Settings → Pages**
3. Under "Branch", select `main` (or `master`) and `/ (root)`
4. Click **Save**
5. Your app will be live at `https://<username>.github.io/<repo>/` in a few minutes

No build step required — the repo is ready to serve as-is. Remember that GitHub
Pages only hosts the static client; the Cloud Functions and Firestore rules
must be deployed separately (see above). **[DEPLOYMENT.md](DEPLOYMENT.md)**
walks through the full go-live checklist in 3 steps.

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
  with no network round-trip. Station security uses a 30s cache plus a live
  listener on screens that need instant updates.
- **Batched station reads.** Assigned stations load with one `in` query
  instead of one read per station.
- **Persistent Firestore cache** (IndexedDB), so repeat visits paint from disk.
- **Parallel loading.** Page sections use `Promise.all` rather than awaiting
  each query in turn.
- **In-memory filtering** on History, which is instant and needs no composite index.
- **Skeleton screens** instead of a blank page while data loads.
- **Module preloading** for the ES module graph in `index.html`.

Accessibility:

- Semantic landmarks, a skip link, and `aria-live` regions for async updates
- Focus trapping in dialogs, Escape to close, focus restored to the trigger
  (mandatory-action dialogs like forced password/PIN changes stay open until completed)
- Non-blocking toasts and an accessible confirm dialog replace `alert()`/`confirm()`
- Visible focus rings, 44px minimum targets, and `prefers-reduced-motion`,
  `prefers-contrast` and dark-mode support
- All user-supplied values are HTML-escaped before rendering

## Data Model (Firestore)

```
users/{uid}
  ├── email: string              // absent on pre-v1.0 username-only accounts
  ├── firstName: string
  ├── lastName: string
  ├── fullName: string           // canonical display name
  ├── username: string           // lowercase unique 4–16 character login name
  ├── phoneNumber: string        // optional
  ├── employeeId: string         // optional
  ├── avatarUrl: string          // optional
  ├── role: "superadmin" | "stationadmin" | "staff"
  ├── stationIds: string[]       // empty for Super Admin (implicit access to all)
  ├── pumpIds: string[]          // staff only — empty means "all pumps at assigned stations"
  ├── status: "invited" | "active" | "disabled"
  ├── pin_reset_required: boolean       // forced Cloud PIN change at next sign-in
  ├── password_reset_required: boolean  // forced password change at next sign-in
  ├── pwaLoginAllowed: boolean
  ├── isAdmin: boolean
  ├── createdBy: string (uid | "system")
  ├── createdByAdmin: string (uid)
  ├── lastLogin: timestamp
  ├── createdAt: timestamp
  ├── updatedAt: timestamp
  └── updatedBy: string (uid)

usernames/{lowercaseUsername}
  └── uid: string                // reservation; client access denied

joiningCodes/{fiveDigitCode}
  ├── uid: string
  ├── purpose: "activation" | "pin-reset"
  └── expiresAt: timestamp       // client access denied

adminInvites/{tenDigitCode}
  ├── purpose: "station-admin"
  └── expiresAt: timestamp       // client access denied

staffSecrets/{uid}               // client access denied — never readable
  ├── pinHash: string            // scrypt output
  ├── pinSalt: string
  ├── pinAlgorithm: string       // "scrypt-N16384-r8-p1"
  ├── pinLastChangedAt: timestamp  // drives station PIN-rotation policy
  ├── joiningCode: string
  ├── joiningCodeExpiresAt: timestamp
  ├── failedAttempts: number
  └── lockedUntil: timestamp | null

auditLogs/{id}                   // readable by Super Admin only
  ├── actorUid: string | null
  ├── targetUid: string | null
  ├── action: string             // auth.login, auth.login_failed, auth.logout,
  │                              // user.created, user.updated, user.deactivated,
  │                              // user.removed, user.pin_changed, user.pin_reset,
  │                              // user.password_changed, user.password_reset, …
  ├── metadata: map
  └── createdAt: timestamp

rateLimits/{bucket_key}          // client access denied — server-side throttling
  ├── attempts: number
  └── windowStart: timestamp

stations/{id}
  ├── name: string
  ├── address: string
  └── createdAt: timestamp

stations/{id}/settings/security  // flags/policies only — public read, manager write
  ├── enableEmailLogin: boolean
  ├── enableUsernameLogin: boolean
  ├── enablePasswordLogin: boolean
  ├── enablePinLogin: boolean
  ├── appLockEnabled: boolean
  ├── appLockOnRefresh: boolean
  ├── appLockOnPwaReopen: boolean
  ├── appLockOnInactivity: boolean
  ├── appLockTimeoutMinutes: number (1–120)
  ├── minPasswordLength: number (6–64)
  ├── minPinLength: number (4–8)
  ├── passwordComplexity: "none" | "lettersNumbers" | "strong"
  ├── pinComplexity: "digits" | "standard"
  ├── pinRotationDays: number (0–365)
  ├── settingsVersion: number
  ├── updatedAt: timestamp
  └── updatedBy: string (uid)

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
  ├── staffId: string (uid)      // canonical identity for new records
  ├── staffUid: string (uid)     // backwards-compatible alias
  ├── staffName: string          // legacy denormalized fallback; reads prefer users.fullName
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

**Never stored anywhere:** plaintext Cloud PINs. **Never stored in Firebase:**
App Lock PINs and security-question answers (device-localStorage only).

## Tech Stack

- **Plain HTML/CSS/JS** — no bundlers, no frameworks, no webfonts
- **Firebase Auth + Firestore** — authentication, data, and security rules
- **Firebase Cloud Functions (Node 22)** — trusted identity and admin operations
- **ES Modules** — loaded via `<script type="module">`
- **Service Worker** — app shell caching for offline install
- **PWA Manifest** — installable on mobile and desktop

## License

MIT
