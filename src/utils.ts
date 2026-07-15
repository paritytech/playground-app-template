import { useSyncExternalStore } from "react";
import {
    HostUnavailableError,
    navigateTo,
    requestResourceAllocation,
    type AllocatableResource,
    type AllocationOutcome,
    type HostError,
} from "@parity/product-sdk-host";
import { isSigningRejection } from "@parity/product-sdk-tx";
import { configure, createLogger } from "@parity/product-sdk-logger";
import {
    AccountNotFoundError,
    SignerManager,
    SigningFailedError,
    err,
    ok,
    type Result,
    type SignerAccount,
    type SignerError,
    type SignerState,
} from "@parity/product-sdk-signer";

const DEFAULT_PRODUCT_ACCOUNT_DOT_NS = "playground.dot";
const PRODUCT_ACCOUNT_DERIVATION_INDEX = 0;

// Scoped diagnostic logging — a pattern worth keeping in a template. Only this
// namespace drops to "debug"; every other product-sdk logger stays at "warn",
// so you get detail where you want it without global noise (tune the namespace
// / level below to taste). Here it captures the raw truapi payload for each
// resource-allocation outcome (success, phone rejection, Desktop dialog cancel)
// — handy for debugging your own flows and for reporting host gaps, e.g. a
// Desktop cancel currently arriving as an indistinguishable Unknown{reason}.
const allowanceLog = createLogger("playground:allowance");
// Dev only: raise this namespace to "debug" so info/debug entries show while
// developing. In production it stays at the "warn" default, so end users' of
// apps built from this template don't get debug logs in their console.
if (import.meta.env.DEV) {
    configure({ level: "debug", namespaces: ["playground:allowance"] });
}

// The structured truapi error payload rides on HostCallFailedError as `payload`
// ({ tag, value?: { reason } }); pull it out for logging without depending on
// the class (avoids narrowing gymnastics).
function rawErrorPayload(error: unknown): unknown {
    return error && typeof error === "object" && "payload" in error
        ? (error as { payload: unknown }).payload
        : undefined;
}

const RESOURCE_ALLOCATION_REQUESTS = [
    { tag: "StatementStoreAllowance", value: undefined },
    { tag: "BulletinAllowance", value: undefined },
    { tag: "SmartContractAllowance", value: PRODUCT_ACCOUNT_DERIVATION_INDEX },
    { tag: "AutoSigning", value: undefined },
] as const satisfies ReadonlyArray<AllocatableResource>;

export type ResourceAllocationKind = AllocatableResource["tag"];
export type ResourceAllocationOutcome = AllocationOutcome;

// Classify a failed allocation. isSigningRejection (product-sdk-tx, the same
// helper playground-app uses) keys off the error message — "cancelled",
// "rejected", "denied", "user refused" — so we surface a user decline distinctly
// from a genuine failure instead of showing a bare "failed".
//
// Caveat: truapi's ResourceAllocationError is a single catch-all variant
// ({ tag: "Unknown", value: { reason } }), so this only lands as "rejected" when
// the host's reason string carries one of those keywords. A reason like
// "Unknown error occurred" won't match and falls through to "error".
function classifyResourceAllocationError(error: HostError): {
    status: "unavailable" | "rejected" | "error";
    message: string;
} {
    if (error instanceof HostUnavailableError) {
        return { status: "unavailable", message: "Host unavailable — open this app inside a Polkadot host." };
    }
    if (isSigningRejection(error)) {
        return { status: "rejected", message: "You declined the allowance request." };
    }
    return { status: "error", message: error.message };
}

export interface ResourceAllocationEntry {
    resource: ResourceAllocationKind;
    outcome: ResourceAllocationOutcome | null;
}

export interface ResourceAllocationState {
    status: "idle" | "requesting" | "complete" | "unavailable" | "rejected" | "error";
    entries: readonly ResourceAllocationEntry[];
    error: string | null;
}

const INITIAL_RESOURCE_ALLOCATION_ENTRIES: readonly ResourceAllocationEntry[] =
    RESOURCE_ALLOCATION_REQUESTS.map(request => ({ resource: request.tag, outcome: null }));

