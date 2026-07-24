import { useEffect, useState } from "react";
import { truncateAddress } from "@parity/product-sdk-address";
import { bytesToHex, formatPlanck, utf8ToBytes } from "@parity/product-sdk-utils";
import { isInsideContainerSync } from "@parity/product-sdk-host";
import {
    signerManager,
    useResourceAllocationState,
    useSignerState,
    openExternalLink,
    type ResourceAllocationKind,
    type ResourceAllocationOutcome,
    type ResourceAllocationState,
    type SignerAccount,
} from "./utils.ts";
import { NETWORK, useChainBlock, useProductAccountChainInfo } from "./chain.ts";

const PLAYGROUND_URL = "https://playground.dot";

export default function App() {
    const { status, selectedAccount, error } = useSignerState();

    useEffect(() => {
        signerManager.connect().then(result => {
            if (result.ok && result.value.length > 0) {
                signerManager.selectAccount(result.value[0].address);
            }
        });
    }, []);

    if (status === "connecting") {
        return <div className="spinner">Connecting...</div>;
    }

    return (
        <>
            <header>
                <h1>Polkadot Playground</h1>
                {selectedAccount && (
                    <span className={`address-chip${selectedAccount.name ? "" : " mono"}`}>
                        {selectedAccount.name ?? truncateAddress(selectedAccount.address)}
                    </span>
                )}
            </header>

            <main className="main">
                {selectedAccount ? (
                    <AccountPanel account={selectedAccount} />
                ) : (
                    <NotConnectedHint error={error?.message ?? null} />
                )}
                <ModItCard />
            </main>
        </>
    );
}

// Shown when no product account resolved. The bare "log in" message hid whether
// the app simply isn't in a host vs. connected-but-rejected, so surface both:
// `Host detected` = is there a Host API here at all (isInsideContainerSync);
// `dotNS ID` = the identifier we derived from the URL (a wrong one gets the
// account rejected); `Last error` = the actual connect/getProductAccount failure.
function NotConnectedHint({ error }: { error: string | null }) {
    const inHost = isInsideContainerSync();
    return (
        <div className="hint">
            <p>
                You need to log into Polkadot first — either view this page within a{" "}
                <strong>Polkadot host</strong> (Desktop or browser), or log in in the preview on RevX.
            </p>
            <dl className="diag">
                <div>
                    <dt>Host detected</dt>
                    <dd className="mono">{inHost ? "yes" : "no — not embedded in a Polkadot host"}</dd>
                </div>
                <div>
                    <dt>dotNS ID</dt>
                    <dd className="mono">{signerManager.productAccountIdentifier}</dd>
                </div>
                {error && (
                    <div>
                        <dt>Last error</dt>
                        <dd className="mono">{error}</dd>
                    </div>
                )}
            </dl>
        </div>
    );
}

function AccountPanel({ account }: { account: SignerAccount }) {
    return (
        <div className="panel">
            <Field label="dotNS ID" value={signerManager.productAccountIdentifier} />
            <Field label="SS58 address" value={account.address} />
            <Field label="EVM address (H160)" value={account.h160Address} />
            <ChainBlockPanel />
            <ResourceAllocationPanel />
            <ProductAccountChainPanel account={account} />
            <SignDemo />
        </div>
    );
}

const RESOURCE_LABELS: Record<ResourceAllocationKind, string> = {
    StatementStoreAllowance: "Statement store",
    BulletinAllowance: "Bulletin",
    SmartContractAllowance: "Smart contracts",
    AutoSigning: "Auto-signing",
};

const OUTCOME_LABELS: Record<ResourceAllocationOutcome, string> = {
    Allocated: "Allocated",
    Rejected: "Rejected",
    NotAvailable: "Not available",
};

const STATUS_LABELS: Record<ResourceAllocationState["status"], string> = {
    idle: "Waiting",
    requesting: "Requesting",
    complete: "Complete",
    unavailable: "Unavailable",
    rejected: "Declined",
    error: "Failed",
};

function ResourceAllocationPanel() {
    const allocation = useResourceAllocationState();

    return (
        <div className="resource-panel">
            <div className="resource-heading">
                <span className="field-label">Host resources</span>
                <span className={`resource-status resource-status-${allocation.status}`}>
                    {STATUS_LABELS[allocation.status]}
                </span>
            </div>
            <div className="resource-list">
                {allocation.entries.map(entry => (
                    <div className="resource-row" key={entry.resource}>
                        <span>{RESOURCE_LABELS[entry.resource]}</span>
                        <span className={`resource-badge resource-badge-${entry.outcome ?? "pending"}`}>
                            {entry.outcome ? OUTCOME_LABELS[entry.outcome] : "Pending"}
                        </span>
                    </div>
                ))}
            </div>
            {allocation.error && <p className="error">{allocation.error}</p>}
        </div>
    );
}

