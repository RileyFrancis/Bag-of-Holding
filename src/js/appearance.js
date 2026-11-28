// =============================================================================
// APPEARANCE — the accent colours the app is drawn in, and the wheel that sets them
// =============================================================================
'use strict';

// theme.js owns light/dark (the palette); this owns the accent (the colour).
// A pick is a hue and saturation, never a lightness: each theme supplies the
// lightness its accent needs on its own background. `vars` holds the finished
// per-theme CSS properties, resolved at pick time, so a theme switch (and the
// no-flash script in <head>) never does colour maths. Applied only as
// properties on <html>, never inline styles. Stored per browser, not in the save.

const ACCENT_KEY = 'dnd_inventory_colors';

// The three roles, the tokens each drives, and each theme's saturation and
// lightness per token. Every figure is a tokens.css default measured back into
// HSL, so an untouched app and a custom colour are built the same way.
// A role can drive a family (`surface`: one hue at six lightnesses). The first
// token is the role's reference.
const ACCENT_ROLES = {
  primary: {
    label: 'Primary',
    tokens: [{ name: '--accent', light: { s: 66, l: 33 }, dark: { s: 61, l: 56 } }],
  },
  secondary: {
    label: 'Secondary',
    tokens: [{ name: '--accent-soft', light: { s: 46, l: 47 }, dark: { s: 52, l: 47 } }],
  },
  surface: {
    label: 'Panels',
    tokens: [
      { name: '--panel',   light: { s: 66, l: 91 }, dark: { s: 25, l: 12 } },
      { name: '--surface', light: { s: 55, l: 86 }, dark: { s: 29, l:  9 } },
      { name: '--field',   light: { s: 42, l: 78 }, dark: { s: 29, l:  6 } },
      { name: '--border',  light: { s: 37, l: 63 }, dark: { s: 28, l: 19 } },
      { name: '--border2', light: { s: 29, l: 50 }, dark: { s: 30, l: 28 } },
      { name: '--desk',    light: { s: 27, l: 48 }, dark: { s: 24, l:  4 } },

      // The inventory grid is deliberately not here: it keeps the palette's own colours.

      // `--bg` takes the panel's hue only, at a fixed OKLCH lightness and chroma
      // (perceptual lightness has to mean "this dark" for any hue). The lightness
      // mirrors tokens.css: the ground must clear its panels (OKLCH 0.247 dark, 0.95 light).
      { name: '--bg', oklch: { light: { l: 0.32, c: 0.04 }, dark: { l: 0.25, c: 0.04 } } },
    ],
  },
};

// Every property this module may write on <html>, so a reset can remove what it
// no longer sets and hand the palette back to tokens.css.
const ACCENT_MANAGED = ['--on-accent', '--crit', '--fumble', '--pending', '--spoiled'].concat(
  Object.values(ACCENT_ROLES).flatMap(r => r.tokens.map(t => t.name))
);

// A natural 20/1 is told apart from an ordinary (accent-coloured) roll by colour,
// so each gets an alternate in tokens.css (`--crit-alt`, `--fumble-alt`) used when
// the accent is too close to the main colour. "Too close" is either:
//   - near in OKLab: the palette's golds sit 0.11–0.18 from both, a mid red or
//     green pick 0.02–0.05; or
//   - the same hue family, however bright (a vivid green clears the distance test
//     but still reads as green). Judged only once the accent has real chroma.
const CRIT_MIN_DISTANCE = 0.08;
const CRIT_MIN_HUE_GAP = 22;     // degrees of OKLCH hue
const CRIT_HUE_MIN_CHROMA = 0.06;

// The reminder glow (`--pending`) and spoiled food's tint (`--spoiled`) have to
// stand out from the highlight colours and from the panels they sit on, so each
// is judged against every one of these that a custom colour has set, by the
// same test as the crit colours.
const CROWDING_AVOID_TOKENS = ['--accent', '--accent-soft', '--panel', '--surface'];

// The wheel face's lightness is clamped into a band where colour still reads
// (a panel at L 91% or 12% would be a flat disc). The swatch shows the true result.
const WHEEL_FACE_MIN = 38;
const WHEEL_FACE_MAX = 62;

// { primary: {h,s}|null, secondary: {h,s}|null, surface: {h,s}|null, vars: { light:{}, dark:{} } }
let accentPrefs = _getDefaultAccentPrefs();

// { light: { crit: {main, alt}, fumble: {main, alt}, pending: {main, alt} }, dark: {…} }, read once:
// the palette never changes at runtime.
let critPaletteCache = null;

let wheelRole = null;
let isWheelDragging = false;

