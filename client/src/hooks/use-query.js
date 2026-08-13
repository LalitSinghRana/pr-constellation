import { useCallback, useEffect, useReducer, useRef, useState } from "react";

/**
 * Minimal async-state hook (not TanStack Query).
 * Covers the classic fetch-in-useEffect pitfalls:
 * race conditions, loading, empty vs unloaded, key-change resets,
 * StrictMode double-invoke, and AbortSignal for cancellation.
 * HTTP !res.ok handling belongs in queryFn (see readJson).
 */

const initialState = {
  status: "pending",
  data: undefined,
  error: undefined,
};

function queryReducer(state, action) {
  switch (action.type) {
    case "idle":
      return { status: "idle", data: undefined, error: undefined };
    case "pending":
      return {
        status: "pending",
        data: action.resetData ? undefined : state.data,
        error: undefined,
      };
    case "success":
      return { status: "success", data: action.data, error: undefined };
    case "error":
      return { status: "error", data: undefined, error: action.error };
    default:
      return state;
  }
}

function serializeQueryKey(queryKey) {
  return JSON.stringify(queryKey ?? null);
}

function toError(value) {
  return value instanceof Error ? value : new Error(String(value ?? "Request failed"));
}

/** Throw on non-OK responses, then parse JSON. Use inside queryFn. */
export async function readJson(response) {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      typeof body.error === "string" && body.error
        ? body.error
        : `Request failed (${response.status})`,
    );
  }
  return response.json();
}

/**
 * @param {{
 *   queryKey: unknown,
 *   queryFn: (context: { queryKey: unknown, signal: AbortSignal }) => Promise<unknown>,
 *   enabled?: boolean,
 * }} options
 */
export function useQuery({ queryKey, queryFn, enabled = true }) {
  const key = serializeQueryKey(queryKey);
  const [state, dispatch] = useReducer(queryReducer, initialState);
  const [reloadToken, setReloadToken] = useState(0);
  const queryFnRef = useRef(queryFn);
  const queryKeyRef = useRef(queryKey);
  const previousKeyRef = useRef(null);
  const requestIdRef = useRef(0);
  const settleRef = useRef(null);

  queryFnRef.current = queryFn;
  queryKeyRef.current = queryKey;

  useEffect(() => {
    // reloadToken is intentionally in the dependency list so refetch() re-runs this effect.
    void reloadToken;

    if (!enabled) {
      requestIdRef.current += 1;
      previousKeyRef.current = null;
      dispatch({ type: "idle" });
      settleRef.current?.();
      settleRef.current = null;
      return;
    }

    const resetData = previousKeyRef.current !== key;
    previousKeyRef.current = key;
    const requestId = ++requestIdRef.current;
    const controller = new AbortController();
    dispatch({ type: "pending", resetData });

    const settle = () => {
      if (requestId !== requestIdRef.current) return;
      settleRef.current?.();
      settleRef.current = null;
    };

    void (async () => {
      try {
        const data = await queryFnRef.current({
          queryKey: queryKeyRef.current,
          signal: controller.signal,
        });
        if (requestId !== requestIdRef.current) return;
        dispatch({ type: "success", data });
        settle();
      } catch (caught) {
        if (requestId !== requestIdRef.current) return;
        if (controller.signal.aborted || caught?.name === "AbortError") {
          settle();
          return;
        }
        dispatch({ type: "error", error: toError(caught) });
        settle();
      }
    })();

    return () => {
      requestIdRef.current += 1;
      controller.abort();
    };
  }, [enabled, key, reloadToken]);

  const refetch = useCallback(() => {
    if (!enabled) return Promise.resolve();
    return new Promise((resolve) => {
      settleRef.current = resolve;
      setReloadToken((token) => token + 1);
    });
  }, [enabled]);

  return {
    data: state.data,
    error: state.error,
    status: state.status,
    isLoading: state.status === "pending",
    isPending: state.status === "pending",
    isSuccess: state.status === "success",
    isError: state.status === "error",
    isIdle: state.status === "idle",
    refetch,
  };
}
