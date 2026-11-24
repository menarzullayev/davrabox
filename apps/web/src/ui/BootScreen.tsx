/**
 * Same markup as the boot screen in index.html (styles live there), so the screen does not blink empty while a lazy chunk
 * loads between the first HTML paint and the real UI.
 */
export function BootScreen() {
  return (
    <div className="boot" role="status" aria-label="DavraBox">
      <img src="/brand/favicon.svg" alt="" width={120} height={120} />
      <i aria-hidden="true" />
    </div>
  );
}
