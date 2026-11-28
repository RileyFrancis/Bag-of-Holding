// =============================================================================
// ESCAPE — One Escape closes the topmost open layer, one layer per press
// =============================================================================
'use strict';

// Every panel, menu, modal and gesture Escape can close registers itself here
// with a tier (ESCAPE_TIER). Escape never leaves the character for home: with
// nothing open it does nothing, so the sheet, inventory or spells stay put.

const escapeLayers = []; // { tier, isOpen, close }, highest tier first

// Registers something Escape can close: `isOpen()` says whether it is showing,
// `close()` closes it. Call at load time from the file that owns it.
function registerEscapeLayer(tier, isOpen, close) {
  escapeLayers.push({ tier, isOpen, close });
  escapeLayers.sort((a, b) => b.tier - a.tier); // stable, so registration order breaks ties
}

// Capture on window, and registered before any other file's listener, so this
// runs first and no other handler acts on an Escape it used. An Escape with
// nothing open passes through untouched (a search box still clears itself).
window.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || e.isComposing) return;
  const layer = escapeLayers.find(l => l.isOpen());
  if (!layer) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  // A held key would otherwise strip every layer in a blink.
  if (!e.repeat) layer.close();
}, { capture: true });
