// =============================================================================
// TOOLTIP — Hover tooltip for items
// =============================================================================
'use strict';

const TOOLTIP_MIN_W = 240; // px, narrowest the card gets
const TOOLTIP_MAX_W = 560; // px, widest it grows so a long description doesn't run down the screen

// Shared with render-sidebar.js, which sets its own shorter hover delay.
let tooltipTimer = null;

// Shows an inventory instance's card after the hover delay.
function startTooltipTimer(instanceId, x, y) {
  startTooltipTimerWith(() => _showItemTooltip(instanceId, x, y));
}

// The same hover delay for anything else that shows a card here, such as a
// status on the sheet (statuses.js).
function startTooltipTimerWith(show) {
  clearTooltip();
  tooltipTimer = setTimeout(show, 1200);
}

// Cancels a pending card and hides the visible one.
function clearTooltip() {
  clearTimeout(tooltipTimer);
  tooltipTimer = null;
  const el = document.getElementById('item-tooltip');
  el.classList.add('hidden');
  el.innerHTML = '';
}

registerEscapeLayer(ESCAPE_TIER.POPUP,
  () => !document.getElementById('item-tooltip').classList.contains('hidden'), clearTooltip);

function _showItemTooltip(instanceId, x, y) {
  const inst = state.instances[instanceId];
  if (!inst) return;
  const t = state.db[inst.templateId];
  if (!t) return;
  const weight = isStackable(t)
    ? `${formatWeight(getItemUnitWeight(t) * (inst.stackCount ?? 1))} lb (×${inst.stackCount ?? 1})`
    : `${getShapeWeight(getRotatedShape(t.shape, inst.rotation))} lb`;
  _renderTooltipCard(t, weight, x, y);
}

// Shows a template's card (Browse list) at once, with per-unit weight for stacks.
function showTemplateTooltip(templateId, x, y) {
  const t = state.db[templateId];
  if (!t) return;
  const weight = isStackable(t) ? `${formatWeight(getItemUnitWeight(t))} lb each` : `${getShapeWeight(t.shape)} lb`;
  _renderTooltipCard(t, weight, x, y);
}

function _renderTooltipCard(t, weight, x, y) {
  const el    = document.getElementById('item-tooltip');
  const color = getRarityColor(t.rarity);

  const dmgHtml    = t.damage
    ? `<div class="tip-row"><span>Damage</span><span>${escapeHTML(t.damage)}${t.damageType ? ' ' + escapeHTML(t.damageType) : ''}</span></div>`
    : '';
  const costHtml   = hasCost(t.cost)
    ? `<div class="tip-row"><span>Cost</span><span>${escapeHTML(formatCost(t.cost))}</span></div>`
    : '';
  const attuneHtml = t.attunement
    ? `<div class="tip-attune">Requires Attunement${t.attunementNote ? ' ' + escapeHTML(t.attunementNote) : ''}</div>`
    : '';
  // Left empty: a custom item's description is Markdown that syncs to Firebase,
  // so only renderMarkdownInto (markdown.js) may turn it into markup.
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

// Shows a card beside the cursor, flipped or pulled back in wherever it would
// leave the window.
function showTooltipAt(el, x, y) {
  el.classList.remove('hidden');

  const pad = 12;
  const tipW = _squareUpTooltip(el, Math.min(TOOLTIP_MAX_W, window.innerWidth - pad * 2));
  let left = x + pad, top = y + pad;
  if (left + tipW > window.innerWidth - pad) left = x - tipW - pad;
  el.style.left = left + 'px';
  el.style.top  = top + 'px';
  if (top + el.offsetHeight > window.innerHeight - pad) {
    el.style.top = (window.innerHeight - el.offsetHeight - pad) + 'px';
  }
}

// Widens a card taller than it is wide toward a square. Wrapped text keeps
// roughly the same area at any width, so the side is √(width × height),
// measured twice since the fixed rows don't shrink. Returns the settled width.
function _squareUpTooltip(el, maxW) {
  let width = TOOLTIP_MIN_W;
  el.style.width = width + 'px';
  for (let i = 0; i < 2; i++) {
    const height = el.offsetHeight;
    if (height <= width) break;
    const next = Math.round(Math.min(maxW, Math.max(TOOLTIP_MIN_W, Math.sqrt(width * height))));
    if (next <= width) break;
    width = next;
    el.style.width = width + 'px';
  }
  return width;
}
