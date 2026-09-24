# Working Notes

Running notes on known limitations and decisions. Not a spec — VISION.md and
PHASE1_SPEC.md are the spec, and stay as written.

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
Since phase 11, narrow screens show two cycles per page and the drawing keeps
a readable size, scrolling sideways inside its frame. Workable, not lovely;
a layout made for portrait phones would be its own piece of work.

### Levels are set by hand
Per-layer `gain=` with no auto-normalization, chosen deliberately for control.
Consequence: adding layers or stacking overlapping tails can clip, and the fix
is to dial gains down yourself. The clipping warning suggests a specific value
that resolves it.

### Very high LCMs lose grid resolution
Beats land on an integer grid of pulses, `LCM` of them per cycle. A cycle of
C seconds at sample rate R therefore needs `LCM <= C * R` for at least one
sample per pulse, and comfortably fewer than that to place beats accurately.

Measured at a 2s cycle, 44.1 kHz: 3/4/5/7/11 (LCM 4620) renders a 1.990s
cycle, 0.5% off and inaudible. Adding a 13 (LCM 60060) leaves 1.47 samples
per pulse, which rounds to 1 and collapses the cycle to 1.36s — the tool
warns when the rounded cycle differs from the requested one by over 1%.

Fixable if it ever bites, by computing each event's position directly from
its fractional position in the cycle instead of snapping to a pulse grid.
Not worth doing until someone actually wants six coprime layers.

## Open questions

### Rest behaviour may not be right — revisit first

Flagged at the end of the first session, unresolved and deliberately not
acted on. The doubt is about rests shifting position each cycle: a rest
travels with the sequence, so when the sequence length differs from the beat
count the silence lands on a different beat each time round. That is what
was built and it is what the checks assert, but it may not be the musically
useful behaviour, or may not be the only one wanted.

Next step is to play with examples and work out what it *should* do before
changing anything. The `rests` example is the place to start — try making
the sequence exactly as long as the beat count, which pins the rest in place,
and compare.

**You can see it rather than work it out.** Open the page and pick the
`rests` example: the rest marks wander across the pluck row (7 steps over 5
beats) and the kick row (6 over 8), but stay put on the bell's (3 over 3).
Still no behaviour changed. Since phase 11, tapping a step in a layer's step
strip outlines every place that step lands, and edits are heard at the next
cycle -- so trying variations is now quick.

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

### Sections — variations across cycles (high priority)

Treat a cycle as a bar, and let a piece be a sequence of sections that share
a polyrhythmic base but vary what sits on top: which beats are active, which
scale, which notes, gains, maybe samples. Four bars with the same skeleton
and different detail is most of what turns a loop into an arrangement, and
it is the largest musical gap in the tool as it stands.

Design notes from thinking it through, so the work does not start cold:

- **The schedule is already the right seam.** A section produces its own
  events and they get offset by the cycles already elapsed. `render_audio`
  would not change at all, the same way beat skipping did not touch it.
- **The LCM must be computed across every section, not per section.** If
  section 2 introduces a layer with a different beat count, the pulse grid
  changes, and a grid that changed mid-piece would break the timing
  guarantees. Take the LCM of all beat counts in the whole piece up front.
- **Variation is best expressed as an override, not a re-declaration.**
  Repeating every layer per section would be miserable to write and easy to
  get inconsistent. Something closer to: declare the layers once, then
  per-section state only what differs.
- **Section length wants to be in cycles**, since the cycle is the bar.
- **Interacts with drift (phase 12).** Sections are deliberate variation;
  drift is gradual variation. They are different answers to the same
  musical problem and it is worth deciding whether they coexist or whether
  one makes the other redundant before building the second one.

### Smaller items

- **Sample sets per layer.** Was phase 6; dropped back to the backlog. One
  sample per layer, pitch-shifted, is the model. If it returns, the samples
  list should be length 1 or exactly the length of the pitch sequence, so a
  layer keeps ONE period: an independently cycling sample list would give
  4 beats / 12 notes / 5 samples a 15-cycle repeat that nobody can author or
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
  which loses resolution at very high LCMs (see above). Computing each
  event's position from its fractional position in the cycle would remove
  the limit entirely.
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
- **Rename `loops` to `cycles`.** They are the same unit, and having two
  words for it is the one genuinely confusing bit of vocabulary. Would want
  doing in one go, with the old spelling accepted for a while -- saved pieces
  use `loops`.
- **BPM referenced to a named layer.** `--cycle-duration` is the honest
  control, but "put layer 2 at 120 bpm" is how a musician would ask.

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
- **Edits come in at the next cycle, counted in cycles.** The player keeps
  its position as a cycle count, not seconds, because an edit can change the
  cycle length; the new version starts on the downbeat of the cycle playback
  was about to reach, and the old one fades over 15 ms.
- **Mute and solo are saved in the piece**, as a DAW keeps them. Solo wins
  over mute. Silent layers stay drawn, faded, with their name saying why, and
  are left out of the WAV and of "sounding together".
- **The piece is kept in the browser's storage** between visits: a
  convenience against reloads, not a save. Safari can clear it.
- **Test the page by driving Chrome, not by dumping it.** `--dump-dom` runs on
  a simulated clock that races ahead of real work; `test/browser.js` talks to
  Chrome over its debugging protocol and waits for real conditions.
