# How RanDAW should look and feel

The rules the page is held to, so that every change -- by a person or by
Claude -- is checked against the same thing. The values live in
`web/page.html` (the `:root` block); this file says what they are for and
what not to do with them. When the two disagree, fix one of them.

## What the page is for

A musician makes a loop by ear, on an iPad, and hears every change at the
next bar. So, in order:

1. **The drawing is the product.** It shows what you hear. Everything else
   is there to change it, and should be quieter than it.
2. **Change it where you look.** A control belongs as close as possible to
   the part of the drawing it changes.
3. **Nothing hidden by default that is used every minute.** Play, tempo,
   and switching beats on and off are always one tap away. Saving and
   exporting can live one step further.

## The main device

An 11-inch iPad held sideways: **1180 × 820** CSS pixels. It must also work
upright (820 × 1180), on a laptop (1440 × 900) and not break on a phone
(390 × 844). `npm run shots` in `web/` takes all of these, light and dark.

## Colour

Defined once, as custom properties on `:root`, with a separately checked set
for dark mode (never an automatic inversion).

| Token | Use |
|---|---|
| `--page`, `--surface`, `--row` | Background, panels, the band behind each layer. Three steps, no more. |
| `--ink` | Main text, the playhead, the one primary button (Play). |
| `--ink-2` | Secondary text and labels. |
| `--ink-3` | Quiet text. Must reach 4.5:1 against `--page` and `--surface`. |
| `--muted` | Lines and hatching **in the drawing only** (3:1 is the bar for graphics). Never text. |
| `--grid`, `--bar` | Base beat lines and bar lines; control borders. |
| `--warn`, `--error` | Messages only. |
| `--s1` … `--s5` | The five layer colours. Colourblind-checked as neighbours. A layer colour only ever means "this layer". |

- Text on a layer colour is `--mark-ink` (near-black), in both modes.
- A new colour needs a reason it cannot be one of the above.

## Type

- One family: the system UI face. Numbers that change (clock, tempo, beat
  counts) use `font-variant-numeric: tabular-nums` so they do not jiggle.
- Sizes: 22 (piece title), 16 (layer names, inputs -- 16 also stops iPhones
  zooming into a field), 15 (body, buttons), 13 (labels, hints), 12 (in the
  drawing). Nothing smaller than 12.
- Weights: 400, 600/650 for names and the active choice, 700 for the title.

## Space and shape

- Spacing steps: 4, 6, 8, 10, 12, 16, 24. Pick from these.
- Corners: 8 for controls, 12 for panels and cards, 4 for bands in the drawing.
- **Touch targets at least 44 px** in the direction a finger comes from; 36
  is the floor for secondary buttons where space is tight, never below.

## The drawing

- **On must be louder than off.** A sounding beat is the strongest mark in
  its row; a switched-off beat is the quietest thing that is still visible.
- Pitch goes up the row (grid) or outwards (rings).
- The playhead is `--ink`, the highest-contrast line on the page.
- A silent layer (muted, or another soloed) stays drawn, faded, and its name
  says why.
- Motion only where it carries meaning (a note lighting as it sounds), and
  none beyond colour when the device asks for reduced motion.

## Controls

- Exactly one primary button on screen: Play.
- A choice between a few options is a segmented control (Grid | Rings |
  Polygons), not a menu.
- Every icon-only button has an `aria-label`. Real `<button>`, `<input>`,
  `<select>` elements only.
- Errors say what is wrong and what would fix it, next to where it happened.

## Don't

- No gradients, drop shadows for decoration, or emoji.
- No coloured left-border cards as decoration. (The layer cards' colour
  edge is information: it says which layer.)
- No new dependency, web font or network request: the page must work opened
  from a file, offline, and emailed.
- No grey text lighter than `--ink-3`.

## Checking a change

1. `cd web && npm test` -- the checks.
2. `npm run shots` (or `node shots.js --only=ipad`, `--full` for the whole
   page) -- then look at `web/dist/shots/`, iPad first, light and dark.
3. Read this file against the pictures.
