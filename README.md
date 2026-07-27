# PumpLog — Multi-Station Fuel Tracker PWA

A lightweight, installable PWA for tracking fuel station shift readings, rates, and sales across multiple stations. Built with plain HTML/CSS/JS + ES modules — no build step required.

## Features

- **4 pages**: Dashboard, Pumps (shift entry), Config (rates/stations/team), History
- **Role-based access**: Super Admin, Station Admin, Staff
- **Multi-station**: Switch between stations from the top bar
- **Offline-ready**: Service worker caches the app shell for PWA install
- **Mobile-first**: Clean, rounded UI designed for phone use

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

Copy the contents of `firestore.rules` into your Firebase Console → Firestore → Rules.

The rules enforce:

| Role | Stations | Pumps | Rates | Shifts | Users |
|------|----------|-------|-------|--------|-------|
| Super Admin | CRUD | CRUD | CRUD | CRUD | CRUD |
| Station Admin | Read | CRUD | CRUD | CRU* | — |
| Staff | Read | Read | Read | Create** | — |

\* Station Admin cannot delete shifts in these rules — adjust `firestore.rules` if desired.
\*\* Staff can create shift records but cannot edit or delete them.

### Bootstrap Account

The **first user** to sign up automatically becomes **Super Admin**. PumpLog records this in Firestore at `app/bootstrap`. Subsequent signups default to **Staff** until a Super Admin promotes them via the Config → Team page.

If a signup creates a Firebase Auth account but gets stuck on the login screen, publish the included `firestore.rules` in Firebase Console → Firestore Database → Rules, then use **Sign In** with the same email/password.

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

## Data Model (Firestore)

```
users/{uid}
  ├── email: string
  ├── role: "superadmin" | "stationadmin" | "staff"
  ├── stationIds: string[]
  ├── createdBy: string (uid)
  └── createdAt: timestamp

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

- **Plain HTML/CSS/JS** — no bundlers, no frameworks
- **Firebase Auth + Firestore** — free tier, no server needed
- **ES Modules** — loaded via `<script type="module">`
- **Service Worker** — app shell caching for offline install
- **PWA Manifest** — installable on mobile and desktop

## License

MIT
