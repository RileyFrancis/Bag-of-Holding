// =============================================================================
// TOOLTIP — Hover tooltip for items
// =============================================================================
'use strict';

let tooltipTimer = null;

function startTooltipTimer(instanceId, x, y) {
  startTooltipTimerWith(() => showItemTooltip(instanceId, x, y));
}

// The same hover delay for anything else that shows a card here — a status on
// the sheet (statuses.js).
function startTooltipTimerWith(show) {
  clearTooltip();
  tooltipTimer = setTimeout(show, 1200);
}

function clearTooltip() {
  clearTimeout(tooltipTimer);
  tooltipTimer = null;
  const el = document.getElementById('item-tooltip');
  el.classList.add('hidden');
  el.innerHTML = '';
}

function showItemTooltip(instanceId, x, y) {
  const inst = state.instances[instanceId];
  if (!inst) return;
  const t = state.db[inst.templateId];
  if (!t) return;
  const weight = isStackable(t)
    ? `${formatWeight(unitWeight(t) * (inst.stackCount ?? 1))} lb (×${inst.stackCount ?? 1})`
    : `${shapeWeight(getRotatedShape(t.shape, inst.rotation))} lb`;
  renderTooltip(t, weight, x, y);
}

function showTemplateTooltip(templateId, x, y) {
  const t = state.db[templateId];
  if (!t) return;
  const weight = isStackable(t) ? `${formatWeight(unitWeight(t))} lb each` : `${shapeWeight(t.shape)} lb`;
  renderTooltip(t, weight, x, y);
}

function renderTooltip(t, weight, x, y) {
  const el    = document.getElementById('item-tooltip');
  const color = rarityColor(t.rarity);

  const dmgHtml    = t.damage
    ? `<div class="tip-row"><span>Damage</span><span>${escapeHTML(t.damage)}${t.damageType ? ' ' + escapeHTML(t.damageType) : ''}</span></div>`
    : '';
  const costHtml   = hasCost(t.cost)
    ? `<div class="tip-row"><span>Cost</span><span>${escapeHTML(formatCost(t.cost))}</span></div>`
    : '';
  const attuneHtml = t.attunement
    ? `<div class="tip-attune">Requires Attunement${t.attunementNote ? ' ' + escapeHTML(t.attunementNote) : ''}</div>`
    : '';
  // Left empty here — a custom item's description is Markdown and syncs to
  // Firebase, so it is filled below through renderMarkdownInto, the only
  // place that may turn a string into markup (see markdown.js).
  const descHtml   = t.description ? `<div class="tip-desc"></div>` : '';
  const tagsHtml   = t.tags?.length
    ? `<div class="tip-tags">${t.tags.map(tag => `<span class="tag-pill">${escapeHTML(tag)}</span>`).join('')}</div>`
    : '';

  el.innerHTML = `
    <div class="tip-header">
      <span class="tip-name">${escapeHTML(t.name)}</span>
      <span class="tip-rarity" style="color:${color}">${escapeHTML(RARITY_META[t.rarity]?.label ?? '')}</span>
    </div>
    ${attuneHtml}
    <div class="tip-row"><span>Weight</span><span>${escapeHTML(weight)}</span></div>
    ${costHtml}
    ${dmgHtml}
    ${descHtml}
    ${tagsHtml}
  `;

  if (t.description) renderMarkdownInto(el.querySelector('.tip-desc'), t.description);

  showTooltipAt(el, x, y);
}

// Narrowest the card gets, and widest it may grow to keep a long description
// from running down the screen.
const TOOLTIP_MIN_W = 240;
const TOOLTIP_MAX_W = 560;

// Beside the cursor, flipped or pulled back in wherever it would leave the window.
function showTooltipAt(el, x, y) {
  el.classList.remove('hidden');

  const pad = 12;
  const tipW = squareUpTooltip(el, Math.min(TOOLTIP_MAX_W, window.innerWidth - pad * 2));
  let left = x + pad, top = y + pad;
  if (left + tipW > window.innerWidth - pad) left = x - tipW - pad;
  el.style.left = left + 'px';
  el.style.top  = top + 'px';
  if (top + el.offsetHeight > window.innerHeight - pad) {
    el.style.top = (window.innerHeight - el.offsetHeight - pad) + 'px';
  }
}

// Widens a card taller than it is wide toward a square. Wrapped text keeps
// roughly the same area at any width, so the side of that square is
// √(width × height) — measured twice, since the fixed rows (name, weight, cost)
// don't shrink as the text does. Returns the width it settled on.
function squareUpTooltip(el, maxW) {
  let w = TOOLTIP_MIN_W;
  el.style.width = w + 'px';
  for (let i = 0; i < 2; i++) {
    const h = el.offsetHeight;
    if (h <= w) break;
    const next = Math.round(Math.min(maxW, Math.max(TOOLTIP_MIN_W, Math.sqrt(w * h))));
    if (next <= w) break;
    w = next;
    el.style.width = w + 'px';
  }
  return w;
}
