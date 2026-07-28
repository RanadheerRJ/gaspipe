# PumpLog

PumpLog is a static PWA for fuel-station shift readings, rates, pumps, history, reports, and team access.

## Free / Spark-plan mode

This branch intentionally avoids anything that requires Firebase billing:

- No Firebase Cloud Functions
- No callable Functions API from the browser
- No payment, checkout, subscription, or billing integration
- No Blaze/pay-as-you-go requirement

The app uses only:

- Firebase Authentication for login
- Cloud Firestore for app data and profiles
- Firestore security rules for role-based access
- GitHub Pages/static hosting for the frontend

## Login model

Sign-in is deliberately simple for testing and development:

- Users sign in with **email + Cloud PIN**.
- The Cloud PIN is handled as the Firebase Authentication credential.
- User profile data in Firestore stays simple: email, role, station assignments, pump assignments, and optional display fields.
- A signed-in user can update their own Cloud PIN from **Profile → Cloud PIN**. That is the only credential update path in free mode.

> Note: Admin-side credential resets and invite/join codes require a trusted backend/Admin SDK, so they are disabled in this free mode. If someone forgets a Cloud PIN during testing, create a new account from Config → Team or reset the Firebase Auth password manually in the Firebase Console.

## First admin setup

1. Enable Firebase Authentication → Email/Password provider.
2. Create the first Firebase Auth user in the Firebase Console.
   - For a simple manual bootstrap, set the Auth password to the numeric PIN you want to use, preferably 6–8 digits.
   - The app also supports accounts created by PumpLog itself, which internally prefixes the PIN to satisfy Firebase Auth password rules.
3. Sign in at the app with that email + PIN.
4. The first signed-in Auth user with no profile automatically becomes `superadmin`.
5. Create stations and additional users from **Config → Team**.

## Deploying Firestore rules

`firebase.json` deploys Firestore rules only:

```bash
npx firebase-tools deploy --only firestore:rules
```

The GitHub Actions workflow at `.github/workflows/deploy-firebase.yml` also deploys only `firestore:rules`.

## Development notes

- This is a no-build static app: edit HTML/CSS/JS directly.
- Keep large generated files out of the repo.
- Firestore rules are the server-side source of truth for app data access.
