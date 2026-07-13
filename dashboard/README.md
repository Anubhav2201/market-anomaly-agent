# Control Panel Dashboard

A single static page (`dashboard/index.html`, no build step, no
framework) for toggling feature flags and managing subscribers,
talking directly to Firestore from the browser. Hosted on Firebase
Hosting - genuinely free at this scale (10 GB storage / 360 MB day
transfer free tier, and this is a one-person admin page checked
occasionally, nowhere close to those limits).

## Why direct-to-Firestore, no backend

This page doesn't call any of the Cloud Run services - it reads/writes
`system_config/feature_flags` and `subscriptions` in Firestore
directly via the Firebase client SDK. That's simpler and cheaper than
standing up a separate backend just to proxy these reads/writes, and
it's exactly what Firebase's client SDK + security rules are designed
for.

**This means Firestore security rules (`firestore.rules` at the repo
root) are the ONLY thing stopping anyone with the page URL from
toggling your feature flags or editing your subscriber list.** Do not
skip the setup steps below.

## One-time setup

### 1. Enable Firebase Auth

Firebase Console → your project → Build → Authentication → Get
started → enable the **Email/Password** provider.

Then, under the Users tab, add yourself as a user (your email + a
password you'll use to sign into the dashboard).

### 2. Lock down Firestore rules to your email

Edit `firestore.rules` at the repo root - replace
`REPLACE_WITH_YOUR_EMAIL@example.com` with your actual email (the same
one you just added as an Auth user). As written, the rules deny
**everyone** until this is set - a safe default, not accidentally wide
open.

Deploy the rules:
```bash
firebase deploy --only firestore:rules
```

### 3. Fill in your Firebase web config

Firebase Console → Project Settings (gear icon) → General → scroll to
"Your apps" → if you don't have a Web app yet, click the `</>` icon to
register one → copy the `firebaseConfig` object shown.

Paste those values into `dashboard/index.html`, replacing the
`REPLACE_ME` placeholders in the `firebaseConfig` object near the
bottom of the file. These values are NOT secret (they identify which
Firebase project to talk to, not credentials) - it's fine that they're
visible in the page source, security is enforced by the Firestore
rules above, not by hiding this config.

### 4. Deploy

```bash
firebase deploy --only hosting
```

Firebase will print the live URL (something like
`https://your-project.web.app`). Bookmark it.

## Using it

- **Kill switch**: the big toggle at the top is `pipeline_enabled`.
  Off = the entire pipeline stops within ~15 seconds, no matter what
  the flags below say.
- **Individual flags**: pause one specific paid call (Claude, Tiingo,
  Adanos, Groq) without stopping everything else.
- **Subscribers**: add/remove who gets emailed. Use REAL thresholds
  (3.0 price-z / 2.0 volume-z is the system default) - a low threshold
  "for testing" means more real anomalies fire, which means more real
  API cost, especially risky if you're not watching it. See
  DECISIONS.md ADR-027.

Changes made here are read directly by the backend services
(`agent-svc`, `grounding-svc`, `fanout-svc`) via the same Firestore
docs - no redeploy needed on their end either.
