# Working Notes

Running notes on known limitations and decisions. Not a spec — VISION.md and
PHASE1_SPEC.md are the spec, and stay as written.

**On the words.** Phase 12 settled the vocabulary; README.md's Glossary is
the list. Entries written before it use the older words, and are left as
written where they record history: a *cycle* is what is now a **bar**,
*loops* is **bars** (the length), a *step* of a sequence is a **position**,
and *the LCM* is **pulses per bar**.

## Known limitations (phase 1)

These are consequences of deliberate choices, not bugs. Each one is worth
revisiting when the relevant phase arrives.

### Upward pitch shifts alias
Pitch shifting is done by resampling (speed-change, like varispeed on tape),
which is the numpy-only approach chosen to avoid a librosa dependency before
phase 1 was proven. There is no anti-aliasing filter, so frequencies pushed
above Nyquist fold back down instead of disappearing.

Measured: an 8 kHz tone shifted +24 semitones should land at 32 kHz, above the
22.05 kHz Nyquist limit. It comes back at 12.1 kHz.

In practice: fine for shifts of a few semitones, increasingly gritty on bright
samples shifted up a long way. Revisit alongside phase 4 (per-layer effects),
where a proper resampler or a real pitch-shifter would live.

### Pitch and duration are coupled
Same cause. A note shifted up is shorter, a note shifted down is longer;
+12 semitones plays at half the length, -12 at double. This is musically
useful as often as it is not, but it is not "true" pitch shifting.

### Mono only
Stereo inputs are downmixed by averaging L and R, and output is always mono.
Hard-panned content loses 6 dB in the process (measured: a tone at 0.9 in the
left channel only arrives at 0.45). Correlated stereo content is unaffected.

No decision has been made about whether the tool should be stereo-aware. Worth
settling before per-layer effects, since panning is an obvious per-layer
parameter.

### Output is 16-bit PCM
Now an explicit choice: `wav.js` writes 16-bit PCM itself (it was a library
default in the Python version). Right for the downstream targets (Koala,
Loopy). The rounding rule it uses is the Python library's, copied exactly so
the two versions made identical files; it is slightly odd (round to 32 bits,
keep the top 16) and could be simplified once the Python version is retired,
at the cost of changing the last bit of some samples.

### The drawing scrolls sideways on a phone held upright
Since phase 11, narrow screens show two bars per page and the drawing keeps
a readable size, scrolling sideways inside its frame. Workable, not lovely;
a layout made for portrait phones would be its own piece of work.

### Levels are set by hand
Per-layer `gain=` with no auto-normalization, chosen deliberately for control.
Consequence: adding layers or stacking overlapping tails can clip, and the fix
is to dial gains down yourself. The clipping warning suggests a specific value
that resolves it.

### The file is not exactly the tempo's length
Beats land on an integer grid of pulses, and each pulse is a whole number of
audio samples. So a bar is (pulses per bar) × (samples per pulse), which is
the tempo's bar length rounded to fit. The `spans` example asks for a 2.4 s
bar (100 BPM, 4 beats) and gets 2.4019 s, because 364 pulses per bar do not
divide 2.4 × 44100 evenly: 8 bars come out 15 ms long.

Inaudible within the file, but **it matters for the tool's purpose**: a loop
dropped into a DAW or looper running at 100 BPM will drift against it by
that much each time round, unless the host stretches it to fit. Fixable by
placing each beat at its exact fraction of the bar, rounded to the nearest
sample, instead of snapping to a pulse grid — then the file is exactly
bars × bar length, and each beat is within half a sample of true. It would
change the sound of new pieces by at most a sample per beat; older pieces
could keep today's timing. **Top candidate for the next piece of work.**

### Very fine grids lose resolution
A bar of B seconds at sample rate R needs pulses per bar ≤ B × R for at
least one sample per pulse, and comfortably fewer to place beats accurately.

Measured at a 2s bar, 44.1 kHz: 3/4/5/7/11 (4620 pulses per bar) renders a
1.990s bar, 0.5% off and inaudible. Adding a 13 (60060) leaves 1.47 samples
per pulse, which rounds to 1 and collapses the bar to 1.36s — the page warns
when the rounded bar differs from the requested one by over 1%.

The same fix as above removes this limit too.

## Open questions

*Status when parked (26 September 2026): none of these is decided. The
drawing-delay question below is the newest and the quickest to answer.*

### Does Safari report the speaker delay?

The drawing now allows for the delay between sending sound and hearing it
(see Decisions). It relies on the browser reporting it; Chrome does, and on
Bluetooth it can be 150-250 ms. Whether Safari on the iPad and iPhone does
is untested. Check: play with headphones and look for "drawing delayed N ms
to match your speakers" beside the clock. If it never appears there, add a
manual delay setting.

