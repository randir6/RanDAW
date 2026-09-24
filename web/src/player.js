// Playing the rendered audio, on a loop, through the Web Audio API.
//
// Why not an <audio> element? One set to loop leaves a small gap each time it
// starts over, which is exactly wrong for a tool whose whole output is loops.
// A Web Audio buffer loops sample-accurately.
//
// The audio clock (ctx.currentTime) is the one source of truth for where
// playback is. The drawing asks position() before each screen refresh and
// follows it, so picture and sound cannot drift apart.

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
      // other browsers have no such setting, and the `if` skips it.
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

  let starting = false;  // true while play() waits for the audio to wake

  async function play() {
    // Two quick taps must not start the sound twice.
    if (audio === null || playing || starting) return;
    starting = true;
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
