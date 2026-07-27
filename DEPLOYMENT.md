# Going Live with PumpLog v1.0

PumpLog has three moving parts. This repo automates two of them end-to-end —
your only tasks are **one secret** and **one file** (about 3 minutes total).

| Part | What it is | How it ships |
|---|---|---|
| **Frontend** | Static PWA (HTML/CSS/JS) | GitHub Pages — automatic on push to the Pages branch |
| **Backend** | Firebase Cloud Functions | GitHub Actions — automatic on push (after Steps 1–2 below) |
| **Security rules** | `firestore.rules` | Deployed by the same GitHub Action — no console publish needed |

---

## Step 1 — One-time secret (≈1 minute)

Google requires a credential to deploy to *your* Firebase project — there is no
way around this, but you only fetch it once.

1. Open **Firebase Console → project `gass-13462` → ⚙️ Project settings →
   Service accounts**: https://console.firebase.google.com/project/gass-13462/settings/serviceaccounts/adminsdk
2. Click **Generate new private key** → **Generate key**. A `.json` file downloads.
3. Open **GitHub → your repo → Settings → Secrets and variables → Actions →
   New repository secret**.
4. Name: `FIREBASE_SERVICE_ACCOUNT` · Value: open the downloaded `.json` in a
   text editor and paste the **entire contents** → **Add secret**.

## Step 2 — Add the deploy workflow file (≈1 minute)

GitHub only lets *users with repo write access* create workflow files (a
security rule), so the finished workflow ships at **`ci/deploy-firebase.yml`**
for you to drop into place once:

1. Open `ci/deploy-firebase.yml` in this repo on GitHub → click **Raw** →
   select all → copy.
2. In the repo, click **Add file → Create new file**.
3. As the file name, type exactly: `.github/workflows/deploy-firebase.yml`
4. Paste the content → **Commit changes** directly to your publish branch.

> **Already installed an earlier copy?** Open `.github/workflows/deploy-firebase.yml`,
> click the **pencil (edit)** icon, replace everything with the current content
> of `ci/deploy-firebase.yml` (**v2** — validates your secret before deploying
> and gives precise error messages), and commit.

That push itself triggers the workflow. Go to **Actions → Deploy Firebase
backend** and watch it turn green (~2–4 minutes). It deploys **both** the
Cloud Functions and `firestore.rules` — you never need to paste rules into
the Firebase console.

> From now on, **every push** to `main`, `dev`, or any `arena/**` branch
> redeploys the backend automatically. Delete or edit `firestore.rules` /
> `functions/` on any of those branches and CI keeps Firebase in sync.

### Troubleshooting the deploy run

The **workflow v2** tells you exactly what to fix — check the error box under
**Actions → Deploy Firebase backend → (failed run) → Deploy job**:

| Error in the log | Fix |
|---|---|
| `Invalid FIREBASE_SERVICE_ACCOUNT – not valid JSON` | The secret was pasted incompletely. Re-download the key (Firebase Console → Service accounts → **Generate new private key**) and paste the **entire file** into the GitHub secret. |
| `Incomplete FIREBASE_SERVICE_ACCOUNT – missing field(s)` | Same as above — the paste was truncated. |
| `Wrong project` | The key belongs to a different Firebase project — generate it inside **gass-13462**. |
| `Failed to authenticate` (deploy step) | The key was revoked or is stale — delete the secret and create it again from a fresh key file. |
| `API … has not been used` / `not enabled` | Open the URL printed in the error, click **Enable** (one-time Google API activation), then **Re-run jobs**. |
| `Billing` / `quota` errors | Firebase Console → ⚙️ Usage and billing → set the project to the **Blaze** plan (functions already ran on it; free within quota). |

## Step 3 — Point GitHub Pages at the v1.0 branch

GitHub → repo → **Settings → Pages → Source: Deploy from a branch** → pick the
branch that has v1.0 (e.g. `main` after merging, or the release branch) →
folder **/(root)** → **Save**. The site updates at
**https://ranadheerrj.github.io/gaspipe/** within a minute or two.

Then **hard-refresh** the app once (Ctrl/Cmd + Shift + R) or reinstall the PWA
so the old service worker is replaced.

---

## Preferred order (zero confusion for users)

Step 1 → Step 2 → Step 3. If the frontend goes live first, nothing breaks:
until the backend deploy finishes, the login screen falls back to
**Administrator sign-in** (email + password); the full sign-in methods and
App Lock activate the moment the Actions run is green.

## Alternative: one-off deploy from your own computer

If you'd rather skip GitHub Actions entirely, any computer with Node.js can
deploy once (`.firebaserc` already pins project `gass-13462`):

```bash
npx firebase-tools login            # opens Google sign-in in your browser
npx firebase-tools deploy --only "functions,firestore:rules"
```

Rules-only, any time after edits:

```bash
npx firebase-tools deploy --only firestore:rules
```

## What NOT to do

- **Don't commit the service-account JSON** into the repo — it belongs in the
  GitHub secret store only. (The root `.gitignore` in this repo already blocks
  common credential file names.)
- **Don't disable the GitHub Action** — it exits silently when the secret is
  missing, so it is harmless while unfinished.
- **Don't put temporary passwords/PINs in chat or screenshots** — share the
  copied credentials privately with each user.