### Rest behaviour may not be right — revisit first

Flagged at the end of the first session, unresolved and deliberately not
acted on. The doubt is about rests shifting position each bar: a rest
travels with the sequence, so when the sequence length differs from the beat
count the silence lands on a different beat each time round. That is what
was built and it is what the checks assert, but it may not be the musically
useful behaviour, or may not be the only one wanted.

Next step is to play with examples and work out what it *should* do before
changing anything. The `rests` example is the place to start — try making
the sequence exactly as long as the beat count, which pins the rest in place,
and compare.

**You can see it rather than work it out.** Open the page and pick the
`rests` example: the rest marks wander across the pluck row (7 positions
over 5 beats) and the kick row (6 over 8), but stay put on the bell's (3 over
3). Still no behaviour changed. Since phase 11, tapping a position in a
layer's Sequence row outlines every place it lands, and edits are heard at
the next bar -- so trying variations is now quick.

Talked through since: rests and switched-off beats sound the same on any one
beat and are the same thing when the sequence is as long as the beat count.
They differ only when the lengths differ -- a rest belongs to the melody and
moves with it, a switched-off beat belongs to the rhythm and stays put. Both
are useful; the hard part is making the difference obvious in an editor.

Possible outcomes, none decided: current behaviour is right and just needs
demonstrating better; rests should be fixed to a beat like `active` is; or
both behaviours are wanted and it becomes a per-layer choice. Related: the
backlogged `notes_follow=beats|hits` item below is the same family of
question.

## Backlog

Ideas deliberately not built, kept here so they are not lost. Nothing in
this list is committed to, and none of it is in the phase plan.

### Sections — variations across bars (high priority)

Let a piece be a sequence of sections -- say 4 bars each, in a 16-bar
file -- that share
a polyrhythmic base but vary what sits on top: which beats are active, which
scale, which notes, gains, maybe samples. Four bars with the same skeleton
and different detail is most of what turns a loop into an arrangement, and
it is the largest musical gap in the tool as it stands.

Design notes from thinking it through, so the work does not start cold:

- **The schedule is already the right seam.** A section produces its own
  events and they get offset by the bars already elapsed. `renderAudio`
  would not change at all, the same way beat skipping did not touch it.
- **Pulses per bar must be worked out across every section, not per
  section.** If section 2 introduces a layer with a different beat count,
  the pulse grid changes, and a grid that changed mid-piece would break the
  timing guarantees. Work it out over the whole piece up front. (Or place
  beats exactly, with no pulse grid -- see the limitation above.)
- **Variation is best expressed as an override, not a re-declaration.**
  Repeating every layer per section would be miserable to write and easy to
  get inconsistent. Something closer to: declare the layers once, then
  per-section state only what differs.
- **Section length is in bars**, a whole number of them. A layer spread
  over 2 bars wants sections that are a multiple of 2 long.
- **Interacts with drift.** Sections are deliberate variation;
  drift is gradual variation. They are different answers to the same
  musical problem and it is worth deciding whether they coexist or whether
  one makes the other redundant before building the second one.

### Smaller items

- **Sample sets per layer.** Was phase 6; dropped back to the backlog. One
  sample per layer, pitch-shifted, is the model. If it returns, the samples
  list should be length 1 or exactly the length of the pitch sequence, so a
  layer keeps ONE period: an independently cycling sample list would give
  4 beats / 12 notes / 5 samples a 15-bar repeat that nobody can author or
  predict.
- **Chords within a layer.** One note per beat today.
- **Chromatic passing notes in a degree sequence.** Degrees can only land on
  scale members; anything outside needs the semitone notation.
- **Modulation.** Scale and root are fixed for a whole render.
- **Samples declaring their own root pitch.** Would let `key = "D"` mean
  something real rather than assuming every sample is a C, and would make
  `root` a musical setting rather than an offset.
- **Note sequence that advances only on sounding beats.** Currently a note
  belongs to its beat position, so skipping a beat silences that note. The
  alternative advances the sequence only when a beat sounds, so every note
  is heard in turn and skipping becomes a rhythmic mask over a melody that
  keeps running. Both are musically useful and they are genuinely different.
  Would need the note counter in `schedule()` to change, not just a filter,
  so probably a per-layer choice like `notes_follow=beats|hits`.
- **One-shot render mode.** Tails currently wrap so files loop seamlessly,
  which means a render opens with the tail of its own last note. Fine for
  loops, wrong for a one-shot. Needs a flag.
