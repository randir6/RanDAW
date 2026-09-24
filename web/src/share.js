// Putting a piece into a copy of the page, so it can be shared as one file.
//
// The page carries its piece in a data block -- a <script> element with the
// id "randaw-piece", holding {"name": ..., "spec": ...} as JSON -- and opens
// whatever it finds there. (The closing tag is not written out in this
// comment because this code itself ends up inside a script block, where that
// text would end it early. build.js checks for exactly that.) Sharing a piece means making a copy of
// the page with a different piece in that block -- the same program, the same
// samples, a different piece. Used by the page's "Save page" button, by
// build.js, and by the checks.

// JSON that is safe inside an HTML <script> block. A name containing the tag
// that closes a script block would otherwise end the block early. Writing <,
// > and & as backslash-u escapes (< and so on) is still valid JSON, and
// JSON.parse turns them back into the same characters.
export function jsonForScript(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

const PIECE_BLOCK = /(<script type="application\/json" id="randaw-piece">)[\s\S]*?(<\/script>)/;

// A copy of the page's HTML, set to open with this piece.
export function pageWithPiece(html, name, spec) {
  if (!PIECE_BLOCK.test(html)) throw new Error("this page has no piece block to fill in");
  // A function as the replacement, so any "$" in the piece is taken
  // literally rather than as a special replacement pattern.
  return html.replace(PIECE_BLOCK, (_, open, close) => open + jsonForScript({ name, spec }) + close);
}
