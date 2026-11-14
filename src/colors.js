// Cyan-blue visual theme for hncode. Adapts to the terminal's color depth:
// uses true-color when available, 256/16-color fallbacks otherwise.

function colorDepth() {
  try { return process.stdout.getColorDepth?.() || 0; } catch { return 0; }
}
const DEPTH = colorDepth();
export const TRUECOLOR = DEPTH >= 24 || process.env.COLORTERM === 'truecolor' || /^xterm.*-256color$|.*-truecolor$/.test(process.env.TERM || '');

function rgb(r, g, b) { return TRUECOLOR ? `\x1b[38;2;${r};${g};${b}m` : `\x1b[38;5;${ansi256(r, g, b)}m`; }
function brgb(r, g, b) { return TRUECOLOR ? `\x1b[48;2;${r};${g};${b}m` : `\x1b[48;5;${ansi256(r, g, b)}m`; }

// Quantize a truecolor triple to the nearest 256-colour xterm index.
//
// Two different palettes live in xterm-256 and they must not be confused:
//   * the 6x6x6 COLOUR CUBE (16..231): each channel has 6 levels — 0, then
//     95,135,175,215,255 — so the step is 40 above a floor of 35, not 51;
//   * the GREY RAMP (232..255): 24 levels from rgb(8) to rgb(238), steps of 10.
//
// The grey case used to be `232 + Math.round(v / 51)`, which collapses a whole range of
// greys onto a few ramp entries: rgb(46,46,46) — the panel surface — quantised to 233,
// i.e. rgb(18,18,18), three steps darker than asked for. The panel then read as a
// near-black hole instead of a raised surface. Quantising against the ramp's own step
// fixes that.
function ansi256(r, g, b) {
  const cube = (v) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.round((v - 35) / 40)));
  // A triple that is (nearly) neutral belongs on the grey ramp, which has finer steps
  // than the cube's 6 levels: rgb(46,46,46) is not representable in the cube at all.
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min <= 8) {
    const v = (r + g + b) / 3;
    const n = Math.max(0, Math.min(23, Math.round((v - 8) / 10)));
    return 232 + n;
  }
  return 16 + 36 * cube(r) + 6 * cube(g) + cube(b);
}

// Brand accent: cyan-blue.
// A BACKGROUND escape at the terminal's own colour depth: the exact triple under
// truecolor, the nearest palette index otherwise.
//
// Exported because a caller computing a NEW colour at paint time — the backdrop dimming
// does, when it pulls a fill toward the page — has to state its result in the same notation
// the untouched fills use. Emitting `48;2;…` unconditionally loses the fill entirely on a
// 256-colour terminal, which silently ignores what it does not implement.
export const bgRgb = brgb;

export const TEAL = rgb(0, 184, 219);
export const CYAN = rgb(0, 215, 255);
export const BLUE = rgb(66, 135, 245);
export const FG = TEAL;                   // primary fg
export const BG = rgb(0, 18, 26);
export const BORDER = rgb(70, 130, 180);