- **Auto-normalise option.** Levels are set by hand on purpose, but a
  `--normalise` that scales the finished mix to just under 0 dB would save
  dialling gains in by trial and error.
- **Sample-accurate event placement.** Beats snap to an integer pulse grid,
  which makes the file slightly off the tempo's length and loses resolution
  on very fine grids (both above). Placing each beat at its exact fraction
  of the bar would fix both.
- **Stereo.** Everything is mono. Panning is an obvious per-layer parameter
  and would want settling before per-layer effects land.
- **Explicit output bit depth.** 16-bit PCM is currently soundfile's default
  rather than a stated choice.
- **Per-note velocity.** Gain is per-layer. Per-event gain would allow
  accents, and `Event` already carries a gain field that could vary.
- **More than five layers in the visualiser.** The cap is `MAX_LAYERS` in
  `visualise.py`, and rows are laid out from the layer count, so lifting it
  is a one-line change plus a look at whether a sixth row still fits a
  laptop screen. Needs a sixth palette colour, validated like the others.
- **Share straight to AUM or Koala from the iPad.** The page downloads the
  WAV; Safari's share sheet (`navigator.share` with a file) could send it to
  another app directly. Needs trying on the device.
- **Your own samples in the page.** A file picker, decoded by `wav.js`;
  "Save page" would then carry them inside the shared file too.
- **A different click sound, or its own gain.** The click is one fixed
  tick (`click.wav`), higher on beat 1. Enough to count by; a setting if it
  ever needs to be quieter or different.

## Decisions worth remembering

- **A rest is `"-"`, in both notations.** It cannot be a number, because 0 is
  already meaningful in each: unison in semitones, one step below the root as
  a degree. `"-5"` is still minus five; only an exact `"-"` is a rest.
- **Rests and `active=` are different tools.** An inactive beat is silent on
  the same beat every cycle. A rest travels with the sequence, so when the
  sequence and beat count are different lengths the silence lands on a
  different beat each cycle. Both are checked.
- **The composed-pattern and phasing notations are the same model.** Writing
  a sequence whose length equals the beat count (or a multiple) gives a
  plainly composed per-beat pattern; a different length gives phasing. There
  is no separate mode -- `degrees = [1,0,1,2,1,0,1,3,1,0,2,4]` on a 4-beat
  layer is simply a 3-cycle pattern.

- **Pitches are `notes` (semitones) or `degrees` (against a scale), never one
  field that changes meaning.** A single field reinterpreted whenever a scale
  was present would have let a global scale silently rewrite every drum
  layer's numbers. Two fields make a semitone layer provably immune.
- **`root` is a semitone offset, not a key name.** We pitch-shift samples
  whose own pitch is unknown, so "the key of D" would be a fiction. Naming
  keys honestly needs samples to declare their natural pitch.
- **Degrees resolve to semitones in `make_layer`**, so schedule, render and
  the event list never learn that scales exist. The whole feature lives at
  the boundary.

- **Skipping a beat silences its note; it does not shuffle the melody up.**
  A layer's note sequence is indexed by beat position whether or not that
  beat sounds, so `active=1,3` on a 4-beat layer with notes `0,12,24,36`
  plays `0` and `24`, not `0` and `12`. Like muting a step on a drum machine
  rather than deleting it.

  Both behaviours are useful; the other one is on the backlog below.
- **Active beats count from 1**, as musicians count, and convert to 0-based
  indices once at parse time. Phase 5's scale degrees will be 1-indexed for
  the same reason.

- **The schedule is the core, audio is one consumer.** `schedule()` produces
  the event list and `render_audio()` sounds it. Beat skipping filters the
  list, drift moves it, MIDI exports it and a visualiser would draw it, so
  none of those need to touch the audio path. Measured before splitting: the
  schedule costs ~0.02 ms against ~7.5 ms for the audio.
- **Events sort into time order, at the cost of exact byte-identity.**
  Reordering float32 additions moved one sample of 529,200 by a single
  16-bit LSB (-90 dBFS) in one reference render. Accepted deliberately.

- **Tempo is the cycle, not the pulse.** `--cycle-duration` sets how long one
  full polyrhythm cycle lasts, and every layer divides that span. An earlier
  `--bpm` set the *pulse* instead, which meant adding a 5-beat layer took the
  LCM from 12 to 60 and slowed a 120 bpm kick to 24 bpm without changing any
  setting the user had touched. Caught by ear, not by the tests — there is
  now a regression check that a layer's onsets are unchanged by the addition
  of another layer. `--pulse-duration` survives as the low-level control.
