import { useCallback, useEffect, useId, useRef, useState } from "react";
import "./RecordMenu.css";

/**
 * The actions for one record, behind a single button.
 *
 * Replaces a row of four buttons that took two lines on a phone and made the
 * top of the page read as a toolbar rather than as a customer. One control
 * where there were four, and the page below it is what you see first.
 *
 * Written by hand rather than pulled in: a menu is a listener on the document,
 * a keydown handler and some focus management, and a dependency for that is
 * more code than this, not less.
 *
 * What it has to get right, because a menu that gets these wrong is worse than
 * the buttons it replaced:
 *
 *   * Escape closes it and puts focus back on the button, so a keyboard user
 *     is never stranded inside it.
 *   * A tap anywhere else closes it. On a touch screen there is no "click
 *     off" instinct to fall back on, so this is the only way out besides the
 *     button itself.
 *   * Arrow keys walk the items. Without that, `role="menu"` is a lie told to
 *     a screen reader — it announces a menu and then behaves like a div.
 *   * Choosing an item closes it BEFORE the action runs. Several of these
 *     navigate away, and a menu left open over the next page is a ghost.
 */
export default function RecordMenu({ label = "Actions", items = [] }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const itemRefs = useRef([]);
  const menuId = useId();

  const close = useCallback(
    ({ refocus = false } = {}) => {
      setOpen(false);
      if (refocus) buttonRef.current?.focus();
    },
    []
  );

  // pointerdown, not click: a click fires after the mouse is released, so a
  // drag that starts inside the menu and ends outside would close it. It also
  // beats the browser's own focus handling, which matters on iOS.
  useEffect(() => {
    if (!open) return;

    function onPointerDown(e) {
      if (
        menuRef.current?.contains(e.target) ||
        buttonRef.current?.contains(e.target)
      ) {
        return;
      }
      close();
    }

    function onKeyDown(e) {
      if (e.key === "Escape") {
        e.stopPropagation();
        close({ refocus: true });
      }
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  // Focus lands on the first item when the menu opens. Without it a keyboard
  // user tabs from the button straight past the menu into the page behind.
  useEffect(() => {
    if (open) itemRefs.current[0]?.focus();
  }, [open]);

  function onItemKeyDown(e, index) {
    const last = items.length - 1;
    const go = (i) => {
      e.preventDefault();
      itemRefs.current[i]?.focus();
    };

    if (e.key === "ArrowDown") go(index === last ? 0 : index + 1);
    else if (e.key === "ArrowUp") go(index === 0 ? last : index - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(last);
    else if (e.key === "Tab") close();
  }

  function choose(item) {
    // Closed first, then the action. Several of these navigate, and a menu
    // still open over the next screen is a ghost nobody can explain.
    close();
    item.onSelect?.();
  }

  return (
    <div className="recmenu">
      <button
        ref={buttonRef}
        type="button"
        className={`recmenu__button ${open ? "recmenu__button--open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
        <span className="recmenu__caret" aria-hidden="true" />
      </button>

      {open && (
        <div className="recmenu__sheet" ref={menuRef} id={menuId} role="menu">
          {items.map((item, i) => (
            <button
              key={item.label}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              role="menuitem"
              className={`recmenu__item ${
                item.tone ? `recmenu__item--${item.tone}` : ""
              }`}
              onClick={() => choose(item)}
              onKeyDown={(e) => onItemKeyDown(e, i)}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
