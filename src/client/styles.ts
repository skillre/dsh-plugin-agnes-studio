import { createElement, type ReactElement } from 'react'

/**
 * Panel styles for Agnes Studio.
 *
 * One stylesheet string, rendered by the page itself as a `<style>` element, so
 * unmounting the panel removes the rules with no global residue — the Client
 * contract keeps component-local styles inside the component.
 *
 * Every color is either `currentColor`, a `color-mix()` against it, or a
 * translucent overlay, so the panel inherits the host theme in both light and
 * dark mode without naming a token that may not exist in this DSH version.
 * The only fixed colors are the two capability accents, which are artwork.
 */

/** Accent hues for the two capabilities; the rest of the palette is inherited. */
export const ACCENT_IMAGE = '#4f46e5'
export const ACCENT_VIDEO = '#0ea5e9'

export const STUDIO_CSS = `
.agnes {
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: 100%;
  min-height: 0;
  padding: 20px 24px 28px;
  color: inherit;
  font-size: 13px;
  line-height: 1.55;
  overflow: auto;
}

.agnes__head { display: flex; flex-direction: column; gap: 4px; }
.agnes__title { margin: 0; font-size: 18px; font-weight: 650; letter-spacing: -0.01em; }
.agnes__subtitle { margin: 0; opacity: 0.62; font-size: 12px; }

.agnes__tabs { display: inline-flex; gap: 4px; padding: 3px; border-radius: 10px; background: color-mix(in srgb, currentColor 7%, transparent); align-self: flex-start; }
.agnes__tab {
  appearance: none; border: 0; cursor: pointer; border-radius: 8px;
  padding: 6px 14px; font: inherit; font-size: 12px; font-weight: 550;
  color: inherit; background: transparent; opacity: 0.7;
  transition: background 120ms ease, opacity 120ms ease;
}
.agnes__tab:hover { opacity: 1; background: color-mix(in srgb, currentColor 8%, transparent); }
.agnes__tab--on { opacity: 1; background: color-mix(in srgb, currentColor 14%, transparent); }
.agnes__tab:focus-visible { outline: 2px solid ${ACCENT_IMAGE}; outline-offset: 2px; }

.agnes__notice {
  display: flex; flex-direction: column; gap: 6px;
  padding: 12px 14px; border-radius: 10px;
  border: 1px solid color-mix(in srgb, #f59e0b 45%, transparent);
  background: color-mix(in srgb, #f59e0b 12%, transparent);
}
.agnes__noticeTitle { font-weight: 600; }
.agnes__noticeBody { opacity: 0.8; font-size: 12px; }
.agnes__meta { display: flex; flex-wrap: wrap; gap: 12px; font-size: 11px; opacity: 0.6; }

.agnes__form { display: flex; flex-direction: column; gap: 12px; }
.agnes__label { display: flex; flex-direction: column; gap: 5px; font-size: 11px; font-weight: 600; opacity: 0.85; letter-spacing: 0.01em; }
.agnes__field {
  appearance: none; width: 100%; box-sizing: border-box;
  border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
  border-radius: 9px; padding: 8px 10px;
  background: color-mix(in srgb, currentColor 4%, transparent);
  color: inherit; font: inherit; font-size: 13px; font-weight: 400;
}
.agnes__field:focus-visible { outline: 2px solid ${ACCENT_IMAGE}; outline-offset: 1px; border-color: transparent; }
.agnes__field:disabled { opacity: 0.5; cursor: not-allowed; }
textarea.agnes__field { min-height: 84px; resize: vertical; line-height: 1.5; }
select.agnes__field { cursor: pointer; }

.agnes__row { display: grid; grid-template-columns: repeat(auto-fit, minmax(128px, 1fr)); gap: 10px; }
.agnes__hint { font-size: 11px; opacity: 0.58; font-weight: 400; }

.agnes__refs { display: flex; flex-direction: column; gap: 6px; }
.agnes__refRow { display: flex; gap: 6px; align-items: center; }
.agnes__refRow .agnes__field { flex: 1; }

.agnes__actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.agnes__button {
  appearance: none; cursor: pointer; border-radius: 9px;
  border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
  background: transparent; color: inherit; font: inherit; font-size: 12px; font-weight: 600;
  padding: 7px 14px; transition: background 120ms ease, opacity 120ms ease;
}
.agnes__button:hover:not(:disabled) { background: color-mix(in srgb, currentColor 9%, transparent); }
.agnes__button:disabled { opacity: 0.45; cursor: not-allowed; }
.agnes__button:focus-visible { outline: 2px solid ${ACCENT_IMAGE}; outline-offset: 2px; }
.agnes__button--primary {
  border-color: transparent; color: #fff;
  background: linear-gradient(135deg, ${ACCENT_IMAGE}, ${ACCENT_VIDEO});
}
.agnes__button--primary:hover:not(:disabled) { filter: brightness(1.08); background: linear-gradient(135deg, ${ACCENT_IMAGE}, ${ACCENT_VIDEO}); }
.agnes__button--danger { border-color: color-mix(in srgb, #ef4444 55%, transparent); color: #ef4444; }
.agnes__button--ghost { border-color: transparent; opacity: 0.75; font-weight: 500; }
.agnes__button--ghost:hover:not(:disabled) { opacity: 1; }

.agnes__busy {
  display: flex; align-items: center; gap: 9px;
  padding: 11px 14px; border-radius: 10px;
  background: color-mix(in srgb, ${ACCENT_IMAGE} 12%, transparent);
  border: 1px solid color-mix(in srgb, ${ACCENT_IMAGE} 35%, transparent);
  font-size: 12px;
}
.agnes__spinner {
  width: 13px; height: 13px; flex: none; border-radius: 50%;
  border: 2px solid color-mix(in srgb, currentColor 22%, transparent);
  border-top-color: ${ACCENT_IMAGE};
  animation: agnes-spin 700ms linear infinite;
}
@keyframes agnes-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .agnes__spinner { animation-duration: 2.4s; } }

.agnes__error {
  display: flex; flex-direction: column; gap: 7px;
  padding: 11px 14px; border-radius: 10px;
  border: 1px solid color-mix(in srgb, #ef4444 45%, transparent);
  background: color-mix(in srgb, #ef4444 10%, transparent);
  font-size: 12px;
}
.agnes__errorTitle { font-weight: 600; }
.agnes__errorBody { opacity: 0.85; white-space: pre-wrap; word-break: break-word; }

.agnes__galleryHead { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.agnes__galleryTitle { margin: 0; font-size: 13px; font-weight: 650; }
.agnes__count { font-size: 11px; opacity: 0.55; font-variant-numeric: tabular-nums; }
.agnes__spacer { flex: 1; }

.agnes__filters { display: inline-flex; gap: 3px; }
.agnes__chip {
  appearance: none; cursor: pointer; border: 0; border-radius: 999px;
  padding: 3px 10px; font: inherit; font-size: 11px; font-weight: 550;
  color: inherit; background: transparent; opacity: 0.62;
}
.agnes__chip:hover { opacity: 1; }
.agnes__chip--on { opacity: 1; background: color-mix(in srgb, currentColor 12%, transparent); }

.agnes__empty {
  padding: 26px 18px; border-radius: 12px; text-align: center;
  border: 1px dashed color-mix(in srgb, currentColor 22%, transparent);
  opacity: 0.66; font-size: 12px;
}

.agnes__grid {
  display: grid; gap: 12px;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  align-items: start;
}

.agnes__card {
  display: flex; flex-direction: column; gap: 8px;
  border-radius: 12px; overflow: hidden;
  border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
  background: color-mix(in srgb, currentColor 3%, transparent);
}
.agnes__card--failed { border-color: color-mix(in srgb, #ef4444 40%, transparent); }
.agnes__thumb {
  display: block; width: 100%; height: 168px; object-fit: cover;
  background: color-mix(in srgb, currentColor 7%, transparent);
}
.agnes__body { display: flex; flex-direction: column; gap: 6px; padding: 0 10px 10px; }
.agnes__prompt {
  margin: 0; font-size: 12px; line-height: 1.45;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
}
.agnes__facts { display: flex; flex-wrap: wrap; gap: 8px; font-size: 10.5px; opacity: 0.6; font-variant-numeric: tabular-nums; }
.agnes__cardActions { display: flex; flex-wrap: wrap; gap: 6px; }
.agnes__cardActions .agnes__button { padding: 4px 9px; font-size: 11px; font-weight: 550; }
.agnes__failText { margin: 0; font-size: 11.5px; color: #ef4444; word-break: break-word; }
.agnes__retryHint { font-size: 10.5px; opacity: 0.6; }

.agnes__srOnly {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
`

/** Render the panel stylesheet as a React element. */
export function StudioStyles(): ReactElement {
  // `createElement` rather than JSX so this module stays a plain `.ts` file: the
  // stylesheet is one static string, never user data, so React can own the text
  // child directly with no escaping concern.
  return createElement('style', null, STUDIO_CSS)
}