function isLoopbackHost(hostname: string): boolean {
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function getProductAccountIdentifier(): string {
    const configuredIdentifier = import.meta.env.VITE_PRODUCT_ACCOUNT_ID?.trim();
    if (configuredIdentifier) return configuredIdentifier;

    const { host, hostname } = window.location;
    if (isLoopbackHost(hostname)) return host;

    // dotli exposes hosted products as `<name>.<gateway>` (always 3 hostname
    // labels: `playground.dot.li`, `playground-sample.paseo.li`, ...). Map
    // them back to the canonical `<name>.dot` identifier the host signs.
    const labels = hostname.toLowerCase().split(".");
    if (labels.length === 3) return `${labels[0]}.dot`;

    if (hostname.endsWith(".dot")) return hostname;
    return DEFAULT_PRODUCT_ACCOUNT_DOT_NS;
}

function initialState(): SignerState {
    return {
        status: "disconnected",
        accounts: [],
        selectedAccount: null,
        activeProvider: null,
        error: null,
    };
}

function initialResourceAllocationState(): ResourceAllocationState {
    return {
        status: "idle",
        entries: INITIAL_RESOURCE_ALLOCATION_ENTRIES,
        error: null,
    };
}

class ProductAccountSignerManager {
    readonly productAccountIdentifier = getProductAccountIdentifier();
    private readonly manager = new SignerManager({
        dappName: this.productAccountIdentifier,
        ss58Prefix: 42,
    });
    private readonly subscribers = new Set<(state: SignerState) => void>();
    private readonly resourceSubscribers = new Set<(state: ResourceAllocationState) => void>();
    private state = initialState();
    private resourceAllocationState = initialResourceAllocationState();
    private connectPromise: Promise<Result<SignerAccount[], SignerError>> | null = null;

    constructor() {
        // connecting/connected transitions are owned by connect() since the wrapper
        // exposes a derived product account. Only mirror mid-session disconnects, and
        // guard against re-firing when connectInner already set disconnected.
        this.manager.subscribe(underlyingState => {
            if (underlyingState.status === "disconnected" && this.state.status !== "disconnected") {
                this.transitionToDisconnected(underlyingState.error);
            }
        });
    }

    private transitionToDisconnected(error: SignerError | null) {
        this.setState({
            status: "disconnected",
            accounts: [],
            selectedAccount: null,
            activeProvider: null,
            error,
        });
        this.setResourceAllocationState(initialResourceAllocationState());
    }

    getState(): SignerState {
        return this.state;
    }

    getResourceAllocationState(): ResourceAllocationState {
        return this.resourceAllocationState;
    }

    subscribe(callback: (state: SignerState) => void): () => void {
        this.subscribers.add(callback);
        return () => {
            this.subscribers.delete(callback);
        };
    }

    subscribeResourceAllocation(callback: (state: ResourceAllocationState) => void): () => void {
        this.resourceSubscribers.add(callback);
        return () => {
            this.resourceSubscribers.delete(callback);
        };
    }

    async connect(): Promise<Result<SignerAccount[], SignerError>> {
        if (this.state.status === "connected") return ok([...this.state.accounts]);
        if (this.connectPromise) return this.connectPromise;

        this.connectPromise = this.connectInner().finally(() => {
            this.connectPromise = null;
        });
        return this.connectPromise;
    }

    private async connectInner(): Promise<Result<SignerAccount[], SignerError>> {
        this.setState({
            status: "connecting",
            accounts: [],
            selectedAccount: null,
            activeProvider: "host",
            error: null,
        });

        const connection = await this.manager.connect("host");
        if (!connection.ok) {
            this.transitionToDisconnected(connection.error);
            return connection;
        }
        const ownerName = connection.value[0]?.name ?? null;

        const productAccount = await this.manager.getProductAccount(
            this.productAccountIdentifier,
            PRODUCT_ACCOUNT_DERIVATION_INDEX,
        );
        if (!productAccount.ok) {
            // Update our state before tearing down the underlying so the constructor
            // subscriber's guard suppresses a redundant disconnect propagation.
            this.transitionToDisconnected(productAccount.error);
            this.manager.disconnect();
            return err(productAccount.error);
        }

        const selectedAccount = {
            ...productAccount.value,
            name: productAccount.value.name ?? ownerName,
        };
        const accounts = [selectedAccount];
        this.setState({
            status: "connected",
            accounts,
            selectedAccount,
            activeProvider: "host",
            error: null,
        });
        // Fire-and-forget: connect resolves as soon as the product account is in
        // hand, so the UI can render. Allocations negotiate in the background; sign
        // calls issued before completion may trigger an extra host prompt.
        void this.requestResourceAllocation();
        return ok(accounts);
    }

    async requestResourceAllocation(): Promise<ResourceAllocationState> {
        const requestedEntries = initialResourceAllocationState().entries;
        this.setResourceAllocationState({
            status: "requesting",
            entries: requestedEntries,
            error: null,
        });

        try {
            const response = await requestResourceAllocation([...RESOURCE_ALLOCATION_REQUESTS]);
            if (!response.ok) {
                // Distinguish "outside a host" (unavailable), a user decline
                // (rejected) and a genuine failure (error) — see
                // classifyResourceAllocationError.
                const { status, message } = classifyResourceAllocationError(response.error);
                // Log the raw shape so the three failure paths (phone rejection
                // vs. Desktop dialog cancel vs. real error) can be told apart in
                // a host-gap report: `payload.value.reason` is the only field
                // that differs, and `classifiedAs: "rejected"` shows whether our
                // keyword heuristic caught it.
                allowanceLog.warn("resource allocation failed", {
                    classifiedAs: status,
                    errorName: response.error.name,
                    message: response.error.message,
                    payload: rawErrorPayload(response.error),
                });
                const nextState: ResourceAllocationState = {
                    status,
                    entries: requestedEntries,
                    error: message,
                };
                this.setResourceAllocationState(nextState);
                return nextState;
            }
            const outcomes = response.value;
            const entries = RESOURCE_ALLOCATION_REQUESTS.map((request, index) => ({
                resource: request.tag,
                outcome: outcomes[index] ?? "NotAvailable",
            }));
            allowanceLog.info("resource allocation complete", { outcomes: entries });
            const nextState: ResourceAllocationState = {
                status: "complete",
                entries,
                error: null,
            };
            this.setResourceAllocationState(nextState);
            return nextState;
        } catch (cause) {
            allowanceLog.error("resource allocation threw", {
                errorName: cause instanceof Error ? cause.name : typeof cause,
                message: cause instanceof Error ? cause.message : String(cause),
                payload: rawErrorPayload(cause),
                signingRejection: isSigningRejection(cause),
            });
            const nextState: ResourceAllocationState = {
                status: "error",
                entries: requestedEntries,
                error: cause instanceof Error ? cause.message : String(cause),
            };
            this.setResourceAllocationState(nextState);
            return nextState;
        }
    }

    selectAccount(address: string): Result<SignerAccount, SignerError> {
        const account = this.state.accounts.find(candidate => candidate.address === address);
        if (!account) return err(new AccountNotFoundError(address));
        this.setState({ selectedAccount: account });
        return ok(account);
    }

    getSigner(): ReturnType<SignerAccount["getSigner"]> | null {
        return this.state.selectedAccount?.getSigner() ?? null;
    }

    async signRaw(data: Uint8Array): Promise<Result<Uint8Array, SignerError>> {
        const signer = this.getSigner();
        if (!signer) return err(new SigningFailedError(null, "No product account selected"));

        try {
            return ok(await signer.signBytes(data));
        } catch (cause) {
            return err(new SigningFailedError(cause));
        }
    }

    private setState(patch: Partial<SignerState>) {
        this.state = { ...this.state, ...patch };
        for (const subscriber of this.subscribers) {
            subscriber(this.state);
        }
    }

    private setResourceAllocationState(state: ResourceAllocationState) {
        this.resourceAllocationState = state;
        for (const subscriber of this.resourceSubscribers) {
            subscriber(this.resourceAllocationState);
        }
    }
}

export type { SignerAccount, SignerState };

export const signerManager = new ProductAccountSignerManager();

export function useSignerState(): SignerState {
    return useSyncExternalStore(
        cb => signerManager.subscribe(cb),
        () => signerManager.getState(),
    );
}

export function useResourceAllocationState(): ResourceAllocationState {
    return useSyncExternalStore(
        cb => signerManager.subscribeResourceAllocation(cb),
        () => signerManager.getResourceAllocationState(),
    );
}

export async function openExternalLink(url: string) {
    if (signerManager.getState().activeProvider !== "host") {
        window.open(url, "_blank");
        return;
    }
    try {
        const result = await navigateTo(url);
        if (!result.ok) window.open(url, "_blank");
    } catch {
        window.open(url, "_blank");
    }
}