// Named accent colours per theme. `auto` keeps the brand cyan-blue and lets the
// terminal's own palette show through for everything else; `dark`/`light` pick
// accent triples that stay readable on that background.
const THEMES = {
  // `auto` is deliberately NOT a table here: it is a CHOICE, resolved by `setTheme` into
  // `light` or `dark` from the terminal's background. A table named `auto` shadows that,
  // and did — it was a fixed dark palette with brand-cyan text, while its own label claimed
  // it followed the terminal.
  dark: {
    fg: [255, 255, 255], bg: [0, 18, 26], // White foreground for normal text
    fg: [255, 255, 255], bg: [0, 18, 26], // White foreground for normal text
    teal: [0, 184, 219], cyan: [0, 215, 255], blue: [66, 135, 245], border: [70, 130, 180],
    // The semantic colours. They were missing, and `setTheme` guards each assignment, so
    // they kept the previous theme's values — a theme that only looks right after a
    // particular one was applied.
    red: [230, 80, 80], green: [120, 200, 120], yellow: [230, 200, 100], orange: [240, 160, 80],
    white: [255, 255, 255], gray: [130, 140, 150],
    hover: [190, 245, 255], selBg: [0, 70, 84],
    surface: [46, 46, 46],
  },
  light: {
    fg: [26, 26, 26], bg: [255, 255, 255],
    teal: [0, 102, 128], cyan: [0, 122, 153], blue: [10, 77, 158], border: [138, 155, 176],
    hover: [0, 78, 102], selBg: [200, 230, 239],
    red: [179, 38, 30], green: [30, 122, 60], yellow: [160, 120, 0], orange: [178, 90, 0],
    white: [26, 26, 26], gray: [85, 85, 85],
    // A LIGHT surface is a grey that is darker than the white page but far lighter than
    // the dark themes' — a panel has to read as raised in whichever direction the theme
    // goes, and reusing #2e2e2e on white would be a black box.
    surface: [232, 232, 232],
  },
  // The four below are the same SHAPE as `dark` with the accent hue moved, so every
  // derived colour in `setTheme` (the scrollbar shades, hover, and the light/dark branch
  // test) keeps working with no special case. Each keeps ONE accent family varying only in
  // lightness, because the context bar's five fills read as a gradient and a second hue in
  // that ramp makes the bar look broken.
  nord: {
    fg: [216, 222, 233], bg: [46, 52, 64],
    teal: [136, 192, 208], cyan: [143, 188, 187], blue: [129, 161, 193], border: [94, 129, 172],
    hover: [236, 239, 244], selBg: [59, 66, 82],
    red: [191, 97, 106], green: [163, 190, 140], yellow: [235, 203, 139], orange: [208, 135, 112],
    white: [236, 239, 244], gray: [129, 135, 148],
    surface: [59, 66, 82],
  },
  dracula: {
    fg: [248, 248, 242], bg: [40, 42, 54],
    teal: [139, 233, 253], cyan: [139, 233, 253], blue: [98, 114, 164], border: [98, 114, 164],
    hover: [255, 121, 198], selBg: [68, 71, 90],
    red: [255, 85, 85], green: [80, 250, 123], yellow: [241, 250, 140], orange: [255, 184, 108],
    white: [248, 248, 242], gray: [98, 114, 164],
    surface: [68, 71, 90],
  },
  gruvbox: {
    fg: [235, 219, 178], bg: [40, 40, 40],
    teal: [142, 192, 124], cyan: [131, 165, 152], blue: [69, 133, 136], border: [146, 131, 116],
    hover: [250, 189, 47], selBg: [60, 56, 54],
    red: [251, 73, 52], green: [184, 187, 38], yellow: [250, 189, 47], orange: [254, 128, 25],
    white: [235, 219, 178], gray: [146, 131, 116],
    surface: [60, 56, 54],
  },
  mono: {
    // No hue at all: every accent is a grey, so the UI is readable on a monochrome
    // terminal or for anyone who needs colour off without losing the structure that
    // colour was carrying. The lightness steps are what keep the context bar legible.
    fg: [230, 230, 230], bg: [18, 18, 18],
    teal: [190, 190, 190], cyan: [210, 210, 210], blue: [150, 150, 150], border: [110, 110, 110],
    hover: [255, 255, 255], selBg: [60, 60, 60],
    red: [200, 90, 90], green: [140, 190, 140], yellow: [200, 190, 120], orange: [210, 160, 110],
    white: [240, 240, 240], gray: [130, 130, 130],
    surface: [42, 42, 42],
  },
  catppuccin: {
    // Mocha: a warm-tinted dark with pastel accents. Every accent is desaturated toward
    // the background so long replies do not glare, which is the whole point of the palette.
    fg: [205, 214, 244], bg: [30, 30, 46],
    teal: [137, 180, 250], cyan: [137, 220, 235], blue: [137, 180, 250], border: [108, 112, 134],
    hover: [203, 166, 247], selBg: [49, 50, 68],
    red: [243, 139, 168], green: [166, 227, 161], yellow: [249, 226, 175], orange: [250, 179, 135],
    white: [205, 214, 244], gray: [127, 132, 156],
    surface: [49, 50, 68],
  },
  tokyo: {
    // Night: a blue-black with high-contrast accents. Distinct from nord, which is greyed
    // out; this keeps the blue in the background and lets the cyan carry the structure.
    fg: [192, 202, 245], bg: [26, 27, 38],
    teal: [125, 207, 255], cyan: [125, 207, 255], blue: [122, 162, 247], border: [86, 95, 137],
    hover: [187, 154, 247], selBg: [41, 46, 66],
    red: [247, 118, 142], green: [158, 206, 106], yellow: [224, 175, 104], orange: [255, 158, 100],
    white: [192, 202, 245], gray: [86, 95, 137],
    surface: [41, 46, 66],
  },
  solar: {
    // Solarized LIGHT. Included because `light` is a plain neutral and solarized's even
    // hue ramp is the best-tested light palette in the terminal world. The dark variant is
    // `solar-dark`, so both exist; the light one is the one worth having.
    fg: [101, 123, 131], bg: [253, 246, 227],
    teal: [38, 139, 210], cyan: [38, 139, 210], blue: [108, 113, 196], border: [147, 161, 161],
    hover: [211, 54, 130], selBg: [238, 232, 213],
    red: [220, 50, 47], green: [133, 153, 0], yellow: [181, 137, 0], orange: [203, 75, 22],
    white: [253, 246, 227], gray: [147, 161, 161],
    surface: [238, 232, 213],
  },
  rose: {
    // Pine: a muted mauve dark, between dracula's saturation and nord's restraint.
    fg: [224, 222, 244], bg: [25, 23, 36],
    teal: [196, 167, 231], cyan: [137, 180, 250], blue: [137, 180, 250], border: [110, 106, 134],
    hover: [196, 167, 231], selBg: [31, 29, 46],
    red: [215, 130, 126], green: [156, 207, 216], yellow: [234, 157, 173], orange: [235, 188, 186],
    white: [224, 222, 244], gray: [110, 106, 134],
    surface: [31, 29, 46],
  },
};
/** Theme name -> one-line description, for the /theme picker. */
export const THEME_LABELS = {
  auto: 'follow the terminal: light theme on a light background, dark otherwise',
  dark: 'dark teal background, white text',
  light: 'light background, darkened accents',
  nord: 'cool blue-grey',
  dracula: 'high-contrast purple and pink',
  gruvbox: 'warm retro earth tones',
  catppuccin: 'soft pastel, warm-tinted dark',
  tokyo: 'blue-black, high-contrast accents',
  solar: 'even hue ramp, light background',
  rose: 'muted mauve dark',
  mono: 'greyscale, no hue',
};

