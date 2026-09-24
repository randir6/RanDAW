// Getting bytes out of the page as a file, and back in from base64 text.

// Hand the browser some bytes as a file to save. A "blob" is a lump of data
// held in memory; an object URL is a temporary address for it that a link
// can point at. Clicking a link with a `download` name saves what it points
// at instead of opening it.
export function download(data, filename, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  // Give the browser a moment to start the download before letting go.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// base64 text back into raw bytes. atob() gives a string with one character
// per byte; charCodeAt reads each one's number. (base64 is how the samples
// sit inside the page: it writes any bytes using only letters and digits.)
export function fromBase64(text) {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