function _getDefaultAccentPrefs() {
  const out = { vars: { light: {}, dark: {} } };
  Object.keys(ACCENT_ROLES).forEach(role => { out[role] = null; });
  return out;
}

// The token a role is named by: its swatch, its wheel face, and what its
// family's saturations are measured against.
function _getRoleReferenceToken(role) { return ACCENT_ROLES[role].tokens[0]; }

function _getCurrentThemeName() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

// ─── COLOUR MATHS ───
function _hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(100, s)) / 100;
  l = Math.max(0, Math.min(100, l)) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb;
  if (h < 60)       rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else              rgb = [c, 0, x];
  return '#' + rgb.map(v => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('');
}

// WCAG relative luminance: a saturated yellow and blue at the same HSL lightness
// are nowhere near equally bright.
function _getRelativeLuminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

// An sRGB colour in OKLab (sRGB → linear → LMS → OKLab), as [L, a, b].
function _getOklab(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const r = lin((n >> 16) & 255), g = lin((n >> 8) & 255), b = lin(n & 255);

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

// The OKLCH hue of an sRGB colour. Not the wheel's HSL hue (they disagree by tens
// of degrees); taking it from the resolved panel colour keeps the ground matched.
function _getOklchHue(hex) {
  const [, A, B] = _getOklab(hex);
  const h = (Math.atan2(B, A) * 180) / Math.PI;
  return h < 0 ? h + 360 : h;
}

// How different two colours look: straight-line OKLab distance, 0 = identical.
function _getColorDistance(a, b) {
  const p = _getOklab(a), q = _getOklab(b);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

// OKLCH chroma: how far from grey. Below a few hundredths the hue is noise.
function _getOklchChroma(hex) {
  const [, A, B] = _getOklab(hex);
  return Math.hypot(A, B);
}

// The angle between two colours' OKLCH hues, 0–180.
function _getHueGap(a, b) {
  const d = Math.abs(_getOklchHue(a) - _getOklchHue(b)) % 360;
  return Math.min(d, 360 - d);
}

function _getContrastRatio(a, b) {
  const la = _getRelativeLuminance(a), lb = _getRelativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// Whichever of the palette's two inks reads better on this fill.
function _getReadableInkOn(hex) {
  const css = getComputedStyle(document.documentElement);
  const ink = (css.getPropertyValue('--ink') || '#1a1206').trim();
  const paper = (css.getPropertyValue('--paper') || '#fdf6e4').trim();
  return _getContrastRatio(hex, ink) >= _getContrastRatio(hex, paper) ? ink : paper;
}

// ─── CRIT COLOURS ───
// Both palettes' crit colours, read out of tokens.css. The dark palette exists
// only under `[data-theme="dark"]`, so the attribute is flipped to read each and
// restored in the same synchronous turn, so nothing paints the wrong theme.
function _getCritPalette() {
  if (critPaletteCache) return critPaletteCache;
  const root = document.documentElement;
  const previousTheme = root.getAttribute('data-theme');
  const out = {};
  ['light', 'dark'].forEach(theme => {
    root.setAttribute('data-theme', theme);
    const css = getComputedStyle(root);
    const read = name => css.getPropertyValue(name).trim();
    out[theme] = {
      crit:   { main: read('--crit-main'),   alt: read('--crit-alt') },
      fumble: { main: read('--fumble-main'), alt: read('--fumble-alt') },
      pending: { main: read('--pending-main'), alt: read('--pending-alt') },
      spoiled: { main: read('--spoiled-main'), alt: read('--spoiled-alt') },
    };
  });
  if (previousTheme === null) root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', previousTheme);
  critPaletteCache = out;
  return out;
}

function _isTooCloseToAccent(accentHex, hex) {
  if (_getColorDistance(accentHex, hex) < CRIT_MIN_DISTANCE) return true;
  return _getOklchChroma(accentHex) > CRIT_HUE_MIN_CHROMA &&
         _getHueGap(accentHex, hex) < CRIT_MIN_HUE_GAP;
}

// The `--crit`/`--fumble` overrides this accent needs at one theme; empty when the
// main colours are distinct enough. The alternate is taken only when it is not
// itself too close, so a pick sitting between the two keeps the main.
function _getCritColorSwaps(accentHex, theme) {
  const out = {};
  const isHex = v => /^#[0-9a-f]{6}$/i.test(v);
  if (!isHex(accentHex)) return out;
  const pal = _getCritPalette()[theme];
  [['crit', '--crit'], ['fumble', '--fumble']].forEach(([key, prop]) => {
    const { main, alt } = pal[key];
    if (!isHex(main) || !isHex(alt)) return; // unreadable: leave the default
    if (_isTooCloseToAccent(accentHex, main) && !_isTooCloseToAccent(accentHex, alt)) {
      out[prop] = `var(${prop}-alt)`;
    }
  });
  return out;
}

// The `--pending` override for one theme's resolved colours; empty when the main
// red is distinct from every custom highlight and panel colour.
function _getPendingColorSwaps(themeVars, theme) {
  return _getCrowdedColorSwap(themeVars, theme, 'pending', '--pending');
}

// The `--spoiled` override, by the same test: a green accent or panel would
// hide the rot green, so it turns mould purple instead.
function _getSpoiledColorSwaps(themeVars, theme) {
  return _getCrowdedColorSwap(themeVars, theme, 'spoiled', '--spoiled');
}

// Points `prop` at its alternate when the main colour crowds any custom colour
// in CROWDING_AVOID_TOKENS. The alternate is taken only when it clears all of
// them, so a pick that crowds both keeps the main.
function _getCrowdedColorSwap(themeVars, theme, key, prop) {
  const isHex = v => /^#[0-9a-f]{6}$/i.test(v);
  const avoid = CROWDING_AVOID_TOKENS.map(t => themeVars[t]).filter(isHex);
  if (!avoid.length) return {};
  const { main, alt } = _getCritPalette()[theme][key];
  if (!isHex(main) || !isHex(alt)) return {};
  const isCrowded = hex => avoid.some(a => _isTooCloseToAccent(a, hex));
  return isCrowded(main) && !isCrowded(alt) ? { [prop]: `var(${prop}-alt)` } : {};
}

// ─── RESOLVING AND APPLYING ───
// Every token a role owns, at one theme. The pick supplies the hue; each token
// keeps its own lightness, and its saturation is scaled relative to the
// reference token so a family keeps its shape. The pinned lightness also stops a
// strong pick going garish.
function _resolveRoleTokens(role, pick, theme) {
  const tokens = ACCENT_ROLES[role].tokens;
  const refToken = tokens[0];
  const refSaturation = refToken[theme].s;
  const out = {};

  tokens.forEach(t => {
    if (t.oklch) return; // resolved below, off the finished reference colour
    const s = refSaturation ? pick.s * (t[theme].s / refSaturation) : pick.s;
    out[t.name] = _hslToHex(pick.h, Math.max(0, Math.min(100, s)), t[theme].l);
  });

  // Second pass: an `oklch` token reads the hue of the resolved reference.
  const refHex = out[refToken.name];
  tokens.forEach(t => {
    if (!t.oklch || !refHex) return;
    const { l, c } = t.oklch[theme];
    out[t.name] = `oklch(${l} ${c} ${_getOklchHue(refHex).toFixed(1)})`;
  });

  return out;
}

// Both themes up front, so the paint path never does maths.
function _computeAccentVars(prefs) {
  const out = { light: {}, dark: {} };

  ['light', 'dark'].forEach(theme => {
    const primary = prefs.primary;
    if (primary) {
      Object.assign(out[theme], _resolveRoleTokens('primary', primary, theme));
      out[theme]['--on-accent'] = _getReadableInkOn(out[theme]['--accent']);
      Object.assign(out[theme], _getCritColorSwaps(out[theme]['--accent'], theme));
    }

    const secondary = prefs.secondary;
    if (secondary) {
      Object.assign(out[theme], _resolveRoleTokens('secondary', secondary, theme));
    } else if (primary) {
      // Untouched, the secondary follows the primary eight points calmer.
      Object.assign(out[theme], _resolveRoleTokens(
        'secondary', { h: primary.h, s: Math.max(0, primary.s - 8) }, theme));
    }

    // The panels are independent: nothing follows them and they follow nothing.
    if (prefs.surface) Object.assign(out[theme], _resolveRoleTokens('surface', prefs.surface, theme));

    // Last, once every colour it is judged against has been resolved.
    Object.assign(out[theme], _getPendingColorSwaps(out[theme], theme));
    Object.assign(out[theme], _getSpoiledColorSwaps(out[theme], theme));
  });

  return out;
}

// Paint whichever half of `vars` matches the palette showing. Also called by
// theme.js on a theme switch, since that changes which half applies.
function applyAccentVars() {
  const theme = _getCurrentThemeName();
  const vars = (accentPrefs.vars && accentPrefs.vars[theme]) || {};
  ACCENT_MANAGED.forEach(prop => {
    if (vars[prop]) document.documentElement.style.setProperty(prop, vars[prop]);
    else document.documentElement.style.removeProperty(prop);
  });
}

// ─── PERSISTENCE ───
function _loadAccentPrefs() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(ACCENT_KEY)); } catch (e) { raw = null; }
  accentPrefs = _sanitizeAccentPrefs(raw);
}

