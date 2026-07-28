# PumpLog deployment

PumpLog is now configured for Firebase Spark/free-plan testing. It does **not** deploy Cloud Functions and does **not** require Firebase billing or pay-as-you-go.

## What ships

| Part | How it ships |
|---|---|
| Static frontend | GitHub Pages / static hosting |
| Firestore security rules | Firebase CLI or GitHub Action |
| Cloud Functions | Not used in free mode |

## One-time GitHub Action setup

The workflow deploys Firestore rules only. To enable it, add a repository secret named `FIREBASE_SERVICE_ACCOUNT` containing the Firebase service-account JSON for project `gass-13462`.

The workflow files are:

- `.github/workflows/deploy-firebase.yml`
- `ci/deploy-firebase.yml` (copy/reference version)

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
