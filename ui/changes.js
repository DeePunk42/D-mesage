import { el } from './views.js';

export function changesView(hunks) {
  if (!hunks.length) return el('p', 'No request changes.', 'hint');
  const panel = el('div', '', 'requestDiff');
  panel.setAttribute('aria-label', 'Unified request diff');
  for (const hunk of hunks) {
    panel.append(
      el(
        'code',
        `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
        'hunkHeader',
      ),
    );
    let oldLine = hunk.oldStart,
      newLine = hunk.newStart;
    for (const line of hunk.lines) {
      const sign = line[0];
      const row = el(
        'div',
        '',
        `diffLine ${sign === '+' ? 'addition' : sign === '-' ? 'deletion' : 'context'}`,
      );
      row.append(
        el('small', sign === '+' ? '' : String(oldLine++)),
        el('small', sign === '-' ? '' : String(newLine++)),
        el('span', sign),
        el('code', line.slice(1)),
      );
      panel.append(row);
    }
  }
  return panel;
}
