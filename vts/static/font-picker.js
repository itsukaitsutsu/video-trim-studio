/* Searchable, dependency-free enhancement of the existing font select.
 * The native select remains the source of truth for styling/import/export.
 * Search never applies a font until the user explicitly chooses a result.
 */
(() => {
  const select = document.getElementById("capFontFamily");
  if (!select) return;
  const wrapper = document.createElement("div");
  wrapper.className = "font-picker";
  const input = document.createElement("input");
  input.id = "capFontSearch";
  input.type = "text";
  input.placeholder = "Search fonts…";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-label", "Font family — search fonts");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-haspopup", "listbox");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", "capFontResults");
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "font-picker-toggle";
  toggle.textContent = "▾";
  toggle.tabIndex = -1;
  toggle.setAttribute("aria-label", "Show font list");

  // A body-level popup stays usable inside resized/scrollable workspace panels.
  const popup = document.createElement("div");
  popup.className = "font-picker-popup";
  popup.hidden = true;
  const status = document.createElement("div");
  status.className = "font-picker-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const list = document.createElement("div");
  list.id = "capFontResults";
  list.className = "font-picker-results";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Font families");
  popup.append(status, list);
  document.body.append(popup);
  select.before(wrapper);
  wrapper.append(input, toggle, select);
  select.hidden = true;
  select.tabIndex = -1;

  let opened = false;
  let pointerInPopup = false;
  let query = "";
  let matches = [];
  let active = -1;
  let lastValue = null;
  const fold = text => String(text).normalize("NFKC").toLocaleLowerCase();

  function position() {
    if (!opened) return;
    const rect = input.getBoundingClientRect();
    const viewportW = document.documentElement.clientWidth;
    const viewportH = window.innerHeight;
    if (!input.getClientRects().length || rect.bottom <= 0 || rect.top >= viewportH) {
      close(); return;
    }
    const width = Math.min(Math.max(rect.width, 270), viewportW - 16);
    const below = viewportH - rect.bottom - 12;
    const above = rect.top - 12;
    const upward = below < 180 && above > below;
    const height = Math.max(40, Math.min(300, upward ? above : below));
    Object.assign(popup.style, {
      width: `${width}px`, maxHeight: `${height}px`,
      left: `${Math.max(8, Math.min(rect.left, viewportW - width - 8))}px`,
      top: upward ? "auto" : `${rect.bottom + 4}px`,
      bottom: upward ? `${viewportH - rect.top + 4}px` : "auto",
    });
  }

  function highlight(index, scroll = true) {
    active = matches.length ? Math.max(0, Math.min(matches.length - 1, index)) : -1;
    [...list.children].forEach((node, i) => node.classList.toggle("active", i === active));
    if (active < 0) { input.removeAttribute("aria-activedescendant"); return; }
    const node = list.children[active];
    input.setAttribute("aria-activedescendant", node.id);
    if (scroll) {
      if (node.offsetTop < list.scrollTop) list.scrollTop = node.offsetTop;
      else if (node.offsetTop + node.offsetHeight > list.scrollTop + list.clientHeight)
        list.scrollTop = node.offsetTop + node.offsetHeight - list.clientHeight;
    }
  }

  function render(preserveActive = false) {
    const previous = preserveActive ? matches[active]?.value : null;
    const terms = fold(query).trim().split(/\s+/).filter(Boolean);
    matches = [...select.options].filter(option => !option.disabled &&
      terms.every(term => fold(option.label).includes(term)));
    list.replaceChildren();
    matches.forEach((option, i) => {
      const row = document.createElement("div");
      row.id = `capFontResult-${i}`;
      row.className = "font-picker-option";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(option.value === select.value));
      row.dataset.value = option.value;
      row.textContent = option.label;
      row.addEventListener("pointerdown", e => e.preventDefault()); // retain input focus
      row.addEventListener("click", () => choose(i));
      row.addEventListener("pointermove", () => highlight(i, false));
      list.append(row);
    });
    status.textContent = matches.length
      ? `${matches.length} font${matches.length === 1 ? "" : "s"} · ↑↓ to browse · Enter to choose`
      : "No matching fonts. Try another name.";
    list.scrollTop = 0;
    let index = previous ? matches.findIndex(o => o.value === previous) : -1;
    if (index < 0 && !query) index = matches.findIndex(o => o.value === select.value);
    position();
    highlight(index < 0 ? 0 : index);
  }

  function open() {
    if (select.disabled || opened) return;
    opened = true;
    query = "";
    popup.hidden = false;
    input.setAttribute("aria-expanded", "true");
    render();
    input.select();
  }

  function close() {
    opened = false;
    popup.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    query = "";
    input.value = select.selectedOptions[0]?.label || select.value;
  }

  function choose(index) {
    const option = matches[index];
    if (!option) return;
    const changed = select.value !== option.value;
    select.value = option.value;
    close();
    if (changed) {
      // Preserve the existing style/history and device-font import listeners.
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    sync();
  }

  function sync(refresh = false) {
    input.disabled = select.disabled;
    toggle.disabled = select.disabled;
    if (select.disabled && opened) close();
    const changed = lastValue !== select.value;
    lastValue = select.value;
    if (!opened) input.value = select.selectedOptions[0]?.label || select.value;
    else if (refresh || changed) render(true); // never overwrite an in-progress search
  }

  input.addEventListener("focus", open);
  input.addEventListener("click", open);
  input.addEventListener("input", () => {
    if (!opened) { opened = true; popup.hidden = false; input.setAttribute("aria-expanded", "true"); }
    query = input.value;
    render();
  });
  input.addEventListener("keydown", e => {
    if (e.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); e.stopPropagation();
      if (!opened) open();
      else highlight(active + (e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Enter" && opened) {
      e.preventDefault(); e.stopPropagation(); choose(active);
    } else if (e.key === "Escape" && opened) {
      e.preventDefault(); e.stopPropagation(); close();
    } else if (e.key === "Tab") close();
  });
  // Dragging the list scrollbar must not dismiss the popup on focus loss.
  popup.addEventListener("pointerdown", () => { pointerInPopup = true; });
  const finishPopupPointer = () => {
    if (!pointerInPopup) return;
    pointerInPopup = false;
    if (opened) input.focus({ preventScroll: true });
  };
  document.addEventListener("pointerup", finishPopupPointer);
  document.addEventListener("pointercancel", finishPopupPointer);
  input.addEventListener("blur", () => { if (!pointerInPopup) close(); });
  toggle.addEventListener("pointerdown", e => e.preventDefault());
  toggle.addEventListener("click", () => {
    if (opened) close();
    else { input.focus(); open(); }
  });
  document.addEventListener("pointerdown", e => {
    if (opened && !wrapper.contains(e.target) && !popup.contains(e.target)) close();
  });
  document.addEventListener("scroll", e => {
    if (opened && !popup.contains(e.target)) position();
  }, true);
  window.addEventListener("resize", position);
  select.addEventListener("change", () => sync());
  new MutationObserver(() => sync(true)).observe(select, {
    childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ["disabled", "label", "value"],
  });
  window.capFontPicker = { sync };
  sync();
})();