- **Renders refuse to exceed `--max-duration`** (default 120s) and say how
  long they would have been. Mostly reachable via `--pulse-duration` now,
  since cycle-based tempo makes length explicit.

- **Loop tails wrap.** A note whose tail runs past the end of the render wraps
  around to the start, so the file loops without a click. The trade: the very
  beginning of a render contains the tail of its own last note. Correct for
  looping, wrong for a one-shot render — there is no flag for that yet.
- **`--layer` is self-contained** (`BEATS:NOTES:SAMPLE[:gain=G]`) rather than
  the spec's `--sample1`/`--sample2`, which would not extend past two layers.
- **A "pulse" is the LCM grid**, the finest subdivision on which every layer's
  beats land — not any single layer's beat spacing.

- **A spec is what the user wrote; a Piece is what it means.** The spec keeps
  degrees, scale, 1-based beats and rests, and round-trips through TOML and
  JSON unchanged. The Piece has them resolved and is what gets rendered.
  `build_piece()` is the only way from one to the other, and both the CLI and
  config files go through it — `--layer` strings become spec entries first.
  Resolving loses information by design, which is why a GUI must save the
  spec, never the Piece.
- **A spec with both `cycle_duration` and `pulse_duration` is refused**,
  rather than one quietly winning. On the command line, either tempo flag
  replaces whichever the config chose, because an override is explicit.
- **Warnings are data.** `build_piece()` returns them on the Piece rather than
  printing, so a GUI can show them its own way. The CLI prints them.
- **One loop, two views.** `grid()` yields every layer x cycle x beat with a
  status (note, rest, inactive); `schedule()` keeps just the notes. Written
  as one generator so the rules for what sounds exist once.
- **Numbering in the JSON export:** counts a musician says aloud (cycle,
  beat) start at 1; list positions (layer, step) start at 0.
- **No musical logic in the visualiser's JavaScript.** Python works out every
  cell's label, height, position and every coincidence; the page only draws.
  Otherwise the rules would exist twice, once untested.
- **The page embeds only the derived half**, not the spec, so a shared page
  does not carry the paths to your sample folders.
- **Web Audio, not `<audio loop>`,** because the audio element leaves a gap at
  the loop point. The drawing follows the audio clock, not its own timer.
- **The visualiser refuses more than five layers rather than dropping some.**
  A layer you can hear but not see would make the rest of the page
  untrustworthy. The limit is the visualiser's alone; audio is unlimited.
- **Check screenshots by looking at them.** Headless Chromium wrote blank
  images while reporting success until given `--headless=new` and the
  render-wait flags.

- **The engine lives in the page, in JavaScript** (phase 10), so the tool
  runs on an iPad and a piece can be shared as one file. The reasoning and
  the risks are in PHASES.md under "Re-planned again".
- **Match the old version exactly, not approximately.** The port was held to
  byte-identical output against recorded Python results, and that is what
  found every real difference -- including one that changed 70 samples in
  half a million by the smallest possible step.
- **A sample in a piece is a name, not a path.** The page has a sample
  library; a web page cannot reach into your folders.
- **The page reads and writes WAV itself** rather than letting the browser
  decode audio, because browsers resample differently and the same piece
  must make the same file on every device.
- **One file, built from modules.** Browsers will not load module files from
  a page opened off the disk, so `build.js` stitches them into one. It
  refuses code it does not understand rather than guessing, and refuses any
  code containing the text that would end its script block.
- **No dependencies, still.** Node runs the checks with its built-in test
  runner; `package.json` lists no packages.
- **Headless Chrome's window will not go narrower than 500 pixels**, so a
  "phone" screenshot taken with `--window-size=390,…` is a cropped 500-pixel
  page. `test/browser.js` sets the true size through the debugging protocol
  instead (its `screenshot({ width: 390 })`).

- **Every edit is a plain function, spec in, new spec out** (`edit.js`). The
  page runs each result through `buildPiece`, so the rules still live in one
  place, and an edit that breaks one is refused with the engine's message
  while the last good version keeps playing. Undo is a list of old specs.
- **The editor panel is rebuilt from the piece after every change**, rather
  than updated piece by piece, so it can never disagree with the piece.
- **Edits come in at the next bar, counted in bars.** The player keeps its
  position as a bar count, not seconds, because an edit can change the bar
  length; the new version starts on the downbeat of the bar playback was
  about to reach, and the old one fades over 15 ms.
- **Mute and solo are saved in the piece**, as a DAW keeps them. Solo wins
  over mute. Silent layers stay drawn, faded, with their name saying why, and
  are left out of the WAV and of "sounding together".