/** `auto` is a name you can set without being a palette, so it is listed separately from
 *  the tables — see `setTheme` for how it resolves. */
export const AUTO_THEME = 'auto';

/** Whether a theme name is one we know. */
export function hasTheme(name) {
  return name === AUTO_THEME || Object.prototype.hasOwnProperty.call(THEMES, name);
}

/** The names a user may choose, `auto` first because it is the default. */
export const THEME_NAMES = [AUTO_THEME, ...Object.keys(THEMES)];

/** True when a theme paints on a light background. Resolves `auto` first, so a caller
 *  asking about the CURRENT theme gets the answer for what is actually on screen. */
export function isLightTheme(name) {
  const resolved = name === AUTO_THEME ? (autoIsLight ? 'light' : 'dark') : name;
  const t = THEMES[resolved];
  return !!(t && Array.isArray(t.bg) && t.bg[0] > 128);
}

export const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  // Italic (SGR 3). Used for the BODY of a reasoning block — the prose reads as
  // an aside rather than as the answer. Must be closed with SGR 23 (`endItalic`),
  // NOT with `reset`, because resetting also drops the surrounding dim/gray that
  // the same row depends on. Terminals without italic fall back to normal text,
  // so this is a decoration, never load-bearing.
  italic: '\x1b[3m',
  endItalic: '\x1b[23m',
  muted: '\x1b[90m',
  teal: TEAL,
  cyan: CYAN,
  // The mark's shadow: the same cyan at 40% brightness. `dim` (SGR 2) is applied by the TERMINAL and most render
  // it barely darker; `teal` is only ~15% off `cyan`. Neither reads as a shadow behind the letters.
  cyanDeep: rgb(0, 86, 102),
  // The startup heading: the grey the annotations use, lifted towards white. The wordmark above it owns the cyan,
  // so the name under it is a lighter neutral rather than a second colour competing with the mark.
  heading: rgb(200, 210, 220),
  // DIFF COLOURS ARE DERIVED FROM THE THEME, not fixed.
  //
  // A diff paints two layers: the whole changed LINE gets a wash, and the words that actually differ get a
  // stronger one. Those have to sit on THIS theme's background — the Islands Dark tints read as a warm grey on
  // gruvbox and as nothing at all on `light`. `setTheme` recomputes all four from the theme's own `green`, `red`
  // and `bg`, so switching themes recolours the diff with everything else. The values here are the dark defaults,
  // used before any theme is applied.
  diffAddBg: brgb(34, 58, 38),
  diffAddWordBg: brgb(52, 96, 58),
  diffDelBg: brgb(74, 32, 34),
  diffDelWordBg: brgb(112, 44, 48),
  diffAddFg: rgb(133, 208, 143),
  diffDelFg: rgb(255, 176, 168),
  // A code comment. `setTheme` mixes it from the palette's foreground towards its background, so it is quiet without
  // disappearing — `C.gray` is tuned for the page and vanishes on a diff wash in several themes.
  comment: '\x1b[90m',
  fg: FG,
  bg: BG,
  bgTeal: brgb(0, 184, 219),
  bgDim: brgb(12, 24, 30),
  // Fills for the segmented context bar: five blues in one family, deepening towards
  // black, plus a neutral free segment. Background colours, because the bar is read by
  // FILL rather than by any text — a segment is usually only a few columns wide, so a
  // letter inside it would be unreadable noise.
  //
  // The steps are deliberately narrow. Widening them makes the bar easier to tell apart
  // at a glance but harder to keep a dark terminal readable, and the darkest member has
  // to stay distinguishable from the page background it sits on.
  ctxSystem: brgb(35, 48, 95),      // deepest navy
  ctxPrompt: brgb(43, 61, 120),     // navy
  ctxAssistant: brgb(52, 74, 146),  // indigo
  ctxThinking: brgb(77, 107, 254),  // brand blue, the brightest used segment
  ctxTools: brgb(90, 124, 255),     // light blue
  ctxFree: brgb(46, 46, 46),        // neutral grey: "nothing here yet"
  // The SURFACE colour for a floating panel (picker menus, dialogs). A NEUTRAL GREY,
  // deliberately separate from the theme's `bg`:
  //
  //   * the theme background is `[0, 18, 26]` — a dark TEAL. A raised surface should be
  //     neutral in every theme; only the ACCENTS carry the brand hue. Reusing `bg` for
  //     the panel made every popup read blue, which is not what a panel is.
  //   * `applyTheme` used to overwrite this with `t.bg`, so the value here only applied
  //     before a theme was set. It is no longer touched by the theme.
  //
  // xterm-256's grey ramp runs 232..255 from rgb(8) to rgb(238) in steps of 10, so 236
  // is rgb(48,48,48) = #303030 — clearly lifted off a near-black terminal without
  // washing the text out. Truecolor gets `#2e2e2e`, the same shade written exactly.
  bgPanel: TRUECOLOR ? '\x1b[48;2;46;46;46m' : '\x1b[48;5;236m',
  border: BORDER,
  red: '\x1b[91m',
  green: '\x1b[92m',
  yellow: '\x1b[93m',
  magenta: '\x1b[95m',
  gray: '\x1b[90m',
  white: '\x1b[97m',
  orange: TRUECOLOR ? rgb(255, 140, 0) : '\x1b[38;5;208m',
  // Cyan pushed slightly toward green — used for the Swarm mode badge so it reads
  // as its own mode next to Plan (pure cyan) and Focus (blue) while staying in the
  // theme's blue-green family. 38;5;43 is rgb(0,215,175): red at zero and green
  // only 40 above blue, i.e. still clearly cyan with a green cast. 38;5;85 was the
  // first attempt and read as plain GREEN — its red channel is lifted to 95 and
  // green pins at 255, which is a spring green, not a green-tinted cyan.
  spring: TRUECOLOR ? rgb(0, 215, 175) : '\x1b[38;5;43m',
  // Git branch in the status line: yellow pulled about half way toward white, so
  // it stays clearly "yellow" (not cream/ivory) while reading brighter than the
  // plain 93 yellow on a dark background. rgb(255,219,110) keeps red at max,
  // green near it, and blue around 43% — that ratio is what keeps the hue
  // yellow rather than dropping into orange.
  branch: TRUECOLOR ? rgb(255, 219, 110) : '\x1b[38;5;222m',
  // Shell-mode (`!`) accent — violet, matching kimi-code's shellMode token so the
  // bash-mode editor border and the `!` read as "shell", distinct from the cyan
  // prompt and the yellow git badge. #BD93F9 dark / #7C3AED light.
  shellMode: TRUECOLOR ? rgb(189, 147, 249) : '\x1b[38;5;141m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  // Selection highlight (mouse text selection) and the scrollbar gutter.
  // Selection uses a dark teal background so white text stays readable.
  selBg: TRUECOLOR ? brgb(0, 70, 84) : '\x1b[48;5;23m', // Original dark cyan background
  // Reset ONLY the background colour, keeping the current foreground. Used to end
  // a selection highlight so text after it keeps its own colour (a bare ESC[0m
  // would also reset the foreground, turning a cyan/white run grey).
  bgReset: '\x1b[49m',
  // Scrollbar, styled after OpenTUI (what cline uses): a solid block thumb on a
  // near-black track. Only the FOREGROUND colour is stateful — the track is always the
  // background — because that is how OpenTUI's SliderRenderable paints a cell:
  // foreground = thumb, background = track. A `█` covers both columns with the
  // foreground, while `▀`/`▄` expose one half to the track, so the two colours must
  // stay DISTINCT; giving a half-cell the thumb colour as its background is what made
  // it read as a second square, and it also survived the modal backdrop's faint
  // attribute, which fades the foreground only.
  //   track  #252527    thumb  #9a9ea3        (OpenTUI's defaults, inlined)
  //   hover  #d2d6da    active #ffffff        (brighter thumb, not a new hue)
  scrollTrackBg: TRUECOLOR ? brgb(0x25, 0x25, 0x27) : '\x1b[48;5;235m',
  scrollTrackFg: TRUECOLOR ? rgb(0x25, 0x25, 0x27) : '\x1b[38;5;235m',
  scrollThumbBg: TRUECOLOR ? brgb(0x9a, 0x9e, 0xa3) : '\x1b[48;5;246m',
  scrollThumbFg: TRUECOLOR ? rgb(0x9a, 0x9e, 0xa3) : '\x1b[38;5;246m',
  scrollThumbHoverBg: TRUECOLOR ? brgb(0xd2, 0xd6, 0xda) : '\x1b[48;5;252m',
  scrollThumbHoverFg: TRUECOLOR ? rgb(0xd2, 0xd6, 0xda) : '\x1b[38;5;252m',
  scrollThumbActiveBg: TRUECOLOR ? brgb(0xff, 0xff, 0xff) : '\x1b[48;5;231m',
  scrollThumbActiveFg: TRUECOLOR ? rgb(0xff, 0xff, 0xff) : '\x1b[38;5;231m',
  // FOREGROUND aliases kept for the todo/queue resize rule, which draws a `─` line
  // and therefore needs a foreground, not the block's background pair.
  scrollThumbActive: TRUECOLOR ? rgb(0xff, 0xff, 0xff) : '\x1b[38;5;231m',
  scrollThumbHover: TRUECOLOR ? rgb(0xd2, 0xd6, 0xda) : '\x1b[38;5;252m',
  // Legacy foreground forms, still referenced by the gutter-hover path.
  scrollTrack: '\x1b[90m',
  scrollThumb: TRUECOLOR ? rgb(0, 184, 219) : '\x1b[38;5;37m',
  // Hover highlight for clickable rows (menu items, picker options, form
  // fields, composer rows). An explicit bright foreground + BOLD rather than a
  // bare BOLD: BOLD only brightens the 16-colour palette (it does nothing to a
  // true-color row), which is why hover used to be invisible on most rows.
  // tintRange() re-applies this so the row's own SGR codes cannot cancel it.
  hover: '\x1b[1m' + rgb(190, 245, 255),
};