function _sanitizeAccentPrefs(raw) {
  const out = _getDefaultAccentPrefs();
  if (!raw || typeof raw !== 'object') return out;
  Object.keys(ACCENT_ROLES).forEach(role => {
    const v = raw[role];
    if (!v || typeof v !== 'object') return;
    const h = parseFloat(v.h), s = parseFloat(v.s);
    if (!Number.isFinite(h) || !Number.isFinite(s)) return;
    out[role] = { h: ((h % 360) + 360) % 360, s: Math.max(0, Math.min(100, s)) };
  });
  // Recomputed, not trusted: a stored map disagreeing with the fields above
  // would paint a colour the wheel does not show.
  out.vars = _computeAccentVars(out);
  return out;
}

function _saveAccentPrefs() {
  try { localStorage.setItem(ACCENT_KEY, JSON.stringify(accentPrefs)); } catch (e) { /* non-fatal */ }
}

// ─── SETTING A COLOUR ───
// `commit` is false mid-drag: the app recolours live, but only the release is stored.
function _setAccentColor(role, h, s, { commit = true } = {}) {
  if (!ACCENT_ROLES[role]) return;
  accentPrefs[role] = { h: ((h % 360) + 360) % 360, s: Math.max(0, Math.min(100, s)) };
  accentPrefs.vars = _computeAccentVars(accentPrefs);
  applyAccentVars();
  updateAppearanceUI();
  if (commit) _saveAccentPrefs();
}

