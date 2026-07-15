import { useEffect, useState } from "react";
import { createChainClient } from "@parity/product-sdk-chain-client";
import { isChainSupported } from "@parity/product-sdk-host";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";

// How long to wait for the first block before giving up. The host relays chain
// reads, so a chain that's enabled but not serving blocks would otherwise hang
// on "connecting" forever.
const FIRST_BLOCK_TIMEOUT_MS = 12_000;

// Demo chain read: subscribe to Paseo Asset Hub's current block number through
// the sanctioned chain-client (host-routed — never a direct RPC endpoint). The
// network is hardcoded to Paseo: the descriptor's genesis hash is what selects
// the chain (there are no endpoints/URLs to configure), and importing only
// paseo_asset_hub keeps the build to a single metadata chunk. The host must
// support the chosen chain's genesis hash — Summit is not enabled in current
// host builds, so it rejects with "Chain ... is not supported".
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
        const genesis = paseo_asset_hub.genesis as `0x${string}`;

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

        const timer = setTimeout(() => {
            fail(
                new Error(
                    "Timed out waiting for a block. The host may not serve this chain " +
                        `(genesis ${genesis}).`,
                ),
            );
        }, FIRST_BLOCK_TIMEOUT_MS);

        (async () => {
            // The host relays chain reads and only serves chains enabled in its
            // build. Probe support first so an unsupported chain fails fast with
            // a clear message instead of hanging.
            const supported = await isChainSupported(genesis);
            if (cancelled) return;
            if (supported.ok && !supported.value) {
                throw new Error(
                    `Host does not support Paseo Asset Hub (genesis ${genesis}).`,
                );
            }

            const chainClient = await createChainClient({ chains: { assetHub: paseo_asset_hub } });
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
