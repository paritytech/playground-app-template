import { useEffect, useState } from "react";
import { truncateAddress } from "@parity/product-sdk-address";
import { bytesToHex, utf8ToBytes } from "@parity/product-sdk-utils";
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
import { useChainBlock } from "./chain.ts";

const PLAYGROUND_URL = "https://playground.dot";

export default function App() {
    const { status, selectedAccount } = useSignerState();

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
                    <p className="hint">
                        You need to log into Polkadot first — either view this page within a <strong>Polkadot host</strong> (Desktop or browser), or log in in the preview on RevX.
                    </p>
                )}
                <ModItCard />
            </main>
        </>
    );
}

function AccountPanel({ account }: { account: SignerAccount }) {
    return (
        <div className="panel">
            <Field label="Product identifier" value={signerManager.productAccountIdentifier} />
            <Field label="SS58 address" value={account.address} />
            <Field label="EVM address (H160)" value={account.h160Address} />
            <ChainBlockPanel />
            <ResourceAllocationPanel />
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
            <span className="field-label">Paseo Asset Hub block</span>
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
