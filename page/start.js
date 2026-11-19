(async () => {
  await magpie.ready;
  let opts = await magpie.options.get();
  if (!opts.uiKey) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const uiKey = Array.from(bytes, (n) => n.toString(16).padStart(2, '0')).join('');
    try {
      await magpie.options.set({ ...opts, uiKey, pageHostPort: opts.port || 34891 });
    } catch (error) {
      // Another open window may have paired first.
      opts = await magpie.options.get();
      if (!opts.uiKey) throw error;
    }
    // Loading Magpie's page entry again warms the host with its new options.
    location.replace(location.href);
    return;
  }
  const url = new URL(
    magpie.service || 'http://127.0.0.1:' + (opts.port || 34891) + '/',
    location.href,
  );
  url.hash = new URLSearchParams({ access: opts.uiKey });
  location.replace(url.href);
})().catch((e) => {
  document.querySelector('#status').textContent = e.message;
});
