# PumpLog deployment

PumpLog is now configured for Firebase Spark/free-plan testing. It does **not** deploy Cloud Functions and does **not** require Firebase billing or pay-as-you-go.

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
2. Assembles the static site (`index.html`, `manifest.json`, `sw.js`,
   `version.json`, `css/`, `js/`, `icons/`) into a Pages artifact.
3. Publishes it with `actions/deploy-pages`.

**One-time setup:** in the repo's **Settings → Pages → Build and
deployment → Source**, select **"GitHub Actions"** (instead of "Deploy from
a branch"). After that, every push to `main` redeploys automatically — no
secrets required for this workflow.

`version.json` is fetched client-side by a temporary dev-stage build tag on
the sign-in screen — see the `DEV-ONLY` block in `js/app.js` — so you can
confirm at a glance whether a browser has picked up the latest deploy or is
stuck on a stale service-worker cache.

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

1. Enable Firebase Authentication → Email/Password.
2. Create the first Auth user in Firebase Console.
3. Sign in with email + Cloud PIN.
4. PumpLog creates the first profile as `superadmin`.

## No billing required

Do not enable Blaze/pay-as-you-go just for this testing setup. There are no Cloud Functions in `firebase.json`, and the browser no longer imports or calls `firebase-functions`.
