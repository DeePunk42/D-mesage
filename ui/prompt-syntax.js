const fenceLine = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?$/gm;
const maxHighlightLength = 180000;

export function* promptSections(text) {
  let open;
  let end = 0;
  for (const match of text.matchAll(fenceLine)) {
    const [, marker, suffix] = match;
    if (open) {
      if (marker[0] !== open.marker[0] || marker.length < open.marker.length || suffix.trim())
        continue;
      const closeEnd = match.index + match[0].length;
      yield { ...open, codeEnd: match.index, end: closeEnd };
      end = closeEnd;
      open = undefined;
    } else if (!(marker[0] === '`' && suffix.includes('`'))) {
      if (match.index > end) yield { start: end, end: match.index };
      const lineEnd = match.index + match[0].length;
      open = {
        start: match.index,
        codeStart: lineEnd + Number(text[lineEnd] === '\n'),
        marker,
        label: suffix.trim(),
      };
    }
  }
  if (open)
    yield {
      ...open,
      codeStart: Math.min(open.codeStart, text.length),
      codeEnd: text.length,
      end: text.length,
    };
  else if (end < text.length) yield { start: end, end: text.length };
}

const structuralPatterns = [
  /(?<escape>\\[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e])/,
  /(?<code>(?<!`)(?<ticks>`+)(?!`)[^\r\n]*?(?<!`)\k<ticks>(?!`))/,
  /(?<tag><(?<tagName>\/?[\p{L}_][\p{L}\p{N}_.:-]*)(?<attrs>(?:[ \t]+[\p{L}_][\p{L}\p{N}_.:-]*[ \t]*=[ \t]*(?:"[^"]*"|'[^']*'))*[ \t]*)\/?>)/u,
  /(?<link>!?\[(?:\\.|[^\[\]\\\r\n]){0,256}\](?:\((?:\\.|[^()\\\r\n]|\([^()\r\n]*\)){0,512}\)|\[[^\[\]\r\n]{0,256}\]))/,
  /(?<bracket>\[\[\/?[\p{L}_][\p{L}\p{N}_.:/ -]{0,59}\]\]|\[\/?[\p{L}_][\p{L}\p{N}_.:/ -]{0,59}\](?![\[(]))/u,
];
const inline = new RegExp(structuralPatterns.map(({ source }) => source).join('|'), 'gu');
const emphasis =
  /(?<delimiter>(?<![\p{L}\p{N}_])_{1,3}|(?<!\*)\*{1,3}|(?<!~)~~)(?![_*~])\S[^\r\n]{0,512}?(?<!\s)\k<delimiter>(?![_*~])/gu;

const heading = /^ {0,3}#{1,6}(?=[ \t]|$)/;
const prefix =
  /^(?:[ \t]*>[ \t]?)*[ \t]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\](?=[ \t]|$)[ \t]*)?)?/;

function* inlineTokens(text, title) {
  const matches = [...text.matchAll(inline)];
  const plain = title ? 'syntaxMarkdown' : undefined;
  let masked = text;
  if (!title && /[*_~]/.test(text)) {
    let offset = 0;
    const pieces = [];
    for (const match of matches) {
      pieces.push(text.slice(offset, match.index), 'x'.repeat(match[0].length));
      offset = match.index + match[0].length;
    }
    pieces.push(text.slice(offset));
    masked = pieces.join('');
  }
  const ranges = title ? [] : [...masked.matchAll(emphasis)];
  let rangeIndex = 0;
  function* prose(start, end) {
    while (start < end && rangeIndex < ranges.length) {
      const range = ranges[rangeIndex];
      const stop = range.index + range[0].length;
      if (stop <= start) {
        rangeIndex++;
        continue;
      }
      if (range.index >= end) break;
      if (range.index > start) yield [text.slice(start, range.index), plain];
      yield [text.slice(Math.max(start, range.index), Math.min(end, stop)), 'syntaxMarkdown'];
      start = Math.min(end, stop);
    }
    if (end > start) yield [text.slice(start, end), plain];
  }
  let end = 0;
  for (const match of matches) {
    const { escape, code, tag, tagName, attrs, link } = match.groups;
    if (match.index > end) yield* prose(end, match.index);
    if (escape) yield [escape];
    else if (code) yield [code, 'syntaxCode'];
    else if (tag) {
      yield ['<' + tagName, 'syntaxTag'];
      if (attrs) yield [attrs, 'syntaxAttribute'];
      yield [tag.slice(1 + tagName.length + attrs.length), 'syntaxTag'];
    } else if (link) yield [link, 'syntaxMarkdown'];
    else yield [match[0], 'syntaxBracket'];
    end = match.index + match[0].length;
  }
  if (end < text.length) yield* prose(end, text.length);
}

export function* promptTokens(text, includeFences = true) {
  if (text.length > maxHighlightLength) {
    yield [text];
    return;
  }
  const sections = includeFences ? promptSections(text) : [{ start: 0, end: text.length }];
  for (const section of sections) {
    if (section.marker) {
      yield [text.slice(section.start, section.codeStart), 'syntaxCode'];
      yield [text.slice(section.codeStart, section.codeEnd)];
      if (section.codeEnd < section.end)
        yield [text.slice(section.codeEnd, section.end), 'syntaxCode'];
      continue;
    }
    const prose = text.slice(section.start, section.end);
    for (const line of prose.match(/[^\r\n]+|\r\n|\r|\n/g) || []) {
      const start = prefix.exec(line)[0].trimEnd().length;
      if (start) yield [line.slice(0, start), 'syntaxMarkdown'];
      const body = line.slice(start);
      yield* inlineTokens(body, heading.test(body));
    }
  }
}
