import { useEffect, useState } from "react";
import { createChainClient } from "@parity/product-sdk-chain-client";
import { isChainSupported } from "@parity/product-sdk-host";
import { ss58ToH160 } from "@parity/product-sdk-address";
import type { devnet_asset_hub } from "@parity/product-sdk-descriptors/devnet-asset-hub";
import type { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";

// How long to wait for the first block before giving up. The host relays chain
// reads, so a chain that's enabled but not serving blocks would otherwise hang
// on "connecting" forever.
const FIRST_BLOCK_TIMEOUT_MS = 12_000;

// Demo chain read: subscribe to the sample network's current block number
// through the sanctioned chain-client (host-routed — never a direct RPC
// endpoint). The descriptor's genesis hash is what selects the chain (there
// are no endpoints/URLs to configure), and loading the descriptor dynamically
// keeps each build to a single metadata chunk. The host must support the
// chosen chain's genesis hash — a chain the host build doesn't enable rejects
// with "Chain ... is not supported".
//
// Networks: "devnet" (default) is the public products devnet on the Paseo
// testnet Asset Hub (para 1000). "paseo-next" is the Paseo Next v2 preview
// network (para 1500) — that's what the CDM `paseo` preset targets, NOT the
// Paseo testnet. Select with VITE_NETWORK (see .env.example).

type DemoDescriptor = typeof devnet_asset_hub | typeof paseo_asset_hub;

interface NetworkConfig {
    label: string;
    loadDescriptor(): Promise<DemoDescriptor>;
}

// `import.meta.env.VITE_NETWORK` is inlined as a literal at build time, so this
// comparison folds and the unselected network's ~880 kB metadata chunk is
// dropped from the bundle. Keep it a direct literal comparison — routing the
// choice through a lookup table or a normalizing helper leaves both import()s
// reachable, so the build emits both metadata chunks (~+1 MB in dist/, uploaded
// to Bulletin on every deploy and never fetched).
export const NETWORK: NetworkConfig =
    import.meta.env.VITE_NETWORK === "paseo-next"
        ? {
              label: "Paseo Next Asset Hub",
              loadDescriptor: async () =>
                  (await import("@parity/product-sdk-descriptors/paseo-asset-hub")).paseo_asset_hub,
          }
        : {
              label: "Devnet Asset Hub",
              loadDescriptor: async () =>
                  (await import("@parity/product-sdk-descriptors/devnet-asset-hub")).devnet_asset_hub,
          };

// Dev only: a typo'd VITE_NETWORK silently falls back to devnet, so say so
// while developing. Kept out of the selection above to preserve the fold.
if (import.meta.env.DEV) {
    const raw = import.meta.env.VITE_NETWORK;
    if (raw && raw !== "devnet" && raw !== "paseo-next") {
        console.warn(`[Chain] Unknown VITE_NETWORK "${raw}", falling back to devnet`);
    }
}
export interface ChainBlockState {
    status: "connecting" | "live" | "error";
    block: number | null;
    error: string | null;
}

export function useChainBlock(): ChainBlockState {
    const [state, setState] = useState<ChainBlockState>({
        status: "connecting",
        block: null,
        error: null,
    });

    useEffect(() => {
        let cancelled = false;
        let client: { destroy(): void } | null = null;
        let subscription: { unsubscribe(): void } | null = null;

        const setBlock = (value: number) => {
            if (!cancelled) setState({ status: "live", block: value, error: null });
        };
        const fail = (cause: unknown) => {
            // Only surface an error if we never read a block. A dropped
            // subscription after a good read keeps the last value on screen.
            setState(prev =>
                cancelled || prev.status === "live"
                    ? prev
                    : {
                          status: "error",
                          block: null,
                          error: cause instanceof Error ? cause.message : String(cause),
                      },
            );
        };

        // Captured once the descriptor resolves so the timeout can name the
        // genesis the host failed to serve — the actionable value here.
        let genesisHash: string | null = null;

        const timer = setTimeout(() => {
            fail(
                new Error(
                    "Timed out waiting for a block. The host may not serve this chain " +
                        `(${NETWORK.label}${genesisHash ? `, genesis ${genesisHash}` : ""}).`,
                ),
            );
        }, FIRST_BLOCK_TIMEOUT_MS);

        (async () => {
            const descriptor = await NETWORK.loadDescriptor();
            const genesis = descriptor.genesis as `0x${string}` | undefined;
            if (!genesis) {
                throw new Error(`${NETWORK.label} descriptor is missing its genesis hash.`);
            }
            genesisHash = genesis;

            // The host relays chain reads and only serves chains enabled in its
            // build. Probe support first so an unsupported chain fails fast with
            // a clear message instead of hanging.
            const supported = await isChainSupported(genesis);
            if (cancelled) return;
            if (supported.ok && !supported.value) {
                throw new Error(
                    `Host does not support ${NETWORK.label} (genesis ${genesis}).`,
                );
            }

            const chainClient = await createChainClient({ chains: { assetHub: descriptor } });
            if (cancelled) {
                chainClient.destroy();
                return;
            }
            client = chainClient;
            const blockNumber = chainClient.assetHub.query.System.Number;
            // Resolve the current block immediately (watchValue only emits on the
            // *next* block, so on its own it can sit at "connecting"), then stream
            // updates. watchValue returns an RxJS Observable. We track the
            // *finalized* block: it advances monotonically and at a steady cadence,
            // whereas "best" jumps around on forks/reorgs.
            const current = await blockNumber.getValue({ at: "finalized" });
            if (cancelled) return;
            clearTimeout(timer);
            setBlock(Number(current));
            subscription = blockNumber.watchValue({ at: "finalized" }).subscribe({
                next: ({ value }) => setBlock(Number(value)),
                error: fail,
            });
        })().catch(cause => {
            clearTimeout(timer);
            // Tear down the connection if we got one before failing, so a
            // mounted error state doesn't hold an unused chain client open.
            client?.destroy();
            client = null;
            fail(cause);
        });

        return () => {
            cancelled = true;
            clearTimeout(timer);
            subscription?.unsubscribe();
            client?.destroy();
        };
    }, []);

    return state;
}

// PGAS balance, as held on the sample network's Asset Hub. PGAS is the Hub's gas/fee token —
// `Pgas.PgasAssetId` is its asset id and the balance lives in `Assets.Account`.
export interface PgasBalance {
    /** Raw balance in the token's smallest unit. */
    planck: bigint;
    /** Token decimals, from `Assets.Metadata` — pass to formatPlanck. */
    decimals: number;
    /** Token symbol, from `Assets.Metadata` (e.g. "PGAS"). */
    symbol: string;
}

export interface ProductAccountChainInfo {
    status: "idle" | "loading" | "ready" | "error";
    // Is the account's H160 registered in `Revive.OriginalAccount`? Mapping is a
    // prerequisite for any PolkaVM/EVM contract call on Asset Hub. null until known.
    mapped: boolean | null;
    // The account's PGAS balance. null until the host allowance is granted (that's
    // what provisions gas) or if the read is still pending / unavailable.
    pgas: PgasBalance | null;
    error: string | null;
}

// One-shot on-chain reads for the product account on the sample Asset Hub: whether
// it's mapped, and — once the host allowance has been granted — its PGAS
// balance. Reuses the host-routed client that `createChainClient` memoizes (the
// same one `useChainBlock` opens); it deliberately does NOT destroy that client,
// since teardown is global and owned by useChainBlock's unmount. Reads are
// point-in-time (no subscription): mapping and gas provisioning change rarely,
// and the effect re-runs when `allowanceGranted` flips to pull the PGAS balance.
export function useProductAccountChainInfo(
    address: string | null,
    allowanceGranted: boolean,
): ProductAccountChainInfo {
    const [state, setState] = useState<ProductAccountChainInfo>({
        status: "idle",
        mapped: null,
        pgas: null,
        error: null,
    });

    useEffect(() => {
        if (!address) {
            setState({ status: "idle", mapped: null, pgas: null, error: null });
            return;
        }
        let cancelled = false;
        setState(prev => ({ ...prev, status: "loading", error: null }));

        (async () => {
            const client = await createChainClient({ chains: { assetHub: await NETWORK.loadDescriptor() } });
            if (cancelled) return;
            const api = client.assetHub;

            const mappedTo = await api.query.Revive.OriginalAccount.getValue(ss58ToH160(address));
            if (cancelled) return;

            let pgas: PgasBalance | null = null;
            if (allowanceGranted) {
                const assetId = await api.constants.Pgas.PgasAssetId();
                const [account, metadata] = await Promise.all([
                    api.query.Assets.Account.getValue(assetId, address),
                    api.query.Assets.Metadata.getValue(assetId),
                ]);
                if (cancelled) return;
                pgas = {
                    planck: account?.balance ?? 0n,
                    decimals: metadata.decimals,
                    symbol: new TextDecoder().decode(metadata.symbol),
                };
            }

            setState({ status: "ready", mapped: mappedTo !== undefined, pgas, error: null });
        })().catch(cause => {
            if (cancelled) return;
            setState({
                status: "error",
                mapped: null,
                pgas: null,
                error: cause instanceof Error ? cause.message : String(cause),
            });
        });

        return () => {
            cancelled = true;
        };
    }, [address, allowanceGranted]);

    return state;
}
