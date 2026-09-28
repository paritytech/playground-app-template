---
description: Build and deploy the app to a DotNS domain.
---

Deploy the app using `playground deploy`. The user's chosen domain name is: $ARGUMENTS

Steps:
1. If no domain name was provided in $ARGUMENTS, ask the user for one before proceeding. Pass the **bare name** (e.g. "reinhard") and let the CLI append the TLD — **the TLD is network-specific**, and the CLI's default env (`paseo-next-v2`) registers `<name>.paseo`, not `<name>.dot`. Check `playground deploy --help` if you need to confirm the current default.
2. **If the app's smart contract changed since the last deploy** (new or redeployed contract — a changed contract has a new on-chain address), **ask the user whether to publish under a new domain** instead of overwriting the existing one. A changed contract is effectively a new app version; re-pointing the old domain at it can strand the previous contract's users and state. If they want a new domain, use that name for the rest of this flow.
3. **Before publishing, ask the user to update what drives the App Detail Page:**
   - **`README.md`** — it's inlined into the published metadata and rendered on the app's Detail Page. Offer to help refresh it so it matches the current app.
   - **the tag** — pick the category that fits via `--tag <tag>`. The list moves; read it off `playground deploy --help` rather than trusting this line. As of CLI v0.47 it is: `site`, `social`, `chat`, `utility`, `gaming`, `marketplace`, `irl` (note `defi` was removed and `site` added).
   - Note honestly: the CLI publish path does **not** support a custom name/description/icon image — the name is the domain and the Detail Page uses a placeholder image. Don't promise an image upload.
4. Run `npm run build` to ensure a fresh build.
5. Run `playground deploy --no-build --buildDir dist --domain <name> --signer phone --playground --tag <tag>` where `<name>` is the **bare** domain the user provided (strip any TLD they included — the CLI appends the one for the target env) and `<tag>` is the category chosen in step 3. Use a 5-minute timeout — deploys involve multiple on-chain transactions that wait for phone approval.
   - The deploy needs its **own** CLI session: `playground login` is separate from being signed in on the phone/host. If `playground status` reports "Log in first", the user must run `playground login` and scan the QR — ask them to run it themselves, it is interactive.
6. Show the user the output. The phone signer is already paired. There are **no push notifications** — tell the user to **open the Polkadot App on their phone** themselves; pending approval requests appear inside the app and they need to approve each one (4 approvals total: commitment, register, setContenthash, publish). Do not mention QR codes, links, or notifications.
7. If it succeeded, remind them to open the registered domain (the CLI prints it) inside a **Polkadot host** (Mobile, Desktop, or Web) to verify the deployment. On Desktop/Web tell them to **hard-refresh** (Cmd+Shift+R / Ctrl+Shift+R) — the browser may serve a cached version of the previous deploy.