export function style(text, ...codes) {
  return codes.join('') + text + '\x1b[0m';
}

// Linearly interpolate between two RGB triples and return an ANSI colour string.
// Used for the pulsing Working indicator (orange pulses to a brighter/darker
// shade over a 2s cycle).
export function lerpColor(r1, g1, b1, r2, g2, b2, t) {
  const ti = Math.max(0, Math.min(1, t));
  const r = Math.round(r1 + (r2 - r1) * ti);
  const g = Math.round(g1 + (g2 - g1) * ti);
  const b = Math.round(b1 + (b2 - b1) * ti);
  return rgb(r, g, b);
}

// Which concrete theme `auto` resolves to right now. `setTheme` keeps it so a repaint or a
// `/theme auto` after a terminal probe lands on the same answer.
let autoIsLight = false;

// The theme `setTheme` last applied, resolved (so `auto` reports the concrete name it
// became). Read by the render cache: a cached row holds finished escapes, so a palette
// change has to invalidate them or the old colours survive the switch.
let appliedTheme = '';

/** The concrete theme in force, or `''` before the first `setTheme`. */
export function currentTheme() { return appliedTheme; }

/**
 * Tell `setTheme` whether the terminal has a light background.
 *
 * The probe lives in term-caps.js and this module is a leaf that imports nothing, so the
 * answer has to be handed in. Called once after the probe and again if the terminal is
 * resized on a different display.
 */
