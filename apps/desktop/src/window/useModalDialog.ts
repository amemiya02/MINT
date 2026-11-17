import { type SyntheticEvent, useCallback, useEffect, useRef } from "react";

/**
 * A modal `<dialog>`, shown once mounted, that reports its closing at once.
 *
 * A dialog's own `close` event arrives in a task of its own. Until then the
 * window still counts the dialog as showing, so a shortcut pressed in between
 * (⌘⇧P right after running a command) would find nothing to open, and the late
 * event would then hide what it should have opened. `close()` therefore tells
 * `onClose` synchronously, and exactly once however the dialog closes.
 *
 * Spread `props` on the `<dialog>`; dismiss it with `close()`.
 */
export function useModalDialog(onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  const reported = useRef(false);
  const latest = useRef(onClose);
  latest.current = onClose;

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const close = useCallback(() => {
    ref.current?.close();
    if (reported.current) return;
    reported.current = true;
    latest.current();
  }, []);

  const onCancel = useCallback(
    (event: SyntheticEvent<HTMLDialogElement>) => {
      // Escape: close now rather than after the close event.
      event.preventDefault();
      close();
    },
    [close],
  );

  return { close, props: { ref, onClose: close, onCancel } };
}
