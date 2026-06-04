// CriticMarkup editorial comments — pure string helpers (no editor deps).
//
// We support exactly one CriticMarkup marker: a highlight+comment pair
//   {==highlighted text==}{>>the comment<<}
// The braces live verbatim in the document text (and on disk), so markdown
// round-trips losslessly with zero special handling. These helpers cover the
// two things that *aren't* "leave it as text": rendering (where the braces are)
// and the clean-copy transform (strip the braces+comment for distribution).

// A full highlight+comment pair. Group 1 = highlighted text, group 2 = comment.
// `[\s\S]` (not `.`) so a span/comment can contain anything but the delimiters;
// non-greedy so adjacent markers don't merge into one match.
export const COMMENT_RE = /\{==([\s\S]*?)==\}\{>>([\s\S]*?)<<\}/g;

// The clean / "accept" transform: drop comments entirely, unwrap highlights to
// their plain text. This is what plain ⌘C copies, so a marked-up document never
// leaks braces to a reader.
//
// Comments are removed first (delimiters + content), then any remaining
// highlight wrapper is unwrapped — which also tidies a stray `{==..==}` that has
// no trailing comment.
export function stripComments(md: string): string {
  return md
    .replace(/\{>>[\s\S]*?<<\}/g, "")
    .replace(/\{==([\s\S]*?)==\}/g, "$1");
}

// One parsed comment marker, with character offsets into the scanned string for
// each piece the decoration layer styles independently.
export type CommentRange = {
  // The four brace delimiters (each a [start, end) offset pair).
  openHl: [number, number]; // "{=="
  closeHl: [number, number]; // "==}"
  openCm: [number, number]; // "{>>"
  closeCm: [number, number]; // "<<}"
  // The highlighted span and the comment text between the delimiters.
  highlight: [number, number];
  comment: [number, number];
  // The comment's text content (for the highlight's hover tooltip).
  commentText: string;
};

const OPEN_HL = "{==";
const CLOSE_HL = "==}";
const OPEN_CM = "{>>";
const CLOSE_CM = "<<}";

// Scan a single string for comment markers and return each piece's offsets.
// The decoration plugin runs this per text node, offsetting by the node's
// position. A fresh RegExp is used per call so the shared `COMMENT_RE` lastIndex
// is never a cross-call footgun.
export function findCommentRanges(text: string): CommentRange[] {
  const ranges: CommentRange[] = [];
  const re = new RegExp(COMMENT_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const highlight = m[1];
    const comment = m[2];
    const openHlEnd = start + OPEN_HL.length;
    const hlEnd = openHlEnd + highlight.length;
    const closeHlEnd = hlEnd + CLOSE_HL.length;
    const openCmEnd = closeHlEnd + OPEN_CM.length;
    const cmEnd = openCmEnd + comment.length;
    const closeCmEnd = cmEnd + CLOSE_CM.length;
    ranges.push({
      openHl: [start, openHlEnd],
      highlight: [openHlEnd, hlEnd],
      closeHl: [hlEnd, closeHlEnd],
      openCm: [closeHlEnd, openCmEnd],
      comment: [openCmEnd, cmEnd],
      closeCm: [cmEnd, closeCmEnd],
      commentText: comment,
    });
    // Guard against a zero-length match looping forever (can't happen with these
    // fixed delimiters, but keeps the loop honest).
    if (re.lastIndex === start) re.lastIndex++;
  }
  return ranges;
}
