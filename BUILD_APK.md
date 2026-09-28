# Stock GMAO — Android app (build the real .apk)

This is a complete, ready-to-build Android Studio project (Capacitor wrapping
the mobile web app in a native WebView). I could not compile the `.apk`
itself in the sandbox I run in — no Android SDK, and no network access to
Google's SDK/Gradle servers — so this is the buildable source, one step short
of the file, and that last step needs a real Android toolchain.

## Fastest path: Android Studio (free, ~15 minutes, no command line needed)

1. Install [Android Studio](https://developer.android.com/studio) (Windows/Mac/Linux).
2. Open Android Studio → **Open** → select the `android/` folder in this project.
3. Let it sync (first run downloads the Android SDK + Gradle automatically —
   this is the step that needs internet access my sandbox doesn't have).
4. Plug in an Android phone (USB debugging on) or use an emulator, then
   **Run ▶** to install and launch it directly — or:
5. **Build → Build Bundle(s) / APK(s) → Build APK(s)** to get a real,
   installable `app-debug.apk` under `android/app/build/outputs/apk/debug/`.
   Copy that file to any Android phone and open it to install (enable
   "install unknown apps" for whichever app you transfer it with).

## Command line instead, if you have the Android SDK already

```bash
cd android
./gradlew assembleDebug
# output: android/app/build/outputs/apk/debug/app-debug.apk
```

## Roles and validation workflow

- **Administrateur** - full access, plus the only one who can manage users (create, change role, deactivate, reset password - never *views* an existing password, since a properly hashed one can't be viewed by anyone, including the backend itself)
- **Responsable Méthode / Responsable Magasin / Magasinier** - "manager" tier: BSM/BRM they create are auto-approved, they can validate everyone else's pending BSM/BRM, and they're the only ones who see Réception, ✅ Valider, and 🕓 Historique
- **Everyone else** - can create BSM/BRM, but each one sits pending until a manager validates it in the ✅ Valider tab; no access to Réception, Valider, or Historique

All of this is enforced **on the backend** (`backend/src/roles.js` and the `requireRole(...)` checks in each route) - the app hiding a tab is just UX convenience, not the actual security boundary.

**Getting your first Administrateur**: there's no way to create one through the app itself (the admin endpoints require an admin to already exist, by design - otherwise anyone could grant themselves admin). Set one directly in SSMS:
```sql
USE GMAO_NGES;
UPDATE utilisateur SET fonction = 'Administrateur' WHERE login = 'amine'; -- or whichever login should be the first admin
```
From then on, that person can create/manage every other user from the app's Utilisateurs tab.

**Before any of this works**: run `backend/migrations.sql` once in SSMS - it adds two new tables (`app_device_token`, `app_notification_log`) and a `validation` column on `brm` (which didn't exist before; `bsm` already had one). Nothing in the desktop app is touched or affected by this.

## Setting up push notifications (optional, but needed for validation alerts)

The app works fully without this - BSM/BRM creation, validation, history, and
user management all work regardless. Without it, managers just won't get a
phone notification when something needs validating (they'll still see it in
the ✅ Valider tab whenever they open the app - this only affects the "phone
buzzes even when the app is closed" part).

**1. Create a Firebase project** (free): go to
[console.firebase.google.com](https://console.firebase.google.com) → Add
project → give it any name (e.g. "Stock GMAO") → you can skip Google
Analytics, it isn't needed here.

**2. Register the Android app in it**: in your new project → Project
settings (gear icon) → Add app → Android → Android package name must be
exactly `com.gmao.stockapp` (matches `capacitor.config.json`) → Register app.

**3. Download `google-services.json`** from that same screen → place it at
`android/app/google-services.json` (exactly that path/filename - the Gradle
config already added by Capacitor looks for it there).

**4. Get a service account key for the backend**: Project settings → Service
accounts tab → "Generate new private key" → downloads a JSON file. Rename it
(e.g. `firebase-service-account.json`) and place it in the `backend/` folder.
Set `FIREBASE_SERVICE_ACCOUNT_PATH=./firebase-service-account.json` in
`backend/.env` (already the default in `.env.example`).

**This file is as sensitive as a password** - it grants full access to your
Firebase project. Never commit it, never send it outside your team.

**5. Rebuild**: `npx cap sync android` → `gradlew assembleDebug`, and restart
the backend (`npm install` first, to pull in `firebase-admin`). That's it -
managers now get a real push when a BSM/BRM needs validating, and everyone
gets one when something they created gets validated.

## Before you build: point it at your backend

There's no hardcoded server address — set it once, in the app itself, on
first launch: open the app → **⚙ Adresse du serveur** on the login screen →
enter `http://YOUR-SERVER-IP:4000/api` → Enregistrer. It's saved on-device
from then on.

(Cleartext `http://` is intentionally allowed app-wide — see the comment in
`android/app/src/main/res/xml/network_security_config.xml` — since this is
meant for an internal LAN backend without its own HTTPS certificate. Lock
that down if the backend ever needs to be reachable from outside a trusted
network.)

## Publishing to the Play Store instead of side-loading

The debug APK above is enough to install directly on phones you control. For
the Play Store you'd instead build a signed **release** bundle
(`./gradlew bundleRelease`, with your own signing key — Android Studio's
**Build → Generate Signed Bundle/APK** wizard walks through creating one) and
go through Google's normal app listing/review process — a bigger step, ask if
you want help with that part specifically.

## What's in here

- `android/` — the native Android Studio project (this is what you open)
- `www/` — the web app bundled inside it (same app as the PWA version, plus
  an in-app server-address setting since there's no browser console on a
  real device)
- `capacitor.config.ts` — app id (`com.gmao.stockapp`), name, web root
