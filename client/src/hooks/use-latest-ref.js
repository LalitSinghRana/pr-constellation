import { useLayoutEffect, useRef } from "react";

export function useLatestRef(value) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
