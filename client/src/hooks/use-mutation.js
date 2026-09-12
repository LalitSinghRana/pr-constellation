import { useCallback, useReducer } from "react";
import { useLatestRef } from "./use-latest-ref.js";

/**
 * Minimal mutation hook (not TanStack Query).
 * Consolidates idle/pending/success/error for imperative writes.
 */

const initialState = {
  status: "idle",
  data: undefined,
  error: undefined,
  variables: undefined,
};

function mutationReducer(state, action) {
  switch (action.type) {
    case "pending":
      return {
        status: "pending",
        data: undefined,
        error: undefined,
        variables: action.variables,
      };
    case "success":
      return {
        status: "success",
        data: action.data,
        error: undefined,
        variables: action.variables,
      };
    case "error":
      return {
        status: "error",
        data: undefined,
        error: action.error,
        variables: action.variables,
      };
    case "reset":
      return initialState;
    default:
      return state;
  }
}

function toError(value) {
  return value instanceof Error ? value : new Error(String(value ?? "Request failed"));
}

/**
 * @param {{
 *   mutationFn: (variables: unknown) => Promise<unknown>,
 *   onSuccess?: (data: unknown, variables: unknown) => void | Promise<void>,
 *   onError?: (error: Error, variables: unknown) => void,
 * }} options
 */
export function useMutation({ mutationFn, onSuccess, onError } = {}) {
  const [state, dispatch] = useReducer(mutationReducer, initialState);
  const mutationFnRef = useLatestRef(mutationFn);
  const onSuccessRef = useLatestRef(onSuccess);
  const onErrorRef = useLatestRef(onError);

  const mutateAsync = useCallback(
    async (variables) => {
      dispatch({ type: "pending", variables });
      try {
        const data = await mutationFnRef.current(variables);
        dispatch({ type: "success", data, variables });
        await onSuccessRef.current?.(data, variables);
        return data;
      } catch (caught) {
        const error = toError(caught);
        dispatch({ type: "error", error, variables });
        onErrorRef.current?.(error, variables);
        throw error;
      }
    },
    [mutationFnRef, onErrorRef, onSuccessRef],
  );

  const mutate = useCallback(
    (variables) => {
      void mutateAsync(variables).catch(() => {});
    },
    [mutateAsync],
  );

  const reset = useCallback(() => {
    dispatch({ type: "reset" });
  }, []);

  return {
    data: state.data,
    error: state.error,
    status: state.status,
    variables: state.variables,
    isIdle: state.status === "idle",
    isPending: state.status === "pending",
    isSuccess: state.status === "success",
    isError: state.status === "error",
    mutate,
    mutateAsync,
    reset,
  };
}