function _clearAccentColor(role) {
  if (!ACCENT_ROLES[role]) return;
  accentPrefs[role] = null;
  accentPrefs.vars = _computeAccentVars(accentPrefs);
  applyAccentVars();
  updateAppearanceUI();
  _saveAccentPrefs();
}

// What the swatch shows: the custom colour if any, else what tokens.css paints.
function _getCurrentAccentHex(role) {
  const theme = _getCurrentThemeName();
  const token = _getRoleReferenceToken(role).name;
  const custom = accentPrefs.vars?.[theme]?.[token];
  if (custom) return custom;
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim() || '#000000';
}

// ─── THE WHEEL ───
// A hue ring fading to a grey centre, from two gradients so it stays crisp at any
// size. Literal colours belong here: a spectrum is not themed. Drawn at the
// lightness the role will get, so it previews the result.
function _getWheelFaceLightness(role) {
  const l = _getRoleReferenceToken(role)[_getCurrentThemeName()].l;
  return Math.max(WHEEL_FACE_MIN, Math.min(WHEEL_FACE_MAX, l));
}

function _paintWheelFace(role) {
  const l = _getWheelFaceLightness(role);
  const stops = [];
  for (let h = 0; h <= 360; h += 30) stops.push(`hsl(${h} 100% ${l}%)`);
  const wheel = document.getElementById('color-wheel');
  wheel.style.background =
    `radial-gradient(circle closest-side, hsl(0 0% ${l}%), hsl(0 0% ${l}% / 0) 70%), ` +
    `conic-gradient(from 0deg, ${stops.join(', ')})`;
}

// Screen point → hue (clockwise from the top, where the conic-gradient starts)
// and saturation (distance out, clamped at the rim so a drag off the wheel keeps
// tracking the hue).
function _getWheelValueAt(clientX, clientY) {
  const wheel = document.getElementById('color-wheel');
  const r = wheel.getBoundingClientRect();
  const dx = clientX - (r.left + r.width / 2);
  const dy = clientY - (r.top + r.height / 2);
  const radius = r.width / 2;
  return {
    h: ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360,
    s: Math.max(0, Math.min(100, (Math.hypot(dx, dy) / radius) * 100)),
  };
}

function _placeWheelKnob(role) {
  const knob = document.getElementById('color-wheel-knob');
  const pick = accentPrefs[role];
  if (!pick) { knob.classList.add('hidden'); return; }
  knob.classList.remove('hidden');
  // Back out from hue/saturation to the point that produced them.
  const rad = ((pick.h - 90) * Math.PI) / 180;
  const dist = pick.s / 2; // percent of the wheel's width, from the centre
  knob.style.left = `${50 + Math.cos(rad) * dist}%`;
  knob.style.top  = `${50 + Math.sin(rad) * dist}%`;
  knob.style.background = _getCurrentAccentHex(role);
}

