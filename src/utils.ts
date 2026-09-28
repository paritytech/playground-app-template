import { useSyncExternalStore } from "react";
import {
    getAccountsProvider,
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
    DevProvider,
    HostProvider,
    SignerManager,
    SigningFailedError,
    TimeoutError,
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
//
// Append `?debug` to the URL to instead raise *every* product-sdk namespace to
// debug (omitting `namespaces` makes the level global). That's the switch to
// reach for when the app sits on "connecting": it surfaces the signer:host and
// truapi traffic, so you can see which host call was issued and never answered.
// Works in a deployed build too, not just dev — host-only failures rarely
// reproduce on localhost.
const debugAllNamespaces =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("debug");
if (debugAllNamespaces) {
    configure({ level: "debug" });
} else if (import.meta.env.DEV) {
    configure({ level: "debug", namespaces: ["playground:allowance"] });
}

// How long to wait for a host call during connect before giving up. truapi's own
// per-request deadline is 120s (and the handshake's is 10s), so a host that
// accepts a request but never answers it leaves the UI on "connecting" for two
// minutes with nothing on screen. Fail faster and say what stalled — the same
// reasoning as FIRST_BLOCK_TIMEOUT_MS in chain.ts.
const HOST_CALL_TIMEOUT_MS = 15_000;

// Race a host call against a deadline. On timeout the underlying promise is
// abandoned, not cancelled: truapi still settles it later against its own 120s
// deadline, which is harmless here because connect() is idempotent and a stale
// resolution can only land after we've already transitioned to disconnected.
async function withHostTimeout<T>(
    call: Promise<T>,
    label: string,
    onTimeout: () => T,
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<T>(resolve => {
        timer = setTimeout(() => {
            allowanceLog.warn(
                `host call "${label}" timed out — the host accepted the request but never ` +
                    "replied. Check for a pending approval prompt in the Polkadot app, and " +
                    "reload with ?debug to see the full signer/truapi exchange.",
                { call: label, timeoutMs: HOST_CALL_TIMEOUT_MS },
            );
            resolve(onTimeout());
        }, HOST_CALL_TIMEOUT_MS);
    });
    try {
        return await Promise.race([call, deadline]);
    } finally {
        clearTimeout(timer);
    }
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
    // truapi 0.17 (codec 2): the allowance's derivation index is a tagged
    // union — `Index` for plain enumerable indices, `Raw` for 32-byte indices.
    { tag: "SmartContractAllowance", value: { tag: "Index", value: PRODUCT_ACCOUNT_DERIVATION_INDEX } },
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

// DotNS top-level domains a product account can live under. The TLD is
// network-specific: Paseo registers `<name>.paseo` (see `playground deploy
// --help`, whose default env is paseo-next-v2), production registers
// `<name>.dot`. Ordered longest-first is unnecessary here, but keep them
// distinct — the suffix decides which branch below claims a hostname.
const DOT_NS_TLDS = ["dot", "paseo"] as const;

// Map the serving URL back to the canonical `<name>.<tld>` identifier the host
// derived this app's product account from. This MUST match the host's own
// derivation: the host enforces account[0] === identifier at signing time, so a
// mismatch means the host rejects the product account (truapi reports it as
// `DomainNotValid`). Override with VITE_PRODUCT_ACCOUNT_ID for anything unusual.
//
// Derived structurally rather than from a hardcoded gateway list, so production
// and test/preview gateways all resolve without a code change:
//
//   localhost:5173       → "localhost:5173"  (dev; needs Polkadot Desktop v0.3.2-rc-2+)
//   app.<name>.<tld>     → "<name>.<tld>"    (Desktop serves the `app.` subname)
//   <name>.<tld>         → "<name>.<tld>"    (direct Polkadot Browser navigation)
//   <name>.<gateway>     → "<name>.<tld>"    (ANY gateway serves the app from a
//                                             subdomain whose first label is the
//                                             product name: dot.li, dotli.dev,
//                                             app.paseo.li, paseoli.dev, …)
//
// The gateway case can't read the TLD off the hostname, because the gateway
// domain replaces it (`foo.paseoli.dev` serves `foo.paseo`). We infer it from
// the gateway domain instead: a Paseo gateway is the one with "paseo" in its
// name, matching how `paseoli.dev` / `paseo.li` mirror `dot.li` for production.
// If a future gateway breaks that convention, set VITE_PRODUCT_ACCOUNT_ID.
function getProductAccountIdentifier(): string {
    const configuredIdentifier = import.meta.env.VITE_PRODUCT_ACCOUNT_ID?.trim();
    if (configuredIdentifier) return configuredIdentifier;

    const { host, hostname } = window.location;
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return host;

    // A hostname already under a DotNS TLD is the identifier; strip Desktop's
    // `app.` subname so we return the enforced base name.
    for (const tld of DOT_NS_TLDS) {
        if (hostname.endsWith(`.${tld}`)) {
            const appSubname = new RegExp(String.raw`^app\.(.+\.${tld})$`).exec(hostname);
            return appSubname ? appSubname[1] : hostname;
        }
    }

    // Otherwise it's a gateway serving `<name>.<gateway-domain>`: the product
    // name is the leading label. Skip IPv4 literals (first label is numeric).
    const [firstLabel, ...gatewayLabels] = hostname.split(".");
    if (firstLabel && gatewayLabels.length > 0 && !/^\d+$/.test(firstLabel)) {
        const tld = gatewayLabels.join(".").includes("paseo") ? "paseo" : "dot";
        return `${firstLabel}.${tld}`;
    }
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
        // We only override createProvider to set requestChainSubmitPermission
        // (SignerManager has no option for it). Everything else this factory
        // builds has to be passed explicitly: SignerManager's *default* factory
        // injects dappName for us, but supplying createProvider bypasses that
        // branch entirely, so the provider must declare the app identity itself.
        // Omitting it is what produces "no productAccount or dappName
        // configured; resolving connect() with empty accounts" and leaves the
        // host with no app scope to derive against.
        //
        // productAccount is the documented path for an app that signs solely
        // with its per-app derived account (this template): connect() then
        // returns that single account directly and populates its name.
        createProvider: type => {
            if (type !== "host") return new DevProvider({ ss58Prefix: 42 });
            return new HostProvider({
                ss58Prefix: 42,
                dappName: this.productAccountIdentifier,
                productAccount: {
                    dotNsIdentifier: this.productAccountIdentifier,
                    derivationIndex: PRODUCT_ACCOUNT_DERIVATION_INDEX,
                    // requestName (default true) additionally calls getUserId() to
                    // populate the owner name in the header chip. Per the SDK docs
                    // that triggers a host *identity-permission prompt*, and it runs
                    // in the same Promise.all as the account fetch — so an unanswered
                    // prompt stalls the whole connect. If ?debug shows the hang is on
                    // getUserId, set this to false: the chip then falls back to the
                    // truncated address and the name can be fetched later on demand.
                    requestName: true,
                },
                // Defer the host's ChainSubmit ("broadcast signed transactions
                // to any Substrate chain") permission. The SDK otherwise
                // requests it eagerly at connect, prompting the user on load —
                // this app only signs raw messages and never submits
                // transactions. Note the SDK docs warn that without ChainSubmit
                // the host may reject signing with PermissionDenied; if the sign
                // demo starts failing that way, drop this line first.
                requestChainSubmitPermission: false,
            });
        },
    });
    private readonly subscribers = new Set<(state: SignerState) => void>();
    private readonly resourceSubscribers = new Set<(state: ResourceAllocationState) => void>();
    private state = initialState();
    private resourceAllocationState = initialResourceAllocationState();
    private connectPromise: Promise<Result<SignerAccount[], SignerError>> | null = null;
    private disposed = false;
    private readonly teardowns: Array<() => void> = [];

    constructor() {
        // connecting/connected transitions are owned by connect() since the wrapper
        // exposes a derived product account. Only mirror mid-session disconnects, and
        // guard against re-firing when connectInner already set disconnected.
        this.teardowns.push(
            this.manager.subscribe(underlyingState => {
                if (underlyingState.status === "disconnected" && this.state.status !== "disconnected") {
                    this.transitionToDisconnected(underlyingState.error);
                }
            }),
        );
        void this.watchHostConnection();
    }

    // Auto-reconnect: the host reports when a wallet session appears (the user
    // logs in / pairs a phone) or drops. On the first load the initial connect()
    // may fail with NotConnected because no wallet is connected yet; when the
    // user then logs in, this re-derives the product account without a page
    // reload. Independent of the SignerManager lifecycle (uses the shared host
    // transport), so it survives connect()'s failure teardown. No-op outside a
    // host container (getAccountsProvider is null).
    private async watchHostConnection() {
        const accounts = await getAccountsProvider();
        if (!accounts || this.disposed) return;
        const subscription = accounts.subscribeAccountConnectionStatus(status => {
            if (status === "Connected") {
                // connect() is a no-op while already connected or connecting, so
                // a redundant "Connected" event can't stack duplicate attempts.
                if (this.state.status === "disconnected") void this.connect();
            } else if (status === "Disconnected" && this.state.status !== "disconnected") {
                this.transitionToDisconnected(null);
            }
        });
        this.teardowns.push(() => subscription.unsubscribe());
    }

    // Detach long-lived listeners. Called from the HMR dispose hook so a dev
    // hot-reload doesn't leave the previous singleton's subscriptions attached
    // (each would keep firing into a dead instance and stack duplicates).
    dispose() {
        this.disposed = true;
        for (const teardown of this.teardowns.splice(0)) teardown();
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

        const connection = await withHostTimeout(
            this.manager.connect("host"),
            "connect",
            () => err(new TimeoutError("connect", HOST_CALL_TIMEOUT_MS)),
        );
        if (!connection.ok) {
            this.transitionToDisconnected(connection.error);
            return connection;
        }
        const ownerName = connection.value[0]?.name ?? null;

        const productAccount = await withHostTimeout(
            this.manager.getProductAccount(
                this.productAccountIdentifier,
                PRODUCT_ACCOUNT_DERIVATION_INDEX,
            ),
            "getProductAccount",
            () => err(new TimeoutError("getProductAccount", HOST_CALL_TIMEOUT_MS)),
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

// Without this, every dev hot-reload constructs a fresh singleton whose
// subscriptions stack on top of the previous instances' (which never get torn
// down), so one host event fans out to N stale managers.
if (import.meta.hot) {
    import.meta.hot.dispose(() => signerManager.dispose());
}

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