export function setLightBackground(light) {
  autoIsLight = !!light;
}

// Apply a named theme IN PLACE. `C` is a module-level object and ESM imports are
// live bindings, so mutating its properties here changes the colours everywhere
// without re-importing. Returns true when the name was recognised.
//
// `auto` is a CHOICE, not a palette: it resolves to `light` on a light terminal and to
// `dark` otherwise, and then applies that theme's colours. It used to be a fixed table —
// a dark background with brand-cyan text — which is not what "auto" means and not what its
// own label claimed ("on the terminal's own palette"). The user asking for auto is asking
// not to have to think about it.
export function setTheme(name) {
  const resolved = name === 'auto' ? (autoIsLight ? 'light' : 'dark') : name;
  const t = THEMES[resolved];
  if (!t) return false;
  appliedTheme = resolved;


  
  // Update foreground colors
  C.teal = rgb(...t.teal);
  C.fg = rgb(...t.fg);
  C.cyan = rgb(...t.cyan);
  C.blue = rgb(...t.blue);
  C.border = rgb(...t.border);
  // Update background colors
  C.bg = brgb(...t.bg);
  C.bgTeal = brgb(...t.teal);
  // The panel surface is NEUTRAL GREY and comes from the theme's own `surface` triple,
  // NOT from `bg`. It used to be set to `t.bg` (a dark teal), which made every popup
  // carry a blue cast; a raised surface must be neutral, with only the accents following
  // the brand hue. A light theme gets a light grey so the panel still reads as raised.
  if (t.surface) C.bgPanel = brgb(...t.surface);
  C.selBg = brgb(...t.selBg);
  
  // Scrollbar colours. The thumb is a BLOCK, so its colour goes on BOTH the
  // foreground and the background (a half-cell `▀`/`▄` shows the foreground, a full
  // `█` shows the background — they must match). Hover / drag are brighter shades
  // of the same hue, applied to the same pair, so the whole thumb changes together.
  const active = [
    Math.min(255, Math.round(t.teal[0] * 0.6 + 255 * 0.4)),
    Math.min(255, Math.round(t.teal[1] * 0.6 + 255 * 0.4)),
    Math.min(255, Math.round(t.teal[2] * 0.6 + 255 * 0.4)),
  ];
  const hover = t.hover || [190, 245, 255];
  C.scrollTrackFg = rgb(0x25, 0x25, 0x27);
  C.scrollTrackBg = brgb(0x25, 0x25, 0x27);
  C.scrollThumbFg = rgb(...t.teal);
  C.scrollThumbBg = brgb(...t.teal);
  C.scrollThumbHoverFg = rgb(...hover);
  C.scrollThumbHoverBg = brgb(...hover);
  C.scrollThumbActiveFg = rgb(...active);
  C.scrollThumbActiveBg = brgb(...active);
  // Foreground aliases for the todo/queue resize rule.
  C.scrollTrack = '\x1b[90m';
  C.scrollThumb = rgb(...t.teal);
  C.scrollThumbHover = rgb(...hover);
  C.scrollThumbActive = rgb(...active);

  // Hover stays visible on this theme's background (bright on dark, dark on light).
  C.hover = '\x1b[1m' + rgb(...(t.hover || [190, 245, 255]));

  // Semantic colors — swap to deep versions on light backgrounds.
  if (t.white)  C.white  = rgb(...t.white);
  if (t.gray)   C.gray   = rgb(...t.gray);
  if (t.red)    C.red    = rgb(...t.red);
  if (t.green)  C.green  = rgb(...t.green);
  if (t.yellow) C.yellow = rgb(...t.yellow);
  if (t.orange) C.orange = rgb(...t.orange);
  // The git branch colour is derived per theme: the pale yellow that reads well
  // on the dark background is nearly invisible on white, so on a light theme it
  // is darkened (keeping the same hue) instead of being left as-is.
  if (t.bg && t.bg[0] > 128) {
    C.branch = rgb(146, 106, 0);           // dark amber for light backgrounds
  } else {
    C.branch = TRUECOLOR ? rgb(255, 219, 110) : '\x1b[38;5;222m';
  }
  // DIFF TINTS, mixed from this theme's own green/red towards its background.
  //
  // A line wash is a WEAK mix and a word wash a STRONGER one of the same pair: weak enough that ordinary text on it
  // still reads as text, strong enough that the block is visible without reading it. Mixing towards `t.bg` rather
  // than towards black is what makes a light theme work — a dark red wash on white is a black bar with letters in
  // it, while a pale red is a highlighter mark.
  const mix = (a, b, k) => a.map((v, i) => Math.round(v * k + b[i] * (1 - k)));
  const green = t.green || [120, 200, 120];
  const red = t.red || [230, 80, 80];
  // ABOUT HALF. Lower mixes disappear into a dark page — the wash has to be obvious without being read, and at
  // 16% an added block looked like ordinary text with a faint tint. Light backgrounds need slightly more still,
  // because the same distance in RGB is a smaller difference next to white.
  const isLight = t.bg && t.bg[0] > 128;
  const line = isLight ? 0.52 : 0.46;
  const word = isLight ? 0.68 : 0.62;
  C.diffAddBg = brgb(...mix(green, t.bg, line));
  C.diffAddWordBg = brgb(...mix(green, t.bg, word));
  C.diffDelBg = brgb(...mix(red, t.bg, line));
  C.diffDelWordBg = brgb(...mix(red, t.bg, word));
  // The sign and the text of a changed line are the same hue as its wash, pulled towards the theme's own foreground
  // so they read ON that wash — not the theme's plain green/red, which is tuned for the page background.
  C.diffAddFg = rgb(...mix(green, t.fg, 0.55));
  C.diffDelFg = rgb(...mix(red, t.fg, 0.55));

  // A comment: the palette's foreground, pulled most of the way towards its background so it reads as quiet. A dark
  // page can afford a looser mix; a light one cannot — solar's foreground is already a muted blue-grey, and at the
  // dark theme's ratio its comments came within 8 of the removal wash.
  C.comment = rgb(...mix(t.fg, t.bg, isLight ? 0.86 : 0.72));

  return true;
}

