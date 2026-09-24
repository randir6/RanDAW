// Driving a real browser from the checks, with no library.
//
// Chrome can be controlled through its "DevTools protocol": JSON messages
// asking it to open a page, run some JavaScript in it, and send back the
// result. Normally that goes over a network socket; `--remote-debugging-pipe`
// uses two plain pipes instead (file descriptors 3 and 4 of the process),
// each message ending with a zero byte.
//
// This replaces reading the page with `--dump-dom`, which waited on the
// browser's simulated clock and so could read a page before real work (like
// reading a file) had finished. Here a check can wait for a condition to be
// true, with a real timeout.

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function findChromium() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const base = "/opt/pw-browsers";
  if (!existsSync(base)) return null;
  const found = readdirSync(base)
    .filter((name) => name.startsWith("chromium-"))
    .map((name) => join(base, name, "chrome-linux", "chrome"))
    .filter(existsSync);
  return found.at(-1) ?? null;
}

export async function launch(chromium) {
  const child = spawn(chromium, [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--remote-debugging-pipe",
    "--autoplay-policy=no-user-gesture-required", "--window-size=1280,900",
  ], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const toChrome = child.stdio[3];
  const fromChrome = child.stdio[4];

  let nextId = 1;
  const waiting = new Map();  // message id -> { resolve, reject }
  let buffered = "";
  fromChrome.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    let end;
    while ((end = buffered.indexOf("\0")) >= 0) {
      const message = JSON.parse(buffered.slice(0, end));
      buffered = buffered.slice(end + 1);
      const w = waiting.get(message.id);
      if (!w) continue;  // an event, not a reply; not needed here
      waiting.delete(message.id);
      if (message.error) w.reject(new Error(message.error.message));
      else w.resolve(message.result);
    }
  });

  function send(method, params = {}, sessionId = undefined) {
    const id = nextId++;
    toChrome.write(JSON.stringify({ id, method, params, sessionId }) + "\0");
    return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
  }

  // Open a page; returns helpers to run code in it.
  async function open(url) {
    const { targetId } = await send("Target.createTarget", { url });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });

    // Run an expression in the page and return its value. An async
    // expression is awaited.
    async function evaluate(expression) {
      const reply = await send("Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (reply.exceptionDetails) {
        throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
      }
      return reply.result.value;
    }

    // Wait until an expression is true, checking every 25 ms, for up to
    // `seconds` of real time.
    async function waitFor(expression, seconds = 20) {
      const deadline = Date.now() + seconds * 1000;
      for (;;) {
        try {
          if (await evaluate(expression)) return;
        } catch {
          // the page may still be loading; try again
        }
        if (Date.now() > deadline) throw new Error(`timed out waiting for: ${expression}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    }

    // A picture of the page as it is now, as PNG bytes. `width` and
    // `height` set the size of the window first.
    async function screenshot({ width = 1280, height = 900, dark = false } = {}) {
      await send("Emulation.setDeviceMetricsOverride",
        { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
      await send("Emulation.setEmulatedMedia",
        { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] }, sessionId);
      // Give the page a moment to react to its new size (it redraws a little
      // after a resize stops) before taking the picture.
      await new Promise((r) => setTimeout(r, 400));
      const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
      return Buffer.from(data, "base64");
    }

    // Run `expression` under Chrome's sampling profiler and return the time
    // spent in each function, largest first -- for finding what is slow.
    async function profile(expression) {
      await send("Profiler.enable", {}, sessionId);
      await send("Profiler.setSamplingInterval", { interval: 100 }, sessionId);
      await send("Profiler.start", {}, sessionId);
      await evaluate(expression);
      const { profile: p } = await send("Profiler.stop", {}, sessionId);
      const perNode = new Map(p.nodes.map((n) => [n.id, n]));
      const counts = new Map();
      p.samples.forEach((id, i) => {
        const f = perNode.get(id).callFrame;
        const name = `${f.functionName || "(anonymous)"} ${f.url.split("/").pop()}:${f.lineNumber + 1}`;
        counts.set(name, (counts.get(name) ?? 0) + (p.timeDeltas[i] ?? 0) / 1000);
      });
      return [...counts.entries()].sort((a, b) => b[1] - a[1]);
    }

    const close = () => send("Target.closeTarget", { targetId });
    await waitFor("document.readyState === 'complete' && document.documentElement.dataset.ready === '1'");
    return { evaluate, waitFor, screenshot, profile, close };
  }

  async function close() {
    try {
      await Promise.race([send("Browser.close"), new Promise((r) => setTimeout(r, 2000))]);
    } finally {
      child.kill();
    }
  }

  return { open, close };
}
