export function shouldConsumeWheelEvent(
  scroller,
  { deltaX = 0, deltaY = 0, shiftKey = false } = {},
) {
  if (!scroller) {
    return false;
  }

  if (isHorizontalWheelIntent({ deltaX, deltaY, shiftKey })) {
    return canScrollHorizontally(scroller, horizontalWheelDelta({ deltaX, deltaY, shiftKey }));
  }

  if (deltaY === 0) {
    return false;
  }

  return canScrollVertically(scroller, deltaY);
}

export function bindWheelScrollPassthrough(getScrollers, getBoundary = getScrollers) {
  const onWheelCapture = (event) => {
    const boundary = resolveRef(getBoundary);
    if (!boundary || (!boundary.contains(event.target) && boundary !== event.target)) {
      return;
    }

    const scrollers = resolveRefList(getScrollers);
    for (const scroller of scrollers) {
      if (!shouldConsumeWheelEvent(scroller, event)) {
        continue;
      }

      event.stopPropagation();
      if (isHorizontalWheelIntent(event)) {
        event.preventDefault();
        scroller.scrollLeft += horizontalWheelDelta(event);
      }
      return;
    }
  };

  document.addEventListener("wheel", onWheelCapture, { capture: true, passive: false });
  return () =>
    document.removeEventListener("wheel", onWheelCapture, { capture: true, passive: false });
}

function isHorizontalWheelIntent({ deltaX = 0, deltaY = 0, shiftKey = false } = {}) {
  return Math.abs(deltaX) > Math.abs(deltaY) || (shiftKey && deltaY !== 0);
}

function horizontalWheelDelta({ deltaX = 0, deltaY = 0, shiftKey = false } = {}) {
  return shiftKey ? deltaY : deltaX;
}

function canScrollVertically(scroller, deltaY) {
  if (!hasVerticalOverflow(scroller)) {
    return false;
  }

  const scrollTop = Number(scroller.scrollTop) || 0;
  const clientHeight = Number(scroller.clientHeight) || 0;
  const scrollHeight = Number(scroller.scrollHeight) || 0;
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);

  if (deltaY > 0) {
    return scrollTop < maxScrollTop - 1;
  }
  return scrollTop > 1;
}

function canScrollHorizontally(scroller, deltaX) {
  if (!hasHorizontalOverflow(scroller)) {
    return false;
  }

  const scrollLeft = Number(scroller.scrollLeft) || 0;
  const clientWidth = Number(scroller.clientWidth) || 0;
  const scrollWidth = Number(scroller.scrollWidth) || 0;
  const maxScrollLeft = Math.max(0, scrollWidth - clientWidth);

  if (deltaX > 0) {
    return scrollLeft < maxScrollLeft - 1;
  }
  return scrollLeft > 1;
}

function hasVerticalOverflow(scroller) {
  const height = Number(scroller.clientHeight) || 0;
  const scrollHeight = Number(scroller.scrollHeight) || 0;
  return scrollHeight > height + 1;
}

function hasHorizontalOverflow(scroller) {
  const width = Number(scroller.clientWidth) || 0;
  const scrollWidth = Number(scroller.scrollWidth) || 0;
  return scrollWidth > width + 1;
}

function resolveRef(value) {
  return typeof value === "function" ? value() : value;
}

function resolveRefList(value) {
  const resolved = resolveRef(value);
  if (!resolved) {
    return [];
  }
  return Array.isArray(resolved) ? resolved.filter(Boolean) : [resolved];
}
