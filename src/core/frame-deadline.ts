/** Complete a timed wait even if the browser delays its timer while rendering frames. */
export function scheduleFrameDeadline(milliseconds: number, complete: () => void): () => void {
  const delay = Math.max(0, milliseconds);
  const deadline = performance.now() + delay;
  let frame: number | undefined;
  const cancel = () => {
    clearTimeout(timer);
    if (frame !== undefined) cancelAnimationFrame(frame);
  };
  const finish = () => {
    cancel();
    complete();
  };
  const timer = setTimeout(finish, delay);
  if (Number.isFinite(delay) && typeof requestAnimationFrame === 'function') {
    const tick = (now: number) => {
      frame = undefined;
      if (now >= deadline) finish();
      else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  }
  return cancel;
}
