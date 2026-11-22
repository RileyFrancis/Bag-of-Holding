// =============================================================================
// SHEET PROSE — the written sections, and the editor/preview swap
// =============================================================================
'use strict';

// Backstory & Personality and Appearance: two Markdown fields with an
// editor/preview swap. Neither owns data: they are `data-sheet` fields on
// `state.character` (the `data-prose` key IS the `data-sheet` path). The mode is
// session-only, a guess overridden by the toggle: a section with writing opens
// formatted, an empty one opens in the editor. See markdown.js for the sanitizer.

const proseModes = {};         // sectionKey -> 'edit' | 'preview', once chosen
let proseCharacterId = null;   // whose sheet the modes above belong to

// A section's mode: the reader's choice if made, else the guess (writing →
// preview, empty → edit).
function _getProseMode(key) {
  if (proseModes[key]) return proseModes[key];
  return String(readSheetPath(key) ?? '').trim() ? 'preview' : 'edit';
}

// Redraws each written section's mode and preview. Called from
// `renderCharacterSheet()`, so it follows keystrokes, roster syncs and character switches.
function renderSheetProse() {
  // A different character is different writing — carrying the modes over would
  // open someone else's blank sheet in preview.
  const id = state.character?.id ?? null;
  if (id !== proseCharacterId) {
    proseCharacterId = id;
    Object.keys(proseModes).forEach(k => delete proseModes[k]);
  }

  document.querySelectorAll('#character-sheet [data-prose]').forEach(section => {
    const key = section.dataset.prose;
    const isPreviewing = _getProseMode(key) === 'preview';
    section.classList.toggle('previewing', isPreviewing);

    const btn = section.querySelector('.prose-toggle');
    if (btn) {
      // The button says what you will get, not what you are looking at.
      btn.textContent = isPreviewing ? 'Edit' : 'Preview';
      btn.title = isPreviewing
        ? 'Go back to the text and edit it'
        : 'See this formatted, with the Markdown and HTML applied';
    }

    // Only rendered when on screen — every keystroke re-renders the sheet.
    if (!isPreviewing) return;

    const preview = section.querySelector('.prose-preview');
    const text = String(readSheetPath(key) ?? '');
    if (text.trim()) {
      renderMarkdownInto(preview, text);
    } else {
      preview.textContent = '';
      preview.appendChild(_createProseEmptyNote(section));
    }
  });
}

function _createProseEmptyNote(section) {
  const p = document.createElement('p');
  p.className = 'prose-empty';
  p.textContent = section.dataset.proseEmpty || 'Nothing written yet.';
  return p;
}

// One listener for every written section. Read-only does not gate it — someone
// reading another player's sheet can still swap to the editor to see how a
// passage was written (the textarea is disabled by `renderCharacterSheet()`).
document.getElementById('character-sheet').addEventListener('click', e => {
  const btn = e.target.closest('.prose-toggle');
  if (!btn) return;

  const section = btn.closest('[data-prose]');
  const key = section.dataset.prose;
  proseModes[key] = _getProseMode(key) === 'preview' ? 'edit' : 'preview';
  renderSheetProse();

  // Switching *to* the editor is a move made in order to type.
  if (proseModes[key] === 'edit') {
    const input = section.querySelector('.prose-input');
    if (input && !input.disabled) input.focus();
  }
});
