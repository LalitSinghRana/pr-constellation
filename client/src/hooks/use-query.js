import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useLatestRef } from "./use-latest-ref.js";

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
  const queryFnRef = useLatestRef(queryFn);
  const queryKeyRef = useLatestRef(queryKey);
  const previousKeyRef = useRef(null);
  const requestIdRef = useRef(0);
  const settleRef = useRef(null);

  useEffect(() => {
    // reloadToken is intentionally in the dependency list so refetch() re-runs this effect.
    void reloadToken;

    if (!enabled) {
      requestIdRef.current += 1;
      previousKeyRef.current = null;
      dispatch({ type: "idle" });
      if (settleRef.current) {
        const resolve = settleRef.current;
        settleRef.current = null;
        resolve(undefined);
      }
      return;
    }

    const resetData = previousKeyRef.current !== key;
    previousKeyRef.current = key;
    const requestId = ++requestIdRef.current;
    const controller = new AbortController();
    dispatch({ type: "pending", resetData });

    const settle = (result) => {
      if (requestId !== requestIdRef.current) return;
      if (settleRef.current) {
        const resolve = settleRef.current;
        settleRef.current = null;
        resolve(result);
      }
    };

    void (async () => {
      try {
        const data = await queryFnRef.current({
          queryKey: queryKeyRef.current,
          signal: controller.signal,
        });
        if (requestId !== requestIdRef.current) return;
        dispatch({ type: "success", data });
        settle(data);
      } catch (caught) {
        if (controller.signal.aborted || caught?.name === "AbortError") {
          settle(undefined);
          return;
        }
        if (requestId !== requestIdRef.current) return;
        dispatch({ type: "error", error: toError(caught) });
        settle(undefined);
      }
    })();

    return () => {
      requestIdRef.current += 1;
      controller.abort();
    };
  }, [enabled, key, queryFnRef, queryKeyRef, reloadToken]);

  const refetch = useCallback(() => {
    if (!enabled) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      settleRef.current = resolve;
      setReloadToken((token) => token + 1);
    });
  }, [enabled]);

  return {
    data: state.data,
    error: state.error,
    status: state.status,
    isLoading: state.status === "pending" && state.data === undefined,
    // isPending: request in flight. isLoading: in flight with nothing to render yet.
    isPending: state.status === "pending",
    isSuccess: state.status === "success",
    isError: state.status === "error",
    isIdle: state.status === "idle",
    refetch,
  };
}
