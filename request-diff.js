import { structuredPatch } from 'diff';

export function requestPatch(before, after, raw = false) {
  const oldText = JSON.stringify(JSON.parse(before), null, 2) + '\n';
  const newText = (raw ? after : JSON.stringify(JSON.parse(after), null, 2)) + '\n';
  const patch = structuredPatch(
    'a/request.json',
    'b/request.json',
    oldText,
    newText,
    undefined,
    undefined,
    { context: 3, timeout: 500 },
  );
  if (!patch) throw Error('These requests differ too extensively to generate a preview.');
  return patch.hunks;
}
