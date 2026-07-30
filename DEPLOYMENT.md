# PumpLog deployment

PumpLog is configured for Firebase Spark/free-plan testing. It does **not** deploy Cloud Functions and does **not** require Firebase billing or pay-as-you-go.

## What ships

| Part | How it ships |
|---|---|
| Static frontend | GitHub Pages, via `.github/workflows/deploy-pages.yml` |
| Firestore security rules | Firebase CLI or GitHub Action |
| Cloud Functions | Not used in free mode |

## Static site deploy (GitHub Pages)

`ci/deploy-pages.yml` is the reference copy of the GitHub Actions workflow
that should live at `.github/workflows/deploy-pages.yml`. It's kept under
`ci/` because automated pushes to this repo aren't allowed to create/modify
files under `.github/workflows/` (GitHub blocks that without an explicit
`workflows` token permission) — copy it into place by hand once:

```bash
mkdir -p .github/workflows
cp ci/deploy-pages.yml .github/workflows/deploy-pages.yml
git add .github/workflows/deploy-pages.yml
git commit -m "Add GitHub Pages deploy workflow"
git push
```

Once installed, it runs on every push to `main`:

1. Generates a fresh `version.json` (UTC deploy timestamp + short commit SHA,
   never hand-written or committed).
2. Assembles the static site (`index.html`, `set-pin.html`, `manifest.json`,
   `sw.js`, `version.json`, `css/`, `js/`, `icons/`) into a Pages artifact.
3. Publishes it with `actions/deploy-pages`.

**One-time setup:** in the repo's **Settings → Pages → Build and
deployment → Source**, select **"GitHub Actions"** (instead of "Deploy from
a branch"). After that, every push to `main` redeploys automatically — no
secrets required for this workflow.

`version.json` is fetched client-side by a temporary dev-stage build tag on
the sign-in screen — see the `DEV-ONLY` block in `js/app.js` — so you can
confirm at a glance whether a browser has picked up the latest deploy or is
stuck on a stale service-worker cache.

## Firebase Auth setup (one-time)

1. In Firebase Console → Authentication → Sign-in method, enable **Email/Password**.
2. Do **not** enable "Phone" sign-in — PumpLog implements its own phone+PIN
   flow using the synthetic `phone:<digits>@pumplog.local` Auth email.
3. In Authentication → Settings → **Authorized domains**, add every domain
   your site is served from (the default `*.firebaseapp.com` /
   `*.web.app` work out of the box; add your GitHub Pages custom domain if
   you use one). Password-reset emails will not reach users on a domain
   that isn't on this list.

## Firestore rules deploy

`ci/deploy-firebase.yml` deploys Firestore rules only — it does **not**
touch the static site. To enable it, add a repository secret named
`FIREBASE_SERVICE_ACCOUNT` containing the Firebase service-account JSON for
project `gass-13462`.

On push, the workflow runs:

```bash
npx --yes firebase-tools@15 deploy --only "firestore:rules" --non-interactive
```

## Manual rules deploy

From your computer:

```bash
npx firebase-tools login
npx firebase-tools deploy --only firestore:rules
```

## First admin

1. Enable Firebase Authentication → Email/Password (see above).
2. Visit the deployed site. The first sign-up creates the Super Admin
   account in `app/bootstrap`.
3. Sign in with an email + Cloud PIN.

## Cloud PIN reset flow

- Signed-in users change their own Cloud PIN from **Profile → Security →
  Cloud PIN**. The new PIN applies immediately and signs out every other
  device that was using the old one.
- Managers reset a staff member's PIN from **Settings → Team → Reset PIN**.
  For email-based accounts this uses Firebase Auth's built-in password-
  reset email: an out-of-band link arrives in the staff member's inbox,
  which lands on `set-pin.html` and lets them pick a brand-new 4–8 digit
  PIN directly. No temporary PIN is ever stored in Firestore.
- **Phone-only accounts** (no email on file) cannot receive a reset link
  because the synthetic `phone:<digits>@pumplog.local` Auth email is not a
  real mailbox. To reset such an account, deactivate it and create a new
  one with an email address — or create the replacement account with an
  email from the start.

## Sign-in identity model (Spark plan)

PumpLog runs on Firebase Auth only (no Admin SDK, no Cloud Functions):

- **Email accounts** — Firebase Auth email is the user's real email; sign
  in with email + Cloud PIN. Password-reset email works.
- **Phone-only accounts** — created with just a phone number. Firebase
  Auth signs them in against the synthetic
  `phone:<digits>@pumplog.local` email, so phone sign-in goes straight to
  `signInWithEmailAndPassword` against that synthetic address. There is
  **no pre-auth Firestore lookup** (signed-out readers cannot query the
  users collection), and phone-only accounts must be created from the
  Team page rather than self-registered.
- Login methods cannot be swapped on an existing account (the client SDK
  cannot rotate another user's Auth email). To move a person from
  email-only to phone or vice versa, deactivate the old account and
  create a new one with the desired identifier and a fresh PIN. Existing
  shift history stays with the old UID.
- The `phoneNumber` field on a Firestore profile is **contact info only**
  for email accounts — it does not grant an extra sign-in method.

## Firestore indexes

All PumpLog queries use single-field equality/orderBy filters that run on
Firestore's built-in indexes — **no composite indexes are required** for
the current schema. In particular:

- Assignments: `where('date', '==', date)` — single-field equality.
- Shifts (managers): `orderBy('date', 'desc')` — single-field order.
- Shifts (staff): `where('staffUid', '==', uid)` — single-field equality.
- Users at a station: `where('stationIds', 'array-contains', id)` — built-in
  array-contains index.

If the Firebase Console ever surfaces a "missing index" link after a rules
or schema change, create it from that link and re-run the query.

## No billing required

Do not enable Blaze/pay-as-you-go just for this testing setup. There are
no Cloud Functions in `firebase.json`, and the browser does not import or
call `firebase-functions`. Phone + PIN sign-in does **not** use Firebase
Phone Auth (which requires billing / reCAPTCHA).
