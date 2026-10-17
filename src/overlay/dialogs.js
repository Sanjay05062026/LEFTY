// Dialog coach: recognises the standard Windows Save and Open dialogs and decides the next step inside
// them from what is on screen (pick a folder, name the file, Save), so Lefty keeps guiding until the
// dialog is really finished. Almost every app shares these dialogs.
// Pure functions: loaded by the overlay page and by Node tests.

(function (root) {
  const nameOf = (el) => String((el && el.name) || '').trim();
  const isFileNameBox = (el) => (el.type === 'Edit' || el.type === 'ComboBox') && /^file name/i.test(nameOf(el));

  function fileNameBox(elements) {
    return elements.find((el) => el.type === 'Edit' && isFileNameBox(el))
      || elements.find((el) => isFileNameBox(el))
      || null;
  }

  function button(elements, pattern) {
    return elements.find((el) => el.type === 'Button' && el.enabled !== false && pattern.test(nameOf(el))) || null;
  }

  // The folder list on the left of the dialog: its folder pane, or else the area covered by its visible folders.
  function folderArea(elements) {
    const folders = elements.filter((el) => el.type === 'TreeItem' && el.rect);
    if (!folders.length) return null;
    const pane = elements.find((el) => el.type === 'Tree' && el.rect && /navigation|folder/i.test(nameOf(el)));
    if (pane) return { name: 'Folders', type: 'Area', rect: pane.rect };
    const left = Math.min(...folders.map((el) => el.rect.x));
    const top = Math.min(...folders.map((el) => el.rect.y));
    const right = Math.max(...folders.map((el) => el.rect.x + el.rect.w));
    const bottom = Math.max(...folders.map((el) => el.rect.y + el.rect.h));
    return { name: 'Folders', type: 'Area', rect: { x: left, y: top, w: right - left, h: bottom - top } };
  }

  // 'save', 'open' or null.
  function dialogKind(elements) {
    if (!Array.isArray(elements) || !fileNameBox(elements)) return null;
    if (button(elements, /^save$/i)) return 'save';
    if (button(elements, /^open$/i)) return 'open';
    return null;
  }

  // The next step inside the dialog. `state` remembers what the user already did in it.
  function coach(elements, state) {
    const kind = dialogKind(elements);
    if (!kind) return null;
    state.kind = kind;
    const area = folderArea(elements);
    if (!state.folderPicked && area) {
      return { id: 'dialog:folder', kind: 'choose', label: 'Pick any folder 📁', target: area };
    }
    const box = fileNameBox(elements);
    if (!state.nameTouched && box) {
      return { id: 'dialog:name', kind: 'type', label: kind === 'save' ? 'Name it anything ✏️' : 'Pick or type the file ✏️', target: box };
    }
    const confirm = button(elements, kind === 'save' ? /^save$/i : /^open$/i);
    if (confirm) return { id: 'dialog:confirm', kind: 'click', label: kind === 'save' ? 'Save 💾' : 'Open 📂', target: confirm };
    return { wait: true };
  }

  // Updates `state` from what the user did: clicks (with the element under the click) and typing.
  function noteEvent(state, event) {
    if (event.type === 'typing') { // typing a name means the folder is fine as it is
      state.folderPicked = true;
      state.nameTouched = true;
      return;
    }
    if (event.type !== 'click') return;
    const el = event.element;
    if (event.hit && event.decisionId === 'dialog:folder') state.folderPicked = true;
    if (event.hit && event.decisionId === 'dialog:name') { state.folderPicked = true; state.nameTouched = true; }
    if (!el) return;
    if (el.type === 'TreeItem' || el.type === 'ListItem') {
      state.folderPicked = true;
      if (state.kind === 'open' && el.type === 'ListItem') state.nameTouched = true; // picking a file fills in its name
    }
    if (isFileNameBox(el)) { state.folderPicked = true; state.nameTouched = true; }
    if (el.type === 'Button' && /^cancel$/i.test(nameOf(el))) state.cancelled = true;
  }

  // Clicking these usually opens a file dialog, so Lefty waits a moment for one before saying "Done".
  function mayOpenDialog(name) {
    const text = String(name || '').trim();
    return /(\.\.\.|…)$/.test(text) || /\b(save as|save|open|export|import|browse|upload|attach)\b/i.test(text);
  }

  const api = { dialogKind, coach, noteEvent, mayOpenDialog, fileNameBox, folderArea };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LeftyDialogs = api;
})(this);
