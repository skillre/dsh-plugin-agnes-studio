---
'@skillre/dsh-plugin-agnes-studio': patch
---

Fix "打开原图" doing nothing, and replace it with an in-panel image viewer.

- **The defect**: the control was an `<a target="_blank">` to the stored media URL. The Desktop shell
  denies every popup the page requests and only forwards `https:` URLs to the OS browser, so clicking
  it had no effect at all; the URL is also session-authenticated, so an external tab would have
  answered 401. It rendered, focused, and did nothing.
- **The fix**: the panel owns the zoom. Clicking "打开原图" or the thumbnail opens a lightbox that
  covers the window, with a zoom readout, zoom in/out/reset controls, a download link and a close
  button. Click the picture to toggle between fit and 2x centred on the click point, scroll to zoom
  between 1x and 8x, drag to pan while zoomed, and press Escape, click the backdrop or use the close
  button to dismiss. The viewer is keyed by record id, so a Host state refresh does not close it.
- The overlay renders in the component tree with `position: fixed` rather than through a portal: the
  browser bundle's module envelope resolves only `react`, so importing `react-dom` would break
  loading.
- Wheel zoom binds natively with `passive: false`; React's synthetic wheel listener is passive at the
  root, where `preventDefault()` is ignored and the panel behind the overlay would scroll.
- Pointer input with unusable coordinates no longer starts a pan. jsdom has no `PointerEvent`, and an
  undefined origin previously wrote `translate(NaNpx, NaNpx)` and blanked the picture.
- Verification: 8 new offline viewer tests drive the actual interaction (the previous suite could not
  catch this class of defect, because DOM presence passes on a control that does nothing), and the
  headless-Chrome check now asserts that the overlay spans the viewport with no containing-block trap
  and that zoom changes the measured layout, not just the label.
