"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

const DialogContext = createContext<{ close: () => void } | null>(null);

/** Lets anything rendered inside a <Dialog> close it (a form that succeeded, say) without prop-drilling through server components. No-op outside a dialog. */
export function useDialog() {
  return useContext(DialogContext);
}

/**
 * Native <dialog>-backed modal: focus trapping, Escape-to-close and the
 * backdrop come from the browser, so this stays small. The trigger is
 * whatever `trigger` renders (usually a .btn); `children` is the body, and
 * can be a server component passed down from a page.
 */
export function Dialog({
  trigger,
  title,
  eyebrow,
  children,
  maxWidth = 880,
}: {
  trigger: ReactNode;
  title: string;
  eyebrow?: string;
  children: ReactNode;
  maxWidth?: number;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);

  const close = useCallback(() => {
    ref.current?.close();
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <DialogContext.Provider value={{ close }}>
      <span onClick={() => setOpen(true)} style={{ display: "contents" }}>
        {trigger}
      </span>
      <dialog
        ref={ref}
        className="dialog"
        style={{ maxWidth }}
        onClose={() => setOpen(false)}
        onClick={(e) => {
          // Click on the backdrop (the dialog element itself, not its content) closes.
          if (e.target === ref.current) close();
        }}
      >
        <div className="dialog-in">
          <div className="dialog-head">
            <div className="stack g1">
              {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
              <h2 className="h2">{title}</h2>
            </div>
            <button type="button" className="dialog-x" onClick={close} aria-label="Close">
              ✕
            </button>
          </div>
          {open ? children : null}
        </div>
      </dialog>
    </DialogContext.Provider>
  );
}
