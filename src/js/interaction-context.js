// =============================================================================
// INTERACTION-CONTEXT — The right-click context menu for items and templates
// =============================================================================
'use strict';

// Close the context menu on any click
document.addEventListener('click', () => _hideContextMenu());

const ctxMenu = document.getElementById('context-menu');
let ctxInstanceId = null; // instance the open menu acts on; null for a template

// Right-click on a placed item: open the instance context menu.
function onItemContextMenu(e) {
  e.preventDefault();
  e.stopPropagation();
  if (isReadOnly()) return;
  const instanceId = e.currentTarget.dataset.instanceId;
  _showInstanceContextMenu(instanceId, e.clientX, e.clientY);
}

function _showInstanceContextMenu(instanceId, x, y) {
  ctxInstanceId = instanceId;
  const isEquipped = !!getEquippedSlot(instanceId);
  document.getElementById('ctx-equip').style.display     = isEquipped ? 'none' : '';
  document.getElementById('ctx-unequip').style.display   = isEquipped ? '' : 'none';
  document.getElementById('ctx-duplicate').style.display = '';
  document.getElementById('ctx-stash').style.display     = '';
  document.getElementById('ctx-folder').style.display    = 'none'; // templates only
  ctxMenu.style.left = x + 'px';
  ctxMenu.style.top  = y + 'px';
  ctxMenu.classList.remove('hidden');
}

// Open the context menu for a Browse template at (x, y): edit, move to folder
// and delete act on the template rather than an instance.
function showTemplateContextMenu(templateId, x, y) {
  ctxInstanceId = null;
  ctxMenu.style.left = x + 'px';
  ctxMenu.style.top  = y + 'px';
  document.getElementById('ctx-rotate').style.display = 'none';
  ctxMenu.classList.remove('hidden');
  const folderBtn = document.getElementById('ctx-folder');
  folderBtn.style.display = '';
  folderBtn.onclick = () => { openMoveToFolderModal(templateId); _hideContextMenu(); };
  document.getElementById('ctx-edit').onclick = () => { openItemModal(templateId); _hideContextMenu(); };
  document.getElementById('ctx-remove').onclick = () => { deleteTemplate(templateId); _hideContextMenu(); };
}

function _hideContextMenu() {
  ctxMenu.classList.add('hidden');
  document.getElementById('ctx-rotate').style.display    = '';
  document.getElementById('ctx-equip').style.display     = '';
  document.getElementById('ctx-unequip').style.display   = 'none';
  document.getElementById('ctx-duplicate').style.display = 'none';
  document.getElementById('ctx-stash').style.display     = 'none';
  document.getElementById('ctx-folder').style.display    = 'none';
}

document.getElementById('ctx-rotate').addEventListener('click', () => {
  if (!ctxInstanceId) return;
  _rotateInstance(ctxInstanceId);
  _hideContextMenu();
});
document.getElementById('ctx-equip').addEventListener('click', () => {
  if (!ctxInstanceId) return;
  openEquipModal(ctxInstanceId);
  _hideContextMenu();
});
document.getElementById('ctx-unequip').addEventListener('click', () => {
  if (!ctxInstanceId) return;
  unequipInstance(ctxInstanceId);
  _hideContextMenu();
});
document.getElementById('ctx-edit').addEventListener('click', () => {
  if (!ctxInstanceId) return;
  const inst = state.instances[ctxInstanceId];
  if (inst) openItemModal(inst.templateId);
  _hideContextMenu();
});
document.getElementById('ctx-duplicate').addEventListener('click', () => {
  if (!ctxInstanceId) return;
  const inst = state.instances[ctxInstanceId];
  if (inst) startPlacing(inst.templateId);
  _hideContextMenu();
});
document.getElementById('ctx-stash').addEventListener('click', () => {
  if (!ctxInstanceId) return;
  const inst = state.instances[ctxInstanceId];
  if (inst) {
    unequipInstance(ctxInstanceId);
    removeFromGrid(ctxInstanceId);
    inst.row = null;
    inst.col = null;
    renderAllItems();
    updateWeightDisplay();
    scheduleSaveAndSync();
  }
  _hideContextMenu();
});
document.getElementById('ctx-remove').addEventListener('click', () => {
  if (!ctxInstanceId) return;
  removeInstance(ctxInstanceId);
  _hideContextMenu();
});

function _rotateInstance(instanceId) {
  const inst = state.instances[instanceId];
  if (!inst) return;
  const template = state.db[inst.templateId];
  const newRotation = (inst.rotation + 1) % 4;
  const newShape = getRotatedShape(template.shape, newRotation);
  if (canPlace(newShape, inst.row, inst.col, instanceId)) {
    removeFromGrid(instanceId);
    inst.rotation = newRotation;
    placeOnGrid(instanceId, newShape, inst.row, inst.col);
    renderAllItems();
    scheduleSaveAndSync();
  }
}

// Delete a placed or stashed instance; a container takes its contents with it.
function removeInstance(instanceId) {
  const inst = state.instances[instanceId];
  const t = inst ? state.db[inst.templateId] : null;
  if (t?.container) {
    // Remove all items stored inside this container
    Object.keys(state.instances).forEach(id => {
      if (state.instances[id]?.containerId === instanceId) delete state.instances[id];
    });
    delete state.containerGrids[instanceId];
    if (state.activeContainer === instanceId) {
      state.activeContainer = null;
      buildGrid();
    }
  }
  removeFromGrid(instanceId);
  delete state.instances[instanceId];
  renderContainerTabs();
  renderAllItems();
  updateWeightDisplay();
  scheduleSaveAndSync();
}

// Delete a template from the item database after confirming; instances stay.
function deleteTemplate(templateId) {
  if (!confirm(`Delete "${state.db[templateId]?.name}" from the item database? Placed items will remain.`)) return;
  delete state.db[templateId];
  forgetItemFolder(templateId);
  renderItemList();
  document.getElementById('details-content').classList.add('hidden');
  document.getElementById('details-placeholder').classList.remove('hidden');
}
