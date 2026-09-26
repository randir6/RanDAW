// Playing the rendered audio, on a loop, through the Web Audio API -- and
// swapping in an edited version without stopping.
//
// Why not an <audio> element? One set to loop leaves a small gap each time it
// starts over, which is exactly wrong for a tool whose whole output is loops.
// A Web Audio buffer loops sample-accurately.
//
// The audio clock (ctx.currentTime) is the one source of truth for where
// playback is. The drawing asks where playback is before each screen refresh
// and follows it, so picture and sound cannot drift apart.
//
// Positions are counted in BARS (2.5 = halfway through the third bar)
// rather than seconds, because an edit can change how long a bar is. The
// bar count is what carries over when one version of a piece replaces
// another.

import { encodeWav16 } from "./wav.js";

// An edit lands at the start of the next bar -- unless that is less than this
// many seconds away, when there is not reliably time to set it up, so it lands
// at the one after.
const MIN_LEAD = 0.05;
// The old version fades out over this long as the new one comes in, so notes
// still ringing at the boundary do not stop with a click.
const FADE = 0.015;

// Where an edit should come in, given where playback is now.
//
// `now` is the current position in bars; `current` and `next` describe the
// old and new versions: { bar: seconds per bar, bars: bars in the piece }.
// Returns how many seconds to wait, and which bar of the new version to
// start from -- the same bar count playback was about to reach, wrapped
// into the new version's length. A plain function so the checks can test it.
export function planSwap(now, current, next) {
  let boundary = Math.floor(now) + 1;
  if ((boundary - now) * current.bar < MIN_LEAD) boundary += 1;
  // The bar the old version was about to enter. At the end of its loop
  // that is bar 0 again, and the new version starts from its beginning too.
  const entering = boundary % current.bars;
  return { wait: (boundary - now) * current.bar, startBar: entering % next.bars };
}

