> [!WARNING]
> The following is a prototype, reference implementation, and proof-of-concept. This open source code is provided for research, experimentation, and developer education only. This code has not been audited, is actively experimental, and may contain bugs, vulnerabilities, or incomplete features. Use at your own risk.


# Polkadot Playground

Minimal React + Vite + TypeScript template wired to the Host API for product-account access from a Polkadot host (Mobile, Desktop, or Web). A starting point for building Polkadot dapps.

A live deployment runs at [**playground-template.paseoli.dev**](https://playground-template.paseoli.dev) — open it inside a Polkadot host (Mobile, Desktop, or Web) to see the template connect to the Host API, surface the app-scoped product account's SS58 + EVM (H160) addresses, and sign a message end-to-end. Signing is approved on Polkadot Mobile — Desktop and Web relay the request to your paired phone.

Beyond signing, the template demonstrates host-routed chain reads on **Paseo Asset Hub**: a live finalized-block ticker, plus an on-chain panel for the product account showing its PGAS balance and whether it's mapped for contract calls (`Revive.OriginalAccount`). It also negotiates host resource allowances (Statement Store, Bulletin, smart contracts, auto-signing) on connect and reconnects automatically when you log in on the host.

## Mod it

This repo is meant to be forked, gutted, and turned into your own dapp. The pieces you'll most likely want to swap or extend:

- **Account panel** ([src/App.tsx](src/App.tsx)) — replace the address display + sign demo with whatever your app actually does. The `SignDemo` component is a working reference for calling `signerManager.signRaw(...)` once you have a selected account.
- **App shell** ([src/App.tsx](src/App.tsx), [src/App.css](src/App.css)) — header, layout, and theme are intentionally tiny so you can rip them out. The `#root { max-width: 520px }` cap is just a default; widen or remove it for dashboards / multi-column layouts.
- **Stack additions** — `@parity/product-sdk-chain-client` for chain RPC, `@parity/product-sdk-bulletin` for off-chain storage, `@parity/product-sdk-contracts` for smart contracts, `@parity/product-sdk-statement-store` for P2P pub/sub. See [CLAUDE.md](CLAUDE.md) for the full stack table.

When you're ready, deploy your fork to your own DotNS domain (see below) — no servers, no hosting bill.

## Stack

- **React 19** + **Vite** + **TypeScript**
- **`@parity/product-sdk-signer`** — Host signer management and app-scoped product-account signing
- **`@parity/product-sdk-host`** — Host API helpers for the Polkadot host (Mobile, Desktop, or Web); built on **`@parity/truapi`** (codec 2 — requires a codec-2 host build)
- **`@parity/product-sdk-chain-client`** (+ `-descriptors`) — host-routed chain reads (no direct RPC), used for the Paseo Asset Hub block + account panel

## Running

```bash
./setup.sh    # installs deps + fetches the @parity/product-sdk skills
npm run dev
```

`setup.sh` installs `node_modules/` and pulls the `@parity/product-sdk` skills
into `.claude/skills/` so AI coding assistants (Claude Code, Cursor, Windsurf,
Copilot, Gemini) have the Polkadot SDK guidance on hand. The skills are fetched
from [paritytech/product-sdk](https://github.com/paritytech/product-sdk), not
committed here, so they stay current — re-run `./setup.sh --refresh` to update
them. (Plain `npm install` also works if you don't want the skills.)

Runs on `http://localhost:5173`. Must be opened inside a **Polkadot host** (Mobile, Desktop, or Web) for Host API login to work; signing is approved on Polkadot Mobile.

Product-account signing is scoped to the host's current app identifier, and **the DotNS TLD depends on the network** — the CLI's default env registers `<name>.paseo`, production uses `<name>.dot`. Local dev uses the current loopback host, e.g. `localhost:5173`; gateway URLs (`<name>.dot.li`, `<name>.paseoli.dev`, …) are mapped back to `<name>.<tld>`. Set `VITE_PRODUCT_ACCOUNT_ID` when you need an explicit override.

## Structure

```
src/
├── App.tsx       # Header + product account panel + your app shell
├── utils.ts      # Product SDK signer wrapper + resource allowances + helpers
├── chain.ts      # Host-routed Paseo Asset Hub reads (block, PGAS, mapping)
└── main.tsx      # Vite entry
```

## Deploying

A `/deploy <name>` slash command is wired up for Claude Code users — it runs `playground deploy` (the [Playground CLI](https://github.com/paritytech/playground-cli)) using the phone signer. Standalone:

```bash
playground login    # separate from being signed in on your phone/host
npm run build
playground deploy --no-build --buildDir dist --domain <name> --signer phone --playground --tag <tag>
```

Pass the **bare** name — the CLI appends the TLD for the target env (`.paseo` by default; `--env` selects another). See [DEPLOYMENT.md](DEPLOYMENT.md) for the full walkthrough.

## Ideas for modding

### Beginner — UI and frontend

- Reskin it — change colours, typography, visual style
- Rename everything — app name, labels, descriptions
- Add a tagline and hero section
- Make it mobile-first
- Add dark/light mode toggle
- Add a second language
- Design a custom empty state

### Intermediate — storage and data

- Add a new data field stored on decentralised storage
- Add rich text editing
- Add image upload stored on decentralised storage
- Add a comments section using Statement Store
- Add client-side search and filter
- Add pagination
- Add timestamps
- Add data export as JSON

### Advanced — smart contracts (requires [CDM](https://github.com/paritytech/contract-dependency-manager)/Rust, laptop required)

- Enforce a character limit at contract level
- Add item expiry after a set number of blocks
- Add a cap on total submissions
- Add PoP gating — only verified humans can participate
- Add an allowlist of approved accounts
- Add an admin-only moderation function
- Change the voting or selection mechanic
- Add a contract event so the UI can react in real time
- Require multi-sig approval

### Advanced — multiplayer and cross-account

- Add a challenge mechanic via Statement Store
- Add an on-chain leaderboard
- Add Statement Store notifications
- Add a tipping mechanic using PGAS

## Security

> [!WARNING]
> The following is a prototype, reference implementation, and proof-of-concept. This open source code is provided for research, experimentation, and developer education only. This code has not been audited, is actively experimental, and may contain bugs, vulnerabilities, or incomplete features. Use at your own risk.

This is a reference proof-of-concept, **not a hardened production build**. Before
deploying it for any real use case, you are responsible for:

- Reviewing the code yourself.
- Checking that dependencies are up to date and free of known vulnerabilities.
- Securing your own fork or deployment environment (keys, secrets, network configuration).
- Tracking the latest tagged release / commits for security fixes — older releases
  are not backported (exceptions might apply).

For Parity's security disclosure process and Bug Bounty program, see
[parity.io/bug-bounty](https://parity.io/bug-bounty).

## License

Licensed under the [GNU General Public License v3.0 or later](./LICENSE) (`GPL-3.0-or-later`).
