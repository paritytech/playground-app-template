# Deploying your own copy of this template

This guide walks you through deploying your own instance of the Polkadot
Playground template: your own frontend on Bulletin Chain, served from your
own DotNS name, starting from nothing but a GitHub account, a terminal, and
a phone.

This template ships **frontend-only** by default — if you haven't added a smart
contract, there's no Rust toolchain or contract build to set up, and one tool
does all the work:

- **[Playground CLI](https://github.com/paritytech/playground-cli)** (`playground`, short alias `pg`) builds the frontend,
  uploads it to Bulletin Chain, registers your DotNS name, and (optionally)
  publishes the app to the playground registry so it shows up in the Apps
  grid.

Rough time: about 10 minutes end to end. There's no slow Rust build here —
the wait is mostly the on-chain steps that pause for phone approval.

> **Added a smart contract?** (See CLAUDE.md → *Smart contracts* for how to
> scaffold one.) There are extra build/deploy steps and one thing that's easy to
> miss — making sure `cdm.json`'s `registry` address matches your target
> network. See [Deploying a contract](#deploying-a-contract) below.

## 0. Prerequisites

You need three things:

**The Polkadot App on your phone**, with an account created. The standard
flow signs every deploy step by approving on the phone. (Deploying with a
pre-provisioned mnemonic instead is covered at the end of step 5.)

**Node.js** (with `npm`) — the build in step 3 uses it.

**The Playground CLI**:

```sh
curl -fsSL https://raw.githubusercontent.com/paritytech/playground-cli/main/install.sh | bash
```

Open a fresh terminal afterwards so it's on your PATH, then verify:

```sh
playground --version
```

## 1. Fork and clone the repository

Fork this repo on GitHub (the **Fork** button), then clone **your fork**,
not the upstream repo:

```sh
git clone https://github.com/<your-github-username>/playground-app-template.git
cd playground-app-template
```

*What's happening:* you now own a copy of the template — frontend (`src/`),
build config, and the deploy wiring.

The fork matters if you deploy with `--moddable` (step 4): that flag
publishes your git `origin` as the app's public source repo, so others can
`playground mod` your version. Clone upstream directly and you'd advertise
the original template's code instead of yours.

## 2. Sign in with the Playground CLI

```sh
playground login
```

*What's happening:* `login` asks for a display name, then shows a QR code.
Scan it with the Polkadot App and approve once: that verifies you via Proof
of Personhood, pairs a product account (an address like `playground.paseo/0`),
and provisions a local session key. Sign out later with `playground logout`.

A warning like `[cloudStorage] checkAuthorization: query failed ...
DisjointError` *after* `✓ setup complete` has been observed and was
harmless. If you got the `setup complete` line, proceed.

## 3. Build the frontend

```sh
npm install
npm run build
```

*What's happening:* this type-checks and builds the static site into
`dist/` — the directory the deploy step uploads.

## 4. Deploy to Bulletin and register your DotNS name

```sh
playground deploy --no-build --buildDir dist --domain playground-template --signer phone --playground
```

**The TLD comes from the target environment, not from you.** The CLI's default
env is `paseo-next-v2`, so this registers `playground-template.paseo`; `--env`
selects another (`polkadot` uses `.dot`). Pass the **bare** name and let the CLI
append the TLD — check `playground deploy --help` if you need to confirm the
current default.

This matters beyond the CLI: the frontend derives the same identifier from its
serving URL to ask the host for the product account, so if the two disagree the
host rejects the account and the app never connects. `getProductAccountIdentifier()`
in `src/utils.ts` infers the TLD from the gateway domain
(`<name>.paseoli.dev` → `<name>.paseo`, `<name>.dot.li` → `<name>.dot`);
`VITE_PRODUCT_ACCOUNT_ID` overrides it for anything unusual.

One constraint to know: if the name is already taken by someone else, the deploy
fails and you'll need a different name; `playground-template` is 19 characters,
comfortably above the 9+ length that avoids the personhood requirement for very
short names.

Want your fork to be moddable by others? Add `--moddable` (requires
`--playground` and a public GitHub `origin` — your fork):

```sh
playground deploy --no-build --buildDir dist --domain playground-template --signer phone --playground --moddable
```

The CLI shows a **preflight summary** before submitting anything. Read it
before pressing Enter — in particular, if you used `--moddable`, the
`moddable: yes ... <repo url>` line must point at **your fork**. It's
auto-detected from your git `origin`; if it shows the upstream repo, you
cloned instead of forking. Fix with
`git remote set-url origin https://github.com/<you>/playground-app-template.git`.

Press Enter and **open the Polkadot App on your phone**. There are no push
notifications and no QR code for this step — pending approval requests
appear *inside the app*, and you approve each one there. Expect **4
approvals**, plus possibly one more to top up your Bulletin storage
allowance:

1. **reserve domain** (DotNS commitment)
2. **finalize domain** (DotNS register)
3. **link content** (setContenthash — points the name at your upload)
4. **publish to Playground registry**

Between the first two approvals there is a deliberate ~60-second pause
(DotNS's anti-front-running commit-reveal window); it's not stuck.

*What's happening:*

1. uploads the `dist/` assets + app metadata to **Bulletin Chain**
   (decentralized storage, no server anywhere),
2. registers your **DotNS domain** via DotNS and points it at the upload,
3. publishes the app to the **playground registry**, which puts it in the
   playground's Apps grid,
4. prints the result: your live URL (`https://playground-template.paseoli.dev`,
   or `playground-template.paseo` inside a Polkadot host — Mobile, Desktop, or
   Web; the gateway host mirrors the TLD, `.dot` names serve from `dot.li`)
   plus the app, IPFS, and metadata CIDs.

### What shows on your app's listing

The playground's Apps grid and **App Detail Page** are driven by a metadata
JSON the publish step builds from your project:

- Your **`README.md`** is inlined into the metadata (capped in size) and
  rendered on the Detail Page — so **update `README.md` before you publish**.
- The **tag** (`--tag <tag>`) is the category used to filter the grid. As of CLI
  v0.47 the choices are `site`, `social`, `chat`, `utility`, `gaming`,
  `marketplace`, `irl` — the list moves (`defi` was removed, `site` added), so
  read it off `playground deploy --help`. If you omit the flag the CLI prompts
  you to pick one.
- With `--moddable`, your fork's public GitHub URL is recorded as the source
  `repository`.

The app's **name is the registered domain** itself; the current publish path
does not take a custom name, description, or icon/cover image, so the Detail
Page shows a generated placeholder image. Re-deploy after editing `README.md`
to refresh the listing.

### Deploying with a mnemonic instead of the phone

If you have a pre-provisioned account (a mnemonic or secret URI) you can
skip the phone flow entirely, including `playground login`:

```sh
playground deploy --no-build --buildDir dist --domain playground-template --playground --signer dev --suri "<your secret URI>"
```

Everything (storage, DotNS, playground publish) is then signed by that
account, with no phone approvals. Two things to know:

- **Always pass `--suri`.** Bare `--signer dev` without it falls back to a
  shared, publicly-known development mnemonic, so anyone could control what
  you deploy.
- The account must be funded: PAS for fees and a Bulletin storage allowance.
  Faucets:
  - PAS for fees: <https://faucet.polkadot.io/>
  - Bulletin storage allowance:
    <https://paritytech.github.io/polkadot-bulletin-chain/authorizations?tab=faucet>

## 5. Verify

- Open `https://playground-template.paseoli.dev` in a **plain browser**: your app,
  served from Bulletin. The page renders, but Host API login and the
  product-account panel only light up inside a Polkadot host (next bullet) — a
  plain tab has no host to talk to.
- Open `playground-template.paseo` inside a **Polkadot host** (Mobile, Desktop, or Web). On
  Desktop/Web **hard-refresh** (Cmd+Shift+R / Ctrl+Shift+R) — the browser may
  serve a cached copy of a previous deploy. You should see the template
  connect to the Host API and surface the app-scoped product account's SS58 +
  EVM (H160) addresses, and be able to sign a message end-to-end (the request
  is approved on your Polkadot Mobile — Desktop/Web relay it to the phone).
- If you deployed with `--playground`, open the playground's **Apps** tab
  (inside Polkadot Desktop / Mobile). Your card should appear, newest first.

## Deploying a contract

Only relevant if you added a smart contract (see CLAUDE.md → *Smart contracts*
for scaffolding it from CDM). A frontend-only app skips all of this — keep using
the steps above (or pass `--no-contracts` to be explicit).

**Extra prerequisites:** a Rust toolchain on your laptop (the version is
pre-pinned in `rust-toolchain.toml`, so `cargo`/`cdm` pick it up automatically)
and the CDM tooling. This is not a browser-only flow.

> ### ⚠️ Make `cdm.json`'s `registry` match your target network
>
> `cdm.json` has a top-level **`registry`** field — the address of the on-chain
> **CDM contract registry** where contract packages are published and resolved.
> **It is network-specific.** The scaffolding ships with the **Polkadot testnet
> (Paseo)** registry:
>
> ```json
> "registry": "0xf62c2ece29cd8df2e10040ecfa5a894a5c5d9cb0"
> ```
>
> If you deploy to a **different network**, you must set `registry` to that
> network's CDM registry address first — otherwise the contract deploy/resolve
> step targets the wrong chain and fails. If you only ever deploy to Paseo, the
> shipped value is already correct.

**Build and deploy.** `playground deploy` runs a **contract deploy/install
pre-step automatically** — pass `--contracts` (or answer the prompt):

```sh
npm run build   # build the frontend into dist/ first, as in step 3
playground deploy --no-build --buildDir dist --domain <name> --signer phone --playground --contracts
```

That compiles the contract (PVM/PolkaVM for `pallet-revive`), deploys it on-chain,
and **writes the real contract `address`, `abi`, and `metadataCid` back into
`cdm.json`** — so don't hand-fill those; the deploy fills them. The contract is
signed for on the phone like the other steps, and a fresh account may need a
one-time account-mapping approval. Let the CLI own on-chain deployment; never
hand-roll `pallet-revive` calls. To build the contract on its own, use
`cdm build`.

## Redeploying

Re-running `playground deploy` against a domain **you already own** is fine:
it uploads the new build and repoints the name at it. You don't repeat the
DotNS reservation, so expect fewer approvals on subsequent deploys. Rebuild
first with `npm run build`, or drop `--no-build` from the command to let the
CLI build for you.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `error: unknown command 'login'` or `'init'` | login is `playground login` in current CLI versions; there is no `init` |
| `[cloudStorage] ... DisjointError` after login | observed as harmless when it appears after `✓ setup complete`; proceed |
| `Domain <name>.<tld> is already registered` | first come, first served; pick a different name (re-deploying a domain you own yourself is fine) |
| `<name>.<tld> requires ProofOfPersonhoodFull, but this signer is NoStatus` | the name is too short to be open to all accounts; pick a longer one (9+ characters) |
| `--moddable` rejected / preflight shows the upstream repo as the source | `--moddable` needs a public GitHub `origin` that is **your fork**; `git remote set-url origin <your fork URL>` |
| Deploy pauses ~60s after the first phone approval | DotNS's mandatory commit-reveal wait (front-running protection), not a hang |
| No QR code or notification during deploy | expected for `--signer phone`: open the Polkadot App yourself; pending approvals appear inside the app |
| Deploy fails at the upload step with a `Payment` / allowance error | no Bulletin storage allowance; use the Bulletin faucet (see step 4's mnemonic notes), then re-run |
| `playground status` says "Log in first" even though you're signed in on your phone | the CLI keeps its **own** session, separate from the host/phone one. Run `playground login` and scan the QR; logging out and back in on the phone does not pair the CLI |
| App sits on "connecting" forever, log shows `Domain → V1 → NotConnected` | truapi's `NotConnected` means **"user is not logged in"** as far as the *host* is concerned — on Desktop/Web that means no paired Polkadot Mobile session. Distinct from `DomainNotValid`, which is the identifier being wrong |
| App connects but the host rejects the product account with `DomainNotValid` | the identifier the frontend derived doesn't match the registered domain — usually a TLD mismatch (`.dot` vs `.paseo`). Check the "dotNS ID" in the account panel against your deployed name, and set `VITE_PRODUCT_ACCOUNT_ID` to override |
| Need to see what the host is actually doing | append `?debug` to the app URL: it raises every product-sdk namespace to debug (not just the template's own) and prints the `signer:host` / truapi exchange. Works on deployed builds too |
| App loads but shows no product account in a plain desktop browser | expected: Host API access flows through the host. Open it inside Polkadot Desktop/Mobile, or via its gateway URL |
| The gateway URL returns a generic Polkadot page to curl/scripts | the gateway serves a client-side resolver shell; only a real browser renders your app |
| Opened your domain and saw the old version | hard-refresh (Cmd+Shift+R / Ctrl+Shift+R); the browser cached the previous deploy |
