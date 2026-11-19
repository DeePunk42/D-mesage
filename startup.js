// During a Magpie update the previous host can still be draining requests.
// Return control to the loader while waiting for its loopback port to be released.
export function bindWhenFree(bind, { waiting, ready, failed } = {}) {
  let listener,
    timer,
    delay = 160;
  function attempt() {
    try {
      listener = bind();
    } catch (error) {
      if (error.code !== 'EADDRINUSE') {
        if (!timer) throw error;
        failed?.(error);
        return;
      }
      if (!timer) waiting?.(error);
      timer = setTimeout(attempt, delay);
      timer.unref();
      delay = Math.min(delay * 2, 3000);
      return;
    }
    ready?.(listener);
  }
  attempt();
  return () => {
    clearTimeout(timer);
    listener?.stop(true);
  };
}