// On-chain facts about the product account, surfaced once connected: whether
// it's mapped for contracts, and its PGAS gas balance. PGAS is only read after
// the host allowance completes — that's what provisions gas — so before then we
// nudge the user rather than showing a misleading zero.
function ProductAccountChainPanel({ account }: { account: SignerAccount }) {
    const allocation = useResourceAllocationState();
    const allowanceGranted = allocation.status === "complete";
    const info = useProductAccountChainInfo(account.address, allowanceGranted);

    const mapped =
        info.mapped === null
            ? info.status === "error" ? "unavailable" : "checking…"
            : info.mapped ? "Yes" : "No — map to use contracts";

    // PGAS is only provisioned once the host grants the allowance. Distinguish
    // "granted → read it" from a finished-but-denied allowance (declined/failed)
    // so we don't show "awaiting" forever after the user rejects the prompt.
    let pgas: string;
    if (allowanceGranted) {
        pgas = info.pgas
            ? `${formatPlanck(info.pgas.planck, info.pgas.decimals)} ${info.pgas.symbol}`
            : info.status === "error" ? "unavailable" : "loading…";
    } else if (allocation.status === "rejected") {
        pgas = "allowance declined";
    } else if (allocation.status === "error" || allocation.status === "unavailable") {
        pgas = "allowance unavailable";
    } else {
        pgas = "awaiting host allowance"; // idle / requesting
    }

    return (
        <div className="resource-panel">
            <div className="resource-heading">
                <span className="field-label">Product account on-chain</span>
            </div>
            <div className="resource-list">
                <div className="resource-row">
                    <span>Account mapped</span>
                    <span className="mono">{mapped}</span>
                </div>
                <div className="resource-row">
                    <span>PGAS balance</span>
                    <span className="mono">{pgas}</span>
                </div>
            </div>
            {info.error && <p className="error">{info.error}</p>}
        </div>
    );
}

function ChainBlockPanel() {
    const { status, block, error } = useChainBlock();
    const display =
        status === "live" && block !== null
            ? `#${block.toLocaleString()}`
            : status === "error"
              ? "unavailable"
              : "connecting…";

    return (
        <div className="field">
            <span className="field-label">{NETWORK.label} block</span>
            <div className="chain-block">
                <span className={`chain-dot chain-dot-${status}`} aria-hidden />
                <span className="mono">{display}</span>
            </div>
            {error && <p className="error">{error}</p>}
        </div>
    );
}

function ModItCard() {
    return (
        <section className="mod-card">
            <h2>Mod this app</h2>
            <p>
                You're looking at the <strong>playground template</strong> live at{" "}
                <a
                    href={PLAYGROUND_URL}
                    onClick={e => { e.preventDefault(); openExternalLink(PLAYGROUND_URL); }}
                >playground.dot</a>{" "}
                — a minimal React + Vite + TypeScript starting point wired to the Polkadot Host API.
                Fork it, gut the account panel, and turn it into your own dapp.
            </p>
            <ul>
                <li>Replace the sign demo with whatever your app actually does.</li>
                <li>Tap deeper into the host env: <code>@parity/product-sdk-bulletin</code> for off-chain storage,
                    <code>@parity/product-sdk-statement-store</code> for real-time P2P pub/sub,
                    or <code>@parity/product-sdk-contracts</code> for smart contracts.</li>
                <li>Run <code>playground deploy</code> to publish your fork to <code>&lt;name&gt;.dot</code> — no servers, no hosting bill.</li>
            </ul>
        </section>
    );
}

function Field({ label, value }: { label: string; value: string }) {
    const [copied, setCopied] = useState(false);
    const copy = () => {
        navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
    };
    return (
        <div className="field">
            <span className="field-label">{label}</span>
            <button className="field-value" onClick={copy} title="Click to copy">
                <span className="mono">{value}</span>
                <span className="field-copy">{copied ? "copied" : "copy"}</span>
            </button>
        </div>
    );
}

function SignDemo() {
    const [message, setMessage] = useState("Hello from the Polkadot Playground");
    const [signature, setSignature] = useState<string | null>(null);
    const [signError, setSignError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const sign = async () => {
        setBusy(true);
        setSignature(null);
        setSignError(null);
        const result = await signerManager.signRaw(utf8ToBytes(message));
        if (result.ok) {
            setSignature("0x" + bytesToHex(result.value));
        } else {
            setSignError(result.error.message);
        }
        setBusy(false);
    };

    return (
        <div className="sign-demo">
            <span className="field-label">Sign a message</span>
            <input
                className="text-input"
                value={message}
                onChange={e => setMessage(e.target.value)}
                disabled={busy}
            />
            <button className="btn btn-primary" onClick={sign} disabled={busy || !message}>
                {busy ? "Signing..." : "Sign"}
            </button>
            {signature && (
                <div className="signature">
                    <span className="field-label">Signature</span>
                    <code className="mono signature-value">{signature}</code>
                </div>
            )}
            {signError && <p className="error">{signError}</p>}
        </div>
    );
}
