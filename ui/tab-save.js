// Send a splice against the last acknowledged JSON, so editing a small field
// in a long conversation does not require resending the entire prompt.
function patch(base, text) {
  let at = 0,
    end = base.text.length,
    nextEnd = text.length;
  while (at < end && at < nextEnd && base.text[at] === text[at]) at++;
  while (end > at && nextEnd > at && base.text[end - 1] === text[nextEnd - 1]) {
    end--;
    nextEnd--;
  }
  return { base: base.revision, at, remove: end - at, text: text.slice(at, nextEnd) };
}
function revision() {
  return Array.from(crypto.getRandomValues(new Uint32Array(4)), (n) =>
    n.toString(16).padStart(8, '0'),
  ).join('');
}
export function draftWriter(tab, read, write, status) {
  let base = { revision: tab.revision, text: JSON.stringify(tab.state) };
  let changed = false,
    timer,
    sending,
    attempted,
    disposed = false,
    failed = false;
  function packet(text) {
    const patches = [patch(base, text)];
    // A lost response or a still-running write may already have committed.
    if (attempted && attempted.revision !== base.revision) patches.push(patch(attempted, text));
    return { id: tab.id, revision: revision(), patches };
  }
  async function flush() {
    clearTimeout(timer);
    while (!disposed && (sending || changed)) {
      if (sending) {
        await sending;
        continue;
      }
      changed = false;
      const text = JSON.stringify(read());
      if (text === base.text && !attempted) {
        status('');
        continue;
      }
      const req = packet(text);
      attempted = { revision: req.revision, text };
      sending = write(req)
        .then(() => {
          base = { revision: req.revision, text };
          attempted = null;
          failed = false;
          if (!disposed && !changed) status('Saved');
        })
        .catch((error) => {
          changed = true;
          failed = true;
          if (!disposed) status('Save failed', error.message);
          throw error;
        })
        .finally(() => {
          sending = null;
        });
      await sending;
    }
    return base.revision;
  }
  function exitPacket() {
    if (disposed || (!changed && !sending)) return null;
    const text = JSON.stringify(read());
    if (!changed && sending && attempted?.text === text)
      return { id: tab.id, revision: attempted.revision, patches: [patch(base, text)] };
    return packet(text);
  }
  return {
    mark() {
      if (disposed) return;
      changed = true;
      status('Saving…');
      clearTimeout(timer);
      timer = setTimeout(() => flush().catch(() => {}), 160);
    },
    flush,
    leaving() {
      const req = exitPacket();
      if (req) return write(req, true);
    },
    needsUnloadWarning() {
      if (disposed) return false;
      if (failed) return true;
      const req = exitPacket();
      // Browsers cap the combined outstanding keepalive payload at 64 KiB.
      return !!req && new Blob([JSON.stringify(req)]).size >= 60000;
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
    },
  };
}
