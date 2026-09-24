// Playing the rendered audio, on a loop, through the Web Audio API.
//
// Why not an <audio> element? One set to loop leaves a small gap each time it
// starts over, which is exactly wrong for a tool whose whole output is loops.
// A Web Audio buffer loops sample-accurately.
//
// The audio clock (ctx.currentTime) is the one source of truth for where
// playback is. The drawing asks position() before each screen refresh and
// follows it, so picture and sound cannot drift apart.

import { encodeWav16 } from "./wav.js";

export function createPlayer() {
  let ctx = null;       // the AudioContext, made on first use
  let audio = null;     // the current piece: { samples, sampleRate }
  let buffer = null;    // the same audio, made ready to play (on first play)
  let source = null;    // what is playing right now, if anything
  let playing = false;
  let startedAt = 0;    // the audio clock's time when position 0 would have been
  let heldAt = 0;       // where we are while paused

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

  const duration = () => (audio === null ? 0 : audio.samples.length / audio.sampleRate);

  function position() {
    if (!playing) return heldAt;
    // The audio clock only ever counts up, so wrap it round the loop length.
    return (ctx.currentTime - startedAt) % duration();
  }

  // Hand over new audio: a Float32Array of samples at `sampleRate`. Playback
  // stops; the caller restarts it if it wants to.
  function load(samples, sampleRate) {
    stop();
    heldAt = 0;
    audio = { samples, sampleRate };
    buffer = null;  // made on the next play()
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

  let starting = false;  // true while play() waits for the audio to wake

  async function play() {
    // Two quick taps must not start the sound twice.
    if (audio === null || playing || starting) return;
    starting = true;
    // Both of these must happen straight away, inside the tap itself: iPhones
    // only allow sound to start during the tap, not after waiting for anything.
    keepAudible();
    try {
      await context().resume();  // wakes a context the browser suspended
    } finally {
      starting = false;
    }
    if (buffer === null) {
      buffer = ctx.createBuffer(1, audio.samples.length, audio.sampleRate);
      buffer.copyToChannel(audio.samples, 0);
    }
    source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(ctx.destination);
    source.start(0, heldAt);
    startedAt = ctx.currentTime - heldAt;
    playing = true;
  }

  function stop() {
    if (!playing) return;
    heldAt = position();
    source.stop();
    source.disconnect();
    source = null;
    playing = false;
    silence?.pause();  // ?. -- only if it was ever made
  }

  // Jump to time t, carrying on playing if we were.
  function seek(t) {
    const wasPlaying = playing;
    stop();
    // % in JavaScript can return a negative number, so add the length on.
    heldAt = duration() === 0 ? 0 : ((t % duration()) + duration()) % duration();
    if (wasPlaying) play();
  }

  return { load, play, stop, seek, position, duration, isPlaying: () => playing };
}