export function createPlayer() {
  let ctx = null;        // the AudioContext, made on first use
  let latest = null;     // the newest audio: { samples, sampleRate, bar, bars, buffer }
  let sounding = null;   // what is playing: { track, source, gain, startedAt }
  let pending = null;    // an edit waiting for the next bar: same shape, plus activeAt
  let playing = false;
  let heldAt = 0;        // where playback is while stopped, in bars

  // Browsers refuse to make sound until the person has clicked or tapped
  // something, so the AudioContext is created on the first press of Play
  // rather than when the page loads.
  function context() {
    if (ctx === null) {
      // On iPhone and iPad, web audio is silenced by the ring/silent switch
      // unless the page says it is playing media. Newer Safari lets it say so;
      // other browsers have no such setting, and the `if` skips it. Not every
      // iPhone honours it, hence keepAudible() below as well.
      if (navigator.audioSession) navigator.audioSession.type = "playback";
      // webkitAudioContext is the older name, for older Safari.
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return ctx;
  }

  // The iPhone silent-switch workaround. Silent mode mutes web audio, but not
  // an ordinary <audio> element, which counts as "media playing" -- and while
  // one is playing, the page's web audio is let through too. So alongside the
  // real sound, a second of silence plays on a loop in an <audio> element.
  // Harmless everywhere else: it is silence.
  let silence = null;
  function keepAudible() {
    if (silence === null) {
      const bytes = encodeWav16(new Float32Array(44100), 44100);
      silence = new Audio(URL.createObjectURL(new Blob([bytes], { type: "audio/wav" })));
      silence.loop = true;
    }
    // play() can be refused (it returns a promise that fails); if so, there
    // is nothing to fix, so the failure is deliberately ignored.
    silence.play().catch(() => {});
  }

  // Make a track's audio ready to play, once.
  function bufferOf(track) {
    if (!track.buffer) {
      track.buffer = ctx.createBuffer(1, track.samples.length, track.sampleRate);
      // getChannelData().set() rather than copyToChannel(): the same result,
      // and supported by older Safari too.
      track.buffer.getChannelData(0).set(track.samples);
    }
    return track.buffer;
  }

  // Start a track playing at audio-clock time `at`, from bar `fromBar`.
  // Each track gets its own volume control (a GainNode), so one can fade out
  // while the next comes in.
  function startTrack(track, at, fromBar) {
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    const source = ctx.createBufferSource();
    source.buffer = bufferOf(track);
    source.loop = true;
    source.connect(gain);
    const offset = fromBar * track.bar;
    source.start(at, offset);
    // Once stopped, unplug it so it can be tidied away.
    source.onended = () => { source.disconnect(); gain.disconnect(); };
    return { track, source, gain, startedAt: at - offset };
  }

  // If a waiting edit's moment has come, it is now what is sounding.
  function promote() {
    if (pending !== null && ctx.currentTime >= pending.activeAt) {
      sounding = pending;
      pending = null;
    }
  }

  // Where playback is, in bars, counted in whatever is actually sounding.
  function barPosition() {
    if (!playing) return heldAt;
    promote();
    const { track, startedAt } = sounding;
    const seconds = (ctx.currentTime - startedAt) % (track.bar * track.bars);
    return Math.max(0, seconds) / track.bar;
  }

  // Hand over the audio of a newly opened piece. Playback stops and goes back
  // to the start; the caller restarts it if it wants to.
  function load(samples, sampleRate, { bar, bars }) {
    stop();
    heldAt = 0;
    latest = { samples, sampleRate, bar, bars };
  }

  // Hand over the audio of an EDITED piece. While playing, it comes in at
  // the start of the next bar, carrying on the bar count; while stopped, it
  // simply replaces the old audio at the same place in the bar.
  function swap(samples, sampleRate, { bar, bars }) {
    const next = { samples, sampleRate, bar, bars };
    if (!playing) {
      latest = next;
      heldAt = (Math.floor(heldAt) % bars) + (heldAt % 1);
      return;
    }
    promote();
    latest = next;
    // A newer edit replaces one still waiting.
    if (pending !== null) {
      pending.source.onended = null;
      pending.source.stop();
      pending.source.disconnect();
      pending.gain.disconnect();
      pending = null;
    }
    const now = ctx.currentTime;
    const { wait, startBar } = planSwap(barPosition(), sounding.track, next);
    const at = now + wait;
    // The old version plays at full volume up to the boundary, then fades.
    // Earlier fades planned for it are cancelled first.
    const volume = sounding.gain.gain;
    volume.cancelScheduledValues(now);
    volume.setValueAtTime(1, now);
    volume.setValueAtTime(1, at);
    volume.linearRampToValueAtTime(0, at + FADE);
    // Calling stop() again replaces an earlier stop time.
    sounding.source.stop(at + FADE + 0.01);
    pending = { ...startTrack(next, at, startBar), activeAt: at };
  }

  let starting = false;  // true while play() waits for the audio to wake

  async function play() {
    // Two quick taps must not start the sound twice.
    if (latest === null || playing || starting) return;
    starting = true;
    // Both of these must happen straight away, inside the tap itself: iPhones
    // only allow sound to start during the tap, not after waiting for anything.
    keepAudible();
    try {
      await context().resume();  // wakes a context the browser suspended
    } finally {
      starting = false;
    }
    const from = (Math.floor(heldAt) % latest.bars) + (heldAt % 1);
    sounding = startTrack(latest, ctx.currentTime, from);
    pending = null;
    playing = true;
  }

  function stop() {
    if (!playing) return;
    heldAt = barPosition();
    for (const t of [sounding, pending]) {
      if (t === null) continue;
      t.source.stop();
    }
    sounding = pending = null;
    playing = false;
    silence?.pause();  // ?. -- only if it was ever made
  }

  // Jump to a position (in bars), carrying on playing if we were. While
  // playing, the jump is immediate: the audio is already running, so there is
  // nothing to wait for, and playback never stops even for a moment.
  function seek(position) {
    const bars = latest?.bars ?? 1;
    // % in JavaScript can return a negative number, so add the length on.
    const target = ((position % bars) + bars) % bars;
    if (!playing) {
      heldAt = target;
      return;
    }
    for (const t of [sounding, pending]) if (t !== null) t.source.stop();
    pending = null;
    sounding = startTrack(latest, ctx.currentTime, target);
  }

  return {
    load,
    swap,
    play,
    stop,
    seek,
    barPosition,
    isPlaying: () => playing,
    // True while an edit is waiting for the next bar to come in.
    isSwapPending: () => pending !== null && ctx !== null && ctx.currentTime < pending.activeAt,
  };
}