export function clearScreen() {
  return '\x1b[3J\x1b[H\x1b[2J';
}

// Clear screen and set background color based on current theme
export function clearAndSetBg() {
  // Reset all attributes first
  const reset = '\x1b[0m';
  // Clear screen
  const clear = '\x1b[3J\x1b[H\x1b[2J';
  // Set background color using current C.bg value
  const bg = C.bg || '\x1b[48;2;0;18;26m'; // Default dark background
  return reset + clear + bg;
}
export function eraseLine() {
  return '\x1b[2K';
}
export function eraseScreen() {
  return '\x1b[2J';
}
export function moveTo(r, c) {
  return `\x1b[${r + 1};${c + 1}H`;
}
export function cursorUp(n) { return `\x1b[${n}A`; }
export function cursorDown(n) { return `\x1b[${n}B`; }
export function cursorLeft(n) { return `\x1b[${n}D`; }
export function cursorForward(n) { return `\x1b[${n}C`; }
export function hideCursor() { return '\x1b[?25l'; }
export function showCursor() { return '\x1b[?25h'; }
// Cursor shape: terminals accept DECSCUSR — 2 = block, 4 = underline, 6 = bar(I-beam);
// 1/3/5 = blinking variants. Force a solid block cursor so positioning is always exact
// and unaffected by I-beam alignment.
export function blockCursor() { return '\x1b[2 q'; }
export function underlineCursor() { return '\x1b[4 q'; }
export function barCursor() { return '\x1b[6 q'; }
export function alternateScreen(on) { return on ? '\x1b[?1049h' : '\x1b[?1049l'; }
export function setScrollRegion(top, bottom) {
  if (process.platform === 'win32') return ''; // win TTY scroll regions are unreliable
  return `\x1b[${top + 1};${bottom + 1}r`;
}
export function resetScrollRegion() {
  return '\x1b[r';
}
export function setBracketed(on) {
  return `\x1b[?2004h${on ? '' : ''}`; // placeholder; real impl toggles bracketed paste
}
