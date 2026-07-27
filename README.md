# PumpLog — Multi-Station Fuel Tracker PWA

A lightweight, installable PWA for tracking fuel station shift readings, rates, and sales across multiple stations. Built with plain HTML/CSS/JS + ES modules — no build step required.

## Features

- **4 pages**: Dashboard, Pumps (shift entry), Config (rates/pumps/stations/team), History
- **Role-based access control**: Super Admin, Station Admin, Staff — enforced in Firestore rules and mirrored in the UI
- **Full team management**: create, edit and remove users with station assignment
- **Fast**: ~155 KB of app assets, no webfonts, no framework, cached reads
- **Accessible**: keyboard navigation, focus trapping, screen-reader labels, 44px touch targets, dark mode
- **Offline-ready**: persistent Firestore cache + service worker app shell
- **Refresh anywhere**: floating refresh button plus one in the top bar

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

Rules are the source of truth. `js/auth.js` mirrors them in a `can()` helper that
only decides what the UI renders — bypassing the UI still hits the server rules.

| Capability | Super Admin | Station Admin | Staff |
|---|:--:|:--:|:--:|
| Stations — create / edit / delete | ✅ | ❌ | ❌ |
| Rates & pumps (assigned stations) | ✅ | ✅ | 👁 read |
| Shifts — log a reading | ✅ | ✅ | ✅ |
| Shifts — edit / delete | ✅ | ✅ | ❌ |
| Users — create | ✅ any role | ✅ staff only | ❌ |
| Users — edit / remove | ✅ | ✅ own staff only | ❌ |
| Config page | ✅ | ✅ | ❌ |

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
  ├── createdBy: string (uid)
  └── createdAt: timestamp
```

## Tech Stack

- **Plain HTML/CSS/JS** — no bundlers, no frameworks, no webfonts
- **Firebase Auth + Firestore** — free tier, no server needed
- **ES Modules** — loaded via `<script type="module">`
- **Service Worker** — app shell caching for offline install
- **PWA Manifest** — installable on mobile and desktop

## License

MIT