- **The piece is kept in the browser's storage** between visits: a
  convenience against reloads, not a save. Safari can clear it.
- **Test the page by driving Chrome, not by dumping it.** `--dump-dom` runs on
  a simulated clock that races ahead of real work; `test/browser.js` talks to
  Chrome over its debugging protocol and waits for real conditions.
- **An edit redraws first and makes its sound 25 ms later**, so the screen
  answers a tap at once even where rendering is slow; a quick run of edits
  makes the sound only for the last. Download finishes a waiting sound
  first. `data-busy` marks a waiting sound for the checks.
- **Finished sounds are cached between edits**, keyed by sample, rate,
  pitch and gain -- everything that decides them -- and the cache is
  emptied past 300 entries rather than allowed to grow. If a sample could
  ever be replaced under the same name (custom samples), the cache must be
  cleared then.
- **Two greys:** `--muted` for lines and hatching in the drawing (3:1 is the
  bar for graphics), `--ink-3` for quiet text (4.5:1 for small text). Keep
  them apart.
- **Length suggestions round up** to the next whole number of repeats, so
  following one never shortens a piece unexpectedly.

- **The drawing follows what you hear, not what is sent.** The audio clock
  says when sound leaves the page; Bluetooth headphones can add 150-250 ms
  before it is heard, which made sharp hits look late against the playhead.
  The drawing runs behind the clock by the delay the browser reports
  (`outputLatency` + `baseLatency`), and says so on the page when it is 20 ms
  or more. Edits are still planned on the clock itself. If a browser does not
  report the delay, nothing is allowed for -- a manual setting would be the
  fallback if that turns out to happen on the iPad.
- **Three drawings of the same piece: grid, rings and polygons.** All only
  draw what `derive.js` worked out, and offer the page the same methods, so
  switching is one line in `main.js`. What they all share is in `drawing.js`;
  the clock face the two round ones share is `clock.js`. A turn of the
  rings is enough bars for every layer's span to come round whole (the lcm of
  their `over`s), capped at 4 bars; the grid instead prefers pages that hold
  spans whole. On a narrow screen the rings stack the names above the circle
  and shrink to fit rather than scroll. The choice is remembered per browser
  (`randaw-drawing`), or given by `?view=rings` / `?view=polygons`.
- **Rings stay concentric, one per layer**, rather than a separate circle per
  layer: the point is that the same angle is the same instant in every
  layer, which separate circles would lose. Polygons give each layer its own
  shape without losing it. Each polygon sits a little inside the last so
  shared corners stay visible side by side, and shows two outlines -- every
  beat (the pulse) and only the sounding beats (what you hear).
- **Not a sample problem.** Measured before fixing: every built-in sample is
  at full level within a few ms (snare and hat within 1), and every hit in a
  rendered file lands within 0.02 ms of its time.

### Phase 12: tempo, base and bars

- **One vocabulary, everywhere.** Tempo, base, bar, beat, over, sequence and
  position, repeats every N bars, length in bars -- in the page, the saved
  file, the code and its comments. README.md's Glossary is the list. "Cycle",
  "loops" and "step" left the page; "pulse" stays inside the engine.
- **The base is a setting, not a layer.** It sets the bar (with the tempo)
  and is drawn as faint lines and heard as the click, but it has no sequence
  of its own. A layer that should sound on the base beats is just a layer
  with that many beats.
- **The base joins the pulse grid**, so its beats land exactly -- whether or
  not the click is on, so turning the click on never re-times anything.
- **Tempo is the base beat's BPM, and the bar is still the unit.** Adding a
  layer still subdivides the bar rather than stretching it, exactly as the
  cycle did.
- **A layer can spread over several bars (`over`)** instead of squeezing a
  big beat count into one: 13 over 2 bars. Its beats are evenly spread
  across the span; the pulse grid needs beats / gcd(beats, over) per bar. A
  piece that ends part-way through a span simply stops there.
- **Older pieces are read, not rejected.** `cycle_duration`,
  `pulse_duration` and `loops` still work and are timed exactly as before
  (base left out of the grid unless the click needs it), so the recorded
  Python answers still match to the byte. The page upgrades an older piece
  to tempo/base/bars as it opens it; saying the same thing both ways in one
  piece is refused. Saved files are now format version 2; version 1 reads.
- **The click is off unless asked for**, and is its own sample made by
  `make_samples.py` (added last, so the other sounds are unchanged). It is
  sound only: it is not a layer, is not drawn, and does not count as a layer
  sounding together.
- **The page prefers a whole span per page**: with a layer over 2 bars, it
  shows 4 or 2 bars at a time rather than 3, so a span is not split.