function _openColorWheel(role) {
  wheelRole = role;
  const pop = document.getElementById('color-wheel-pop');
  document.querySelectorAll('.color-row').forEach(row => {
    row.classList.toggle('open', row.dataset.role === role);
  });
  document.getElementById('wheel-title').textContent = ACCENT_ROLES[role].label;
  // Moved under its row, so the panel reads as that row opening.
  document.querySelector(`.color-row[data-role="${role}"]`).after(pop);
  pop.classList.remove('hidden');
  _paintWheelFace(role);
  _placeWheelKnob(role);
  updateAppearanceUI();
}

function _closeColorWheel() {
  wheelRole = null;
  document.getElementById('color-wheel-pop').classList.add('hidden');
  document.querySelectorAll('.color-row').forEach(row => row.classList.remove('open'));
}

// Inside the Appearance modal, so it folds before the modal closes.
registerEscapeLayer(ESCAPE_TIER.POPUP, () => wheelRole !== null, _closeColorWheel);

function _onWheelPointerDown(e) {
  if (!wheelRole || e.button !== 0) return;
  e.preventDefault();
  isWheelDragging = true;
  const wheel = document.getElementById('color-wheel');
  wheel.setPointerCapture(e.pointerId);
  _applyWheelPoint(e.clientX, e.clientY, false);
}

function _onWheelPointerMove(e) {
  if (!isWheelDragging) return;
  _applyWheelPoint(e.clientX, e.clientY, false);
}

function _onWheelPointerUp(e) {
  if (!isWheelDragging) return;
  isWheelDragging = false;
  _applyWheelPoint(e.clientX, e.clientY, true); // the release is what is stored
}

function _applyWheelPoint(x, y, commit) {
  const { h, s } = _getWheelValueAt(x, y);
  _setAccentColor(wheelRole, h, s, { commit });
  _placeWheelKnob(wheelRole);
}

// ─── THE APPEARANCE PAGE ───
// Bring every role's swatch, value text and reset button (and the open wheel's
// hex readout) up to date with the current prefs and theme.
function updateAppearanceUI() {
  Object.keys(ACCENT_ROLES).forEach(role => {
    const swatch = document.getElementById(`color-swatch-${role}`);
    const value  = document.getElementById(`color-value-${role}`);
    const clear  = document.querySelector(`.color-clear[data-role="${role}"]`);
    if (!swatch) return;

    const hex = _getCurrentAccentHex(role);
    swatch.style.background = hex;
    swatch.setAttribute('aria-label', `${ACCENT_ROLES[role].label} colour, ${hex}`);
    if (value) {
      const isCustom = !!accentPrefs[role];
      value.textContent = isCustom ? hex : `${hex} · default`;
      value.classList.toggle('is-default', !isCustom);
    }
    if (clear) clear.disabled = !accentPrefs[role]; // nothing to reset when it is the default
  });

  if (wheelRole) {
    const hexEl = document.getElementById('wheel-hex');
    if (hexEl) hexEl.textContent = _getCurrentAccentHex(wheelRole);
  }
}

// Opened fresh each time: put the wheel away and bring the swatches up to date.
function _openAppearanceModal() {
  _closeColorWheel();
  updateThemePickerUI(getThemePreference());
  updateAppearanceUI();
  hideModal('settings-modal');
  showModal('appearance-modal');
}

// Load and paint the stored accent and wire the Appearance page. Called from
// `initTheme()` rather than at load time, because theme.js is parsed first.
function initAppearance() {
  _loadAccentPrefs();
  applyAccentVars();

  document.getElementById('appearance-btn').addEventListener('click', _openAppearanceModal);

  document.querySelectorAll('.color-swatch').forEach(btn => {
    btn.addEventListener('click', () => {
      const role = btn.dataset.role;
      if (wheelRole === role) _closeColorWheel();
      else _openColorWheel(role);
    });
  });

  document.querySelectorAll('.color-clear').forEach(btn => {
    btn.addEventListener('click', () => {
      _clearAccentColor(btn.dataset.role);
      if (wheelRole === btn.dataset.role) _placeWheelKnob(btn.dataset.role);
    });
  });

  const wheel = document.getElementById('color-wheel');
  wheel.addEventListener('pointerdown', _onWheelPointerDown);
  wheel.addEventListener('pointermove', _onWheelPointerMove);
  wheel.addEventListener('pointerup', _onWheelPointerUp);
  wheel.addEventListener('pointercancel', _onWheelPointerUp);

  document.getElementById('wheel-close').addEventListener('click', _closeColorWheel);
  document.getElementById('wheel-default-btn').addEventListener('click', () => {
    if (wheelRole) _clearAccentColor(wheelRole);
    if (wheelRole) _placeWheelKnob(wheelRole);
  });

  updateAppearanceUI();
}
