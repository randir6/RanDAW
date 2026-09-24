// A short fingerprint of some bytes: eight hex digits that change if any
// byte changes.
//
// The page shows the fingerprint of the audio it rendered. The same piece
// must give the same fingerprint on every device -- so reading it off an iPad
// and comparing it with a laptop's is a quick check that both made
// byte-identical audio, with no files to move about.
//
// This is FNV-1a, a well-known simple hash: for each byte, mix it in with XOR
// (^) and then multiply by a fixed prime. Math.imul multiplies as 32-bit
// whole numbers, and >>> 0 reads the result as a positive number. Not
// cryptographic -- it would not stop someone forging a match on purpose --
// but more than enough to catch an accidental difference.
export function fnv1a(bytes) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash = Math.imul(hash ^ bytes[i], 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
