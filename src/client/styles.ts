import { createElement, type ReactElement } from 'react'

/**
 * Panel styles for Agnes Studio.
 *
 * One stylesheet string, rendered by the page itself as a `<style>` element, so
 * unmounting the panel removes the rules with no global residue — the Client
 * contract keeps component-local styles inside the component.
 *
 * ## Why host tokens instead of `currentColor` mixes
 *
 * The previous sheet derived every surface from `color-mix(in srgb, currentColor
 * N%, transparent)`. That follows the text colour, but it cannot express a
 * *raised* surface: in light mode every card, input and chip collapsed into the
 * same near-white wash, and in dark mode into the same near-black one. The panel
 * therefore read as one flat grey field with no hierarchy.
 *
 * The host publishes real design tokens (`@deepseek-ai/dsh-client-ui-theme`
 * injects `--dsw-*` custom properties on `body`, and flips them under
 * `body[data-ds-dark-theme]`). Reading them means the panel inherits the exact
 * surfaces, borders, radii and elevations the surrounding app uses, in both
 * themes, without this package shipping a second palette. Every read carries a
 * fallback so an older DSH line that lacks a token still renders.
 *
 * The only fixed colours are the two capability accents. They are artwork, not
 * chrome: the panel is Agnes, and a black-and-white button would lose that.
 */

/** Accent hues for the two capabilities; the rest of the palette is inherited. */
export const ACCENT_IMAGE = '#4f46e5'
export const ACCENT_VIDEO = '#0ea5e9'

export const STUDIO_CSS = `
/* ---------------------------------------------------------------------------
   Tokens
   ---------------------------------------------------------------------------
   Declared on the panel root so every rule below reads one name. "--a-*" values
   are host tokens with a local fallback; the fallbacks are the light-theme
   values the host itself uses, so a DSH line without the token degrades to a
   correct-looking panel rather than to no styling.
   ------------------------------------------------------------------------- */
.agnes {
  --a-surface: var(--dsw-alias-bg-layer-1, #fff);
  --a-surface-2: var(--dsw-alias-bg-layer-2, #f9fafb);
  --a-field: var(--dsw-specific-input-major, #fff);
  --a-border: var(--dsw-alias-border-l1, rgba(15, 17, 21, 0.06));
  --a-border-strong: var(--dsw-alias-border-l2, rgba(15, 17, 21, 0.12));
  --a-fg: var(--dsw-alias-label-primary, #0f1115);
  --a-fg-2: var(--dsw-alias-label-secondary, #61666b);
  --a-fg-3: var(--dsw-alias-label-tertiary, #81858c);
  --a-danger: var(--dsw-alias-state-error-primary, #ec1313);
  --a-warn: var(--dsw-alias-state-warn-primary, #f59e0b);
  --a-ok: var(--dsw-alias-state-success-primary, #22c55e);
  --a-radius-sm: var(--dsw-radius-sm, 8px);
  --a-radius: var(--dsw-radius-md, 12px);
  --a-radius-lg: var(--dsw-radius-lg, 16px);
  --a-shadow: var(--dsw-elevation-panel, 0 1px 2px rgba(0, 0, 0, 0.05));
  --a-shadow-lift: var(--dsw-elevation-prominent, 0 2px 6px rgba(0, 0, 0, 0.06), 0 8px 24px rgba(0, 0, 0, 0.06));

  --a-accent: ${ACCENT_IMAGE};
  --a-accent-2: ${ACCENT_VIDEO};
  --a-accent-soft: color-mix(in srgb, var(--a-accent) 12%, transparent);
  --a-accent-line: color-mix(in srgb, var(--a-accent) 42%, transparent);

  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  min-height: 0;
  box-sizing: border-box;
  /* Fill the centre column instead of shrink-wrapping to its content.
     The parent is a flex row, so without this the page sized itself to the
     composer + gallery minimum (953px inside a 1232px column) and "margin: 0
     auto" then centred that narrower box — leaving a measured 139.5px dead gap
     on the left while the right side had one too. "width: 100%" plus no auto
     margin pins the workspace to the left edge and hands the whole remaining
     width to the gallery. */
  width: 100%;
  max-width: none;
  margin: 0;
  padding: 16px 22px 14px;
  color: var(--a-fg);
  font-size: 13px;
  line-height: 1.55;
  /* The page itself does not scroll: the two panes do, independently. A single
     page scroll made the composer's submit button fall below the fold on the
     video tab, so the primary action of the panel needed a page scroll to
     reach — on a screen where nothing else was moving. */
  overflow: hidden;
}

/* The dark theme lightens the accent: the light-mode indigo is too dark to read
   as a 12px label on a near-black surface, and too dark to show as a 1px border. */
[data-ds-dark-theme] .agnes {
  --a-accent: #818cf8;
  --a-accent-2: #38bdf8;
}

/* ---------------------------------------------------------------------------
   Header
   ------------------------------------------------------------------------- */
.agnes__header { display: flex; align-items: flex-start; gap: 11px; flex: none; }

.agnes__brandMark {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  flex: none;
  border-radius: 11px;
  color: #fff;
  background: linear-gradient(135deg, var(--a-accent), var(--a-accent-2));
  box-shadow: 0 1px 2px rgba(30, 27, 75, 0.2), 0 6px 14px -6px rgba(79, 70, 229, 0.55);
}

.agnes__head { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.agnes__title {
  margin: 0;
  font-size: 15.5px;
  font-weight: 650;
  line-height: 1.35;
  letter-spacing: -0.01em;
  color: var(--a-fg);
}
.agnes__subtitle {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--a-fg-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agnes__status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  margin-left: auto;
  margin-top: 3px;
  height: 24px;
  padding: 0 10px;
  border: 1px solid var(--a-border);
  border-radius: 999px;
  background: var(--a-surface-2);
  color: var(--a-fg-2);
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
}
.agnes__statusDot {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: var(--a-ok);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--a-ok) 16%, transparent);
}
.agnes__status--off { color: var(--a-fg-3); }
.agnes__status--off .agnes__statusDot {
  background: var(--a-warn);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--a-warn) 16%, transparent);
}
.agnes__status--loading .agnes__statusDot {
  background: var(--a-fg-3);
  box-shadow: none;
  animation: agnes-pulse 1.4s ease-in-out infinite;
}
@keyframes agnes-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }

/* ---------------------------------------------------------------------------
   Two-pane body
   ---------------------------------------------------------------------------
   A single 1200px-wide column made every input 1200px wide and pushed the
   gallery below the fold. Composer left, results right: the prompt field gets a
   readable measure, and the gallery gets the space a picture grid needs.
   ------------------------------------------------------------------------- */
.agnes__body {
  display: grid;
  grid-template-columns: minmax(0, 372px) minmax(0, 1fr);
  gap: 16px;
  align-items: stretch;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
@media (max-width: 940px) {
  /* One column cannot split the remaining height between two scrolling panes
     without each getting half of it, so the page scrolls again and the panes
     stop clipping. */
  .agnes { overflow: auto; }
  .agnes__body { display: flex; flex-direction: column; overflow: visible; }
  .agnes__composer,
  .agnes__gallery { overflow: visible; max-height: none; }
}

/* ---------------------------------------------------------------------------
   Composer
   ------------------------------------------------------------------------- */
.agnes__composer {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 12px;
  overflow: hidden;
  border: 1px solid var(--a-border);
  border-radius: var(--a-radius-lg);
  background: var(--a-surface);
  box-shadow: var(--a-shadow);
}

/* The scrolling half of the composer: tabs, notices and the fields.
   The mask is the scroll affordance: a pane that clips a row of chips mid-height
   with no fade reads as a layout bug, not as "there is more below". */
.agnes__composerScroll {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 2px;
  padding-bottom: 8px;
  scrollbar-gutter: stable;
  overscroll-behavior: contain;
  -webkit-mask-image: linear-gradient(180deg, #000 0, #000 calc(100% - 22px), transparent 100%);
  mask-image: linear-gradient(180deg, #000 0, #000 calc(100% - 22px), transparent 100%);
}

/* The pinned action row. Without it the submit is the last thing in a long form
   and scrolls out of reach on the video tab, which reads as "there is no way to
   submit this". */
.agnes__composerFoot {
  display: flex;
  flex-direction: column;
  gap: 7px;
  flex: none;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--a-border);
}

.agnes__tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 3px;
  padding: 3px;
  border: 1px solid var(--a-border);
  border-radius: 10px;
  background: var(--a-surface-2);
}
.agnes__tab {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 28px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--a-fg-3);
  font: inherit;
  font-size: 12px;
  font-weight: 550;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease, box-shadow 120ms ease;
}
.agnes__tab:hover { color: var(--a-fg); background: color-mix(in srgb, var(--a-fg) 5%, transparent); }
.agnes__tab--on {
  color: var(--a-fg);
  font-weight: 600;
  background: var(--a-surface);
  border-color: var(--a-border);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.07);
}
.agnes__tab--on .agnes__tabIcon { color: var(--a-accent); }
.agnes__tab:focus-visible { outline: 2px solid var(--a-accent); outline-offset: 1px; }
.agnes__tabIcon { display: inline-flex; flex: none; color: currentColor; transition: color 120ms ease; }

.agnes__form { display: flex; flex-direction: column; gap: 12px; min-width: 0; }

.agnes__label {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 11px;
  font-weight: 600;
  color: var(--a-fg-2);
  letter-spacing: 0.01em;
}

/* A prompt field with its own footer: the counter and the example row live
   inside the same border, so the control reads as one box. */
.agnes__promptBox {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--a-border-strong);
  border-radius: var(--a-radius);
  background: var(--a-field);
  transition: border-color 120ms ease, box-shadow 120ms ease;
}
.agnes__promptBox:hover { border-color: color-mix(in srgb, var(--a-fg) 22%, transparent); }
.agnes__promptBox:focus-within {
  border-color: var(--a-accent);
  box-shadow: 0 0 0 3px var(--a-accent-soft);
}
.agnes__prompt {
  display: block;
  width: 100%;
  box-sizing: border-box;
  min-height: 84px;
  padding: 9px 11px 4px;
  border: 0;
  background: transparent;
  color: var(--a-fg);
  font: inherit;
  font-size: 13px;
  line-height: 1.6;
  resize: vertical;
  outline: none;
}
.agnes__prompt::placeholder { color: var(--a-fg-3); }
.agnes__prompt:disabled { cursor: not-allowed; opacity: 0.6; }
.agnes__promptFoot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 9px 6px;
  min-height: 20px;
}
/* Prompt optimizer: a quiet tertiary action inside the prompt box, so it never
   competes with the primary Generate button below. */
.agnes__optimize {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  height: 20px;
  padding: 0 7px;
  border: 1px solid var(--a-border);
  border-radius: var(--a-radius-sm);
  background: var(--a-surface);
  color: var(--a-fg-2);
  font: inherit;
  font-size: 10.5px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: border-color 120ms ease, color 120ms ease, background 120ms ease;
}
.agnes__optimize:hover:not(:disabled) {
  border-color: var(--a-accent-line);
  color: var(--a-accent);
  background: var(--a-accent-soft);
}
.agnes__optimize:disabled { opacity: 0.5; cursor: default; }
.agnes__optimize:focus-visible { outline: 2px solid var(--a-accent); outline-offset: 1px; }

.agnes__optimizedTag {
  flex: none;
  max-width: 15ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10.5px;
  color: var(--a-accent);
}
.agnes__undo {
  appearance: none;
  flex: none;
  padding: 0;
  border: 0;
  background: none;
  color: var(--a-fg-3);
  font: inherit;
  font-size: 10.5px;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
.agnes__undo:hover { color: var(--a-fg); }

.agnes__counter {
  margin-left: auto;
  flex: none;
  font-size: 10.5px;
  color: var(--a-fg-3);
  font-variant-numeric: tabular-nums;
}
.agnes__counter--near { color: var(--a-warn); }

/* Example prompts: three chips that fill the empty composer. Without them the
   first run is a blank textarea and a disabled-looking button. */
.agnes__examples { display: flex; flex-wrap: wrap; gap: 4px; }
.agnes__example {
  appearance: none;
  max-width: 100%;
  padding: 3px 8px;
  border: 1px dashed var(--a-border-strong);
  border-radius: 999px;
  background: transparent;
  color: var(--a-fg-3);
  font: inherit;
  font-size: 10.5px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: color 120ms ease, border-color 120ms ease, background 120ms ease;
}
.agnes__example:hover:not(:disabled) {
  color: var(--a-accent);
  border-color: var(--a-accent-line);
  background: var(--a-accent-soft);
}
.agnes__example:disabled { opacity: 0.5; cursor: not-allowed; }

/* Select with a positioned chevron; "appearance: none" alone leaves no affordance. */
.agnes__selectWrap { position: relative; display: block; }
.agnes__selectWrap .agnes__chevron {
  position: absolute;
  top: 50%;
  right: 9px;
  transform: translateY(-50%);
  pointer-events: none;
  color: var(--a-fg-3);
}
.agnes__field {
  appearance: none;
  width: 100%;
  box-sizing: border-box;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--a-border-strong);
  border-radius: var(--a-radius-sm);
  background: var(--a-field);
  color: var(--a-fg);
  font: inherit;
  font-size: 12.5px;
  font-weight: 500;
  transition: border-color 120ms ease, box-shadow 120ms ease;
}
.agnes__field:hover:not(:disabled) { border-color: color-mix(in srgb, var(--a-fg) 22%, transparent); }
.agnes__field:focus-visible {
  outline: none;
  border-color: var(--a-accent);
  box-shadow: 0 0 0 3px var(--a-accent-soft);
}
.agnes__field:disabled { opacity: 0.55; cursor: not-allowed; }
select.agnes__field { padding-right: 28px; cursor: pointer; }
textarea.agnes__field { height: auto; min-height: 72px; padding: 8px 10px; resize: vertical; line-height: 1.55; }

.agnes__row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }

/* Segmented single-choice control: 2–4 options, every option visible, one press
   to change. A <select> hides the alternatives behind a popup and, at four
   options, costs a click more for no benefit. */
.agnes__seg {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(0, 1fr);
  gap: 3px;
  padding: 3px;
  border: 1px solid var(--a-border);
  border-radius: 9px;
  background: var(--a-surface-2);
}
.agnes__segBtn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 25px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--a-fg-3);
  font: inherit;
  font-size: 11.5px;
  font-weight: 550;
  white-space: nowrap;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease, box-shadow 120ms ease;
}
.agnes__segBtn:hover:not(:disabled) { color: var(--a-fg); background: color-mix(in srgb, var(--a-fg) 6%, transparent); }
.agnes__segBtn--on {
  color: var(--a-fg);
  font-weight: 600;
  background: var(--a-surface);
  border-color: var(--a-border);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}
.agnes__segBtn:focus-visible { outline: 2px solid var(--a-accent); outline-offset: 1px; }
.agnes__segBtn:disabled { opacity: 0.5; cursor: not-allowed; }

/* Option chips: larger sets (8 ratios, 9 durations) that would not fit a
   segmented control without shrinking the labels to illegibility. */
.agnes__chips { display: flex; flex-wrap: wrap; gap: 5px; }
.agnes__chip {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 25px;
  padding: 0 9px;
  border: 1px solid var(--a-border);
  border-radius: 999px;
  background: var(--a-surface-2);
  color: var(--a-fg-2);
  font: inherit;
  font-size: 11px;
  font-weight: 550;
  cursor: pointer;
  transition: color 120ms ease, border-color 120ms ease, background 120ms ease;
}
.agnes__chip:hover:not(:disabled) { color: var(--a-fg); border-color: var(--a-border-strong); }
.agnes__chip--on {
  color: var(--a-accent);
  border-color: var(--a-accent-line);
  background: var(--a-accent-soft);
  font-weight: 600;
}
.agnes__chip:focus-visible { outline: 2px solid var(--a-accent); outline-offset: 1px; }
.agnes__chip:disabled { opacity: 0.5; cursor: not-allowed; }

/* A tiny proportional box, so "16:9" is recognisable before it is read. */
.agnes__ratioGlyph {
  display: block;
  flex: none;
  box-sizing: border-box;
  border: 1.5px solid currentColor;
  border-radius: 2px;
  opacity: 0.75;
}

.agnes__hint {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10.5px;
  font-weight: 400;
  color: var(--a-fg-3);
}
.agnes__hintRow { display: flex; align-items: center; gap: 6px; margin-top: -4px; }

/* References */
.agnes__refs { display: flex; flex-direction: column; gap: 6px; }
.agnes__refRow { display: flex; gap: 6px; align-items: center; }
.agnes__refRow .agnes__field { flex: 1; min-width: 0; }
.agnes__refAdd {
  appearance: none;
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 27px;
  padding: 0 10px;
  border: 1px dashed var(--a-border-strong);
  border-radius: 999px;
  background: transparent;
  color: var(--a-fg-2);
  font: inherit;
  font-size: 11px;
  font-weight: 550;
  cursor: pointer;
  transition: color 120ms ease, border-color 120ms ease, background 120ms ease;
}
.agnes__refAdd:hover:not(:disabled) {
  color: var(--a-accent);
  border-color: var(--a-accent-line);
  background: var(--a-accent-soft);
}
.agnes__refAdd:disabled { opacity: 0.5; cursor: not-allowed; }
.agnes__refAdd:focus-visible { outline: 2px solid var(--a-accent); outline-offset: 2px; }

/* ---------------------------------------------------------------------------
   Buttons
   ------------------------------------------------------------------------- */
.agnes__button {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--a-border-strong);
  border-radius: var(--a-radius-sm);
  background: var(--a-surface);
  color: var(--a-fg);
  font: inherit;
  font-size: 12px;
  font-weight: 550;
  white-space: nowrap;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease, box-shadow 120ms ease, transform 80ms ease;
}
.agnes__button:hover:not(:disabled) { background: color-mix(in srgb, var(--a-fg) 5%, var(--a-surface)); }
.agnes__button:active:not(:disabled) { transform: translateY(1px); }
.agnes__button:disabled { opacity: 0.5; cursor: not-allowed; }
.agnes__button:focus-visible { outline: 2px solid var(--a-accent); outline-offset: 2px; }

/* The one accent-filled control in the panel.
   The previous version kept the gradient and dropped it to "opacity: .45" when
   disabled, which over a white page is a pale lilac slab with white text on it —
   unreadable, and it made the panel's primary action look broken rather than
   unavailable. A disabled primary is now a flat muted surface, and the gradient
   only ever appears at full strength. */
.agnes__button--primary {
  width: 100%;
  height: 36px;
  border-color: transparent;
  color: #fff;
  font-size: 12.5px;
  font-weight: 650;
  letter-spacing: 0.01em;
  background: linear-gradient(135deg, ${ACCENT_IMAGE} 0%, ${ACCENT_IMAGE} 42%, ${ACCENT_VIDEO} 100%);
  box-shadow: 0 1px 2px rgba(30, 27, 75, 0.22), 0 6px 16px -7px rgba(79, 70, 229, 0.6);
}
.agnes__button--primary:hover:not(:disabled) {
  background: linear-gradient(135deg, ${ACCENT_IMAGE} 0%, ${ACCENT_IMAGE} 42%, ${ACCENT_VIDEO} 100%);
  filter: brightness(1.07) saturate(1.04);
  box-shadow: 0 2px 4px rgba(30, 27, 75, 0.24), 0 10px 22px -8px rgba(79, 70, 229, 0.7);
}
.agnes__button--primary:disabled {
  background: var(--a-surface-2);
  border-color: var(--a-border);
  color: var(--a-fg-3);
  box-shadow: none;
  filter: none;
  opacity: 1;
}
.agnes__button--danger { color: var(--a-danger); border-color: color-mix(in srgb, var(--a-danger) 40%, transparent); }
.agnes__button--danger:hover:not(:disabled) { background: color-mix(in srgb, var(--a-danger) 9%, var(--a-surface)); }
.agnes__button--ghost { border-color: transparent; background: transparent; color: var(--a-fg-2); font-weight: 500; }
.agnes__button--ghost:hover:not(:disabled) { background: color-mix(in srgb, var(--a-fg) 7%, transparent); color: var(--a-fg); }

.agnes__iconBtn {
  appearance: none;
  display: inline-grid;
  place-items: center;
  width: 27px;
  height: 27px;
  flex: none;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--a-fg-3);
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.agnes__iconBtn:hover:not(:disabled) { background: color-mix(in srgb, var(--a-fg) 8%, transparent); color: var(--a-fg); }
.agnes__iconBtn:disabled { opacity: 0.4; cursor: not-allowed; }
.agnes__iconBtn:focus-visible { outline: 2px solid var(--a-accent); outline-offset: 1px; }
.agnes__iconBtn--danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--a-danger) 12%, transparent);
  color: var(--a-danger);
}

.agnes__actions { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; }

/* ---------------------------------------------------------------------------
   Notices, errors, progress
   ------------------------------------------------------------------------- */
.agnes__notice {
  display: flex;
  gap: 9px;
  padding: 10px 11px;
  border: 1px solid color-mix(in srgb, var(--a-warn) 38%, transparent);
  border-radius: var(--a-radius);
  background: color-mix(in srgb, var(--a-warn) 9%, transparent);
}
.agnes__noticeIcon { flex: none; margin-top: 1px; color: var(--a-warn); }
.agnes__noticeText { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.agnes__noticeTitle { font-size: 12px; font-weight: 600; color: var(--a-fg); }
.agnes__noticeBody { font-size: 11.5px; line-height: 1.5; color: var(--a-fg-2); }

.agnes__error {
  display: flex;
  gap: 9px;
  padding: 10px 11px;
  border: 1px solid color-mix(in srgb, var(--a-danger) 36%, transparent);
  border-radius: var(--a-radius);
  background: color-mix(in srgb, var(--a-danger) 7%, transparent);
}
.agnes__errorIcon { flex: none; margin-top: 1px; color: var(--a-danger); }
.agnes__errorText { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
.agnes__errorTitle { font-size: 12px; font-weight: 600; color: var(--a-fg); }
.agnes__errorBody { font-size: 11.5px; line-height: 1.5; color: var(--a-fg-2); white-space: pre-wrap; word-break: break-word; }
.agnes__error .agnes__actions { gap: 5px; margin-top: 2px; }
.agnes__error .agnes__button { height: 26px; font-size: 11.5px; padding: 0 10px; }

.agnes__busy {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 9px 11px;
  border: 1px solid var(--a-accent-line);
  border-radius: var(--a-radius);
  background: var(--a-accent-soft);
}
.agnes__busyRow { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--a-fg); }
.agnes__cancelJob { height: 20px; padding: 0 8px; font-size: 10.5px; }
.agnes__busyHint { font-size: 10.5px; color: var(--a-fg-3); }
.agnes__busyTrack {
  position: relative;
  height: 2px;
  border-radius: 2px;
  overflow: hidden;
  background: color-mix(in srgb, var(--a-accent) 20%, transparent);
}
.agnes__busyBar {
  position: absolute;
  inset: 0 auto 0 0;
  width: 38%;
  border-radius: 2px;
  background: linear-gradient(90deg, transparent, var(--a-accent), transparent);
  animation: agnes-indeterminate 1.5s ease-in-out infinite;
}
@keyframes agnes-indeterminate {
  0% { transform: translateX(-105%); }
  100% { transform: translateX(370%); }
}

.agnes__refine {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 11px;
  border: 1px solid var(--a-accent-line);
  border-radius: var(--a-radius);
  background: var(--a-accent-soft);
}
.agnes__refineThumb {
  width: 38px;
  height: 38px;
  flex: none;
  border-radius: var(--a-radius-sm);
  border: 1px solid var(--a-border);
  background: var(--a-surface-2);
  object-fit: cover;
}
.agnes__refineIcon {
  width: 30px;
  height: 30px;
  flex: none;
  display: grid;
  place-items: center;
  color: var(--a-accent);
}
.agnes__refineText { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.agnes__refineTitle { font-size: 12px; font-weight: 600; color: var(--a-fg); }
.agnes__refineBody { font-size: 10.5px; line-height: 1.45; color: var(--a-fg-2); }
.agnes__refine .agnes__button { height: 24px; padding: 0 9px; font-size: 11px; }

.agnes__spinner {
  width: 12px;
  height: 12px;
  flex: none;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--a-accent) 25%, transparent);
  border-top-color: var(--a-accent);
  animation: agnes-spin 700ms linear infinite;
}
@keyframes agnes-spin { to { transform: rotate(360deg); } }

/* ---------------------------------------------------------------------------
   Gallery
   ------------------------------------------------------------------------- */
.agnes__gallery {
  display: flex;
  flex-direction: column;
  gap: 11px;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  padding-right: 2px;
  scrollbar-gutter: stable;
  overscroll-behavior: contain;
}

.agnes__galleryHead {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding-bottom: 2px;
  background: var(--dsw-alias-bg-base, Canvas);
}
.agnes__galleryTitle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 13px;
  font-weight: 650;
  color: var(--a-fg);
}
.agnes__count {
  padding: 1px 7px;
  border: 1px solid var(--a-border);
  border-radius: 999px;
  background: var(--a-surface-2);
  color: var(--a-fg-3);
  font-size: 10.5px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.agnes__spacer { flex: 1; }

.agnes__filters {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--a-border);
  border-radius: 999px;
  background: var(--a-surface-2);
}
.agnes__filter {
  appearance: none;
  height: 21px;
  padding: 0 9px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--a-fg-3);
  font: inherit;
  font-size: 10.5px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.agnes__filter:hover { color: var(--a-fg); }
.agnes__filter--on {
  color: var(--a-fg);
  background: var(--a-surface);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.09);
}
.agnes__filter:focus-visible { outline: 2px solid var(--a-accent); outline-offset: 1px; }

.agnes__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  padding: 46px 22px;
  border: 1px dashed var(--a-border-strong);
  border-radius: var(--a-radius-lg);
  background: color-mix(in srgb, var(--a-fg) 1.5%, transparent);
  text-align: center;
}
.agnes__emptyIcon {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  margin-bottom: 2px;
  border: 1px solid var(--a-border);
  border-radius: 13px;
  background: var(--a-surface);
  color: var(--a-fg-3);
  box-shadow: var(--a-shadow);
}
.agnes__emptyTitle { font-size: 12.5px; font-weight: 600; color: var(--a-fg-2); }
.agnes__emptyBody { max-width: 36ch; font-size: 11.5px; line-height: 1.55; color: var(--a-fg-3); }

.agnes__grid {
  display: grid;
  gap: 13px;
  grid-template-columns: repeat(auto-fill, minmax(196px, 1fr));
  align-items: start;
  padding-bottom: 6px;
}

.agnes__card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--a-border);
  border-radius: var(--a-radius);
  background: var(--a-surface);
  transition: border-color 140ms ease, box-shadow 140ms ease, transform 140ms ease;
}
.agnes__card:hover {
  border-color: var(--a-border-strong);
  box-shadow: var(--a-shadow-lift);
  transform: translateY(-1px);
}
.agnes__card--failed { border-color: color-mix(in srgb, var(--a-danger) 38%, transparent); }
/* A record retried from its own card: the accent border marks the row the user
   restarted, so the card reads as "working" rather than "failed". */
.agnes__card--retrying { border-color: color-mix(in srgb, var(--a-accent) 45%, transparent); }
.agnes__card--refining {
  border-color: color-mix(in srgb, var(--a-accent) 48%, transparent);
  box-shadow: 0 0 0 2px var(--a-accent-soft);
}

/* A uniform 4:3 frame with "cover": a ragged grid of natural aspect ratios
   leaves holes under every short card and reads as a layout bug. The crop is a
   preview only — the viewer shows the whole picture. */
.agnes__thumbFrame,
.agnes__thumbButton {
  position: relative;
  display: block;
  width: 100%;
  aspect-ratio: 4 / 3;
  margin: 0;
  padding: 0;
  border: 0;
  overflow: hidden;
  background: var(--a-surface-2);
}
.agnes__thumbButton { appearance: none; color: inherit; font: inherit; cursor: zoom-in; }
.agnes__thumbButton:disabled { cursor: default; }
.agnes__thumb {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 240ms ease;
}
.agnes__thumbButton:hover .agnes__thumb { transform: scale(1.025); }

/* Hover affordance on the thumbnail: without it nothing signals that the
   picture is clickable, and the 打开原图 button below the fold was the only hint. */
.agnes__thumbVeil {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  gap: 4px;
  color: #fff;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0) 35%, rgba(0, 0, 0, 0.42) 100%);
  opacity: 0;
  transition: opacity 150ms ease;
}
.agnes__thumbVeilInner {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border: 1px solid rgba(255, 255, 255, 0.28);
  border-radius: 999px;
  background: rgba(12, 14, 20, 0.42);
  backdrop-filter: blur(6px);
  font-size: 10.5px;
  font-weight: 600;
}
.agnes__thumbButton:hover .agnes__thumbVeil,
.agnes__thumbButton:focus-visible .agnes__thumbVeil { opacity: 1; }
.agnes__thumbButton:focus-visible { outline: 2px solid var(--a-accent); outline-offset: -2px; }

/* A failed record has no picture: show the error glyph on the empty frame so the
   card is not a blank grey rectangle with a caption. */
.agnes__thumbEmpty {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  color: color-mix(in srgb, var(--a-danger) 60%, transparent);
  background: color-mix(in srgb, var(--a-danger) 5%, transparent);
}

/* A video keeps its own aspect: letterboxing a 16:9 clip inside a 4:3 frame with
   "cover" would crop the picture the user is trying to watch. */
.agnes__thumb--contain { object-fit: contain; background: #0b0d12; }

/* The in-flight card.
   The previous panel showed a single line of text above the gallery while a
   request ran, so a slow video looked like nothing was happening. A skeleton
   card in the grid occupies the slot the result will fill. */
.agnes__card--pending { pointer-events: none; }
.agnes__pendingShine {
  position: absolute;
  inset: 0;
  background: linear-gradient(100deg, transparent 20%, color-mix(in srgb, var(--a-fg) 6%, transparent) 50%, transparent 80%);
  background-size: 220% 100%;
  animation: agnes-shimmer 1.6s ease-in-out infinite;
}
@keyframes agnes-shimmer {
  0% { background-position: 130% 0; }
  100% { background-position: -30% 0; }
}
.agnes__pendingBadge {
  position: absolute;
  inset: auto 0 0 0;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 10px;
  font-size: 10.5px;
  font-weight: 550;
  color: var(--a-fg-2);
  background: linear-gradient(180deg, transparent, color-mix(in srgb, var(--a-surface) 88%, transparent));
}
.agnes__pendingLine {
  display: block;
  height: 7px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--a-fg) 8%, transparent);
}

.agnes__cardBody { display: flex; flex-direction: column; gap: 6px; padding: 9px 10px 10px; }
.agnes__promptText {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--a-fg);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
.agnes__facts { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
.agnes__fact {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: var(--a-fg-3);
  font-variant-numeric: tabular-nums;
}
.agnes__factDot { width: 2px; height: 2px; border-radius: 50%; background: currentColor; opacity: 0.6; }
.agnes__failText { margin: 0; font-size: 11px; line-height: 1.45; color: var(--a-danger); word-break: break-word; }
.agnes__retryHint { font-size: 10px; color: var(--a-fg-3); }

.agnes__cardActions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 1px;
  margin-top: 1px;
  padding-top: 6px;
  border-top: 1px solid var(--a-border);
}
/* Four actions share a narrow card: let each label stay on one line and let the
   row wrap as a whole rather than squeezing a label into two characters per row. */
.agnes__cardActions .agnes__open {
  flex: none;
  padding: 0 6px;
  gap: 4px;
  font-size: 10.5px;
  white-space: nowrap;
}
.agnes__open {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--a-fg-2);
  font: inherit;
  font-size: 11px;
  font-weight: 550;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.agnes__open:hover:not(:disabled) { background: color-mix(in srgb, var(--a-fg) 7%, transparent); color: var(--a-fg); }
.agnes__open:disabled { opacity: 0.45; cursor: not-allowed; }
.agnes__open:focus-visible { outline: 2px solid var(--a-accent); outline-offset: 1px; }

.agnes__srOnly {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

/* ---------------------------------------------------------------------------
   Lightbox
   ---------------------------------------------------------------------------
   Rendered in the component tree with "position: fixed" rather than through a
   portal: the browser bundle's envelope can only resolve "react", so importing
   react-dom would break module loading. A fixed overlay is enough because the
   panel's own scroll container establishes no containing block for it.
   Colours here are literal black/white on purpose: the sheet sits above the whole
   app in both themes, and a theme token would make the backdrop follow the page
   instead of dimming it.
   ------------------------------------------------------------------------- */
.agnes__lightbox {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  display: flex;
  flex-direction: column;
  background: rgba(7, 9, 13, 0.9);
  color: #fff;
  animation: agnes-lightbox-in 130ms ease-out both;
}
@keyframes agnes-lightbox-in { from { opacity: 0; } to { opacity: 1; } }

.agnes__lightboxBar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
  padding: 9px 12px;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0.35), rgba(0, 0, 0, 0));
}
.agnes__lightboxMeta { display: flex; flex-direction: column; gap: 0; min-width: 0; margin-right: auto; }
.agnes__lightboxTitle {
  font-size: 12px;
  font-weight: 600;
  line-height: 1.45;
  color: #fff;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 52ch;
}
.agnes__lightboxSub {
  font-size: 10.5px;
  line-height: 1.45;
  color: rgba(255, 255, 255, 0.55);
  font-variant-numeric: tabular-nums;
}

/* Grouped controls read as one instrument cluster instead of five loose
   buttons floating in the corner. */
.agnes__lightboxGroup {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  flex: none;
  padding: 2px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(10px);
}
.agnes__lightboxBtn {
  appearance: none;
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 26px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: rgba(255, 255, 255, 0.86);
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.agnes__lightboxBtn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.16); color: #fff; }
.agnes__lightboxBtn:disabled { opacity: 0.35; cursor: not-allowed; }
.agnes__lightboxBtn:focus-visible { outline: 2px solid #fff; outline-offset: -2px; }

.agnes__lightboxZoom {
  min-width: 40px;
  padding: 0 5px;
  text-align: center;
  font-size: 10.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: rgba(255, 255, 255, 0.82);
}

.agnes__lightboxSave {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 11px;
  flex: none;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
  font: inherit;
  font-size: 11.5px;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
  backdrop-filter: blur(10px);
  transition: background 120ms ease, border-color 120ms ease;
}
.agnes__lightboxSave:hover { background: rgba(255, 255, 255, 0.18); border-color: rgba(255, 255, 255, 0.3); }
.agnes__lightboxSave:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }

.agnes__lightboxStage {
  position: relative;
  flex: 1;
  min-height: 0;
  display: grid;
  place-items: center;
  overflow: hidden;
  cursor: zoom-in;
  touch-action: none;
}
.agnes__lightboxStage--pannable { cursor: grab; }
.agnes__lightboxStage--pannable[data-panning="true"] { cursor: grabbing; }

.agnes__lightboxImage {
  display: block;
  max-width: calc(100vw - 128px);
  max-height: calc(100vh - 128px);
  object-fit: contain;
  user-select: none;
  -webkit-user-select: none;
  -webkit-user-drag: none;
  touch-action: none;
  transform-origin: center center;
  will-change: transform;
  transition: transform 150ms ease-out;
  border-radius: 2px;
  box-shadow: 0 24px 70px -20px rgba(0, 0, 0, 0.8);
  cursor: inherit;
}
/* While a pointer drag is live the transform is written every frame, so a
   transition would make the picture lag the cursor. */
.agnes__lightboxImage[data-dragging="true"] { transition: none; }

/* Previous/next float over the stage edges: they are navigation between
   records, not part of the picture, so they must not shift its centring. */
.agnes__lightboxNav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  display: grid;
  place-items: center;
  width: 40px;
  height: 56px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 12px;
  background: rgba(14, 17, 24, 0.5);
  color: #fff;
  cursor: pointer;
  backdrop-filter: blur(10px);
  opacity: 0.75;
  transition: opacity 120ms ease, background 120ms ease;
}
.agnes__lightboxNav:hover { opacity: 1; background: rgba(14, 17, 24, 0.72); }
.agnes__lightboxNav:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.agnes__lightboxNav--prev { left: 14px; }
.agnes__lightboxNav--next { right: 14px; }

.agnes__lightboxFoot {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  flex: none;
  padding: 6px 14px 11px;
  font-size: 10.5px;
  color: rgba(255, 255, 255, 0.55);
}
.agnes__lightboxHint { display: inline-flex; align-items: center; gap: 5px; }
.agnes__lightboxKbd {
  display: inline-block;
  min-width: 16px;
  padding: 0 4px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.08);
  font-family: var(--dsw-font-markdown-code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 9.5px;
  line-height: 15px;
  text-align: center;
  color: rgba(255, 255, 255, 0.72);
}

/* ---------------------------------------------------------------------------
   Version stack (the "pile")
   ---------------------------------------------------------------------------
   One lineage ("继续编辑" runs) is ONE gallery cell, drawn the way a chat app
   draws several photos sent together: the newest print on top, the next ones
   fanning out behind it as narrow strips of their OWN pictures, and a horizontal
   swipe through them.

   Three things have to be true at once, and the two earlier attempts at this
   each broke exactly one:

   1. It must not move while the pointer is on it. Every version's shot and body
      stay mounted, ALL bodies share one grid cell (so the card is always as tall
      as its tallest version), the picture is a fixed 4:3 box, and both side
      gutters are reserved at all times. A flip is an opacity crossfade plus a
      small paint-only transform during a drag — never a reflow, a resize or a
      remount, and the card's box is identical before and after.
   2. It must say "there are more of these" BEFORE the gesture is used, which is
      what the picture strips do: they are the neighbouring versions' real
      images, not decoration.
   3. It must be operable. The numbered rail jumps straight to a version, so
      every version's own actions stay reachable without expanding.
   ------------------------------------------------------------------------- */
.agnes__stack {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

/* The stage reserves a gutter on BOTH sides for the fan of prints. Reserving it
   unconditionally is what keeps the card's width constant: if the gutter only
   appeared once the user flipped past the newest version, the card would resize
   in the middle of the gesture — the exact jump this component exists to avoid.

   The gutter is taken from OUTSIDE the cell (negative margin plus equal padding)
   rather than from the card's own width. Shrinking the card by the gutter made a
   stacked card narrower than every ordinary card beside it, which re-flowed its
   action row onto a second line — the pile is supposed to look like the same
   card with more prints behind it. */
.agnes__stackStage {
  position: relative;
  --agnes-stack-gutter: 13px;
  margin: 0 calc(-1 * var(--agnes-stack-gutter));
  padding: 0 var(--agnes-stack-gutter);
  /* A horizontal swipe belongs to the pile; a vertical one still scrolls the
     gallery column under the finger. */
  touch-action: pan-y;
}

/* One strip of the fan: a neighbour's own picture, clipped to the gutter.
   The strips sit ABOVE the front card (see the z-index note on .agnes__card--stacked)
   because the card's box shadow spreads across the whole gutter and would
   otherwise paint them out. They never overlap the card's border box, so being
   above it only covers the shadow they are meant to replace. */
.agnes__stackStrip {
  position: absolute;
  z-index: 3;
  overflow: hidden;
  border-radius: 3px;
  border: 1px solid color-mix(in srgb, var(--a-fg) 14%, transparent);
  /* The colour underneath is what shows for a version with no picture (a failed
     record in the chain); the strip's own picture paints over it. */
  background-color: color-mix(in srgb, var(--a-fg) 10%, var(--a-surface));
  /* The picture fills the strip and is CROPPED, not squeezed: a whole shot scaled
     into eleven pixels averages into a flat smear that reads as a border rather
     than as a photo. */
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  /* Decoration only: a strip that took the pointer would dead-zone the swipe and
     swallow the end of a drag. */
  pointer-events: none;
}
/* The strips sit in the reserved gutter, one per layer, with the WIDER one
   nearest the card. The offsets are literal pixels rather than calc(): these are
   three small constants in one rule group, and a calc() that resolves
   differently from what the geometry check measures is indistinguishable from a
   strip that never painted at all.
   Working inward from the stage's PADDING box (whose outer edge is the far side
   of the gutter): layer 1 takes the outermost 3px, layer 0 the next 6px, and the
   remaining pixels stay empty so no strip ever touches the card's border box. */
.agnes__stackStrip[data-layer='0'] {
  top: 4px;
  bottom: 7px;
  /* The visible sliver: the whole gutter minus the outer layer, so the strip
     reads as a photo edge rather than as a hairline. */
  width: 9px;
}
/* right/left 4px puts the strip's outer edge 4px inside the stage edge; with the
   9px width it ends exactly where the card's border box begins. */
.agnes__stackStrip[data-side='left'][data-layer='0'] { left: 4px; }
.agnes__stackStrip[data-side='right'][data-layer='0'] { right: 4px; }
.agnes__stackStrip[data-layer='1'] {
  top: 11px;
  bottom: 14px;
  width: 4px;
  opacity: 0.9;
}
.agnes__stackStrip[data-side='left'][data-layer='1'] { left: 0; }
.agnes__stackStrip[data-side='right'][data-layer='1'] { right: 0; }

/* The front print. It is the only element that carries the card surface, so the
   slivers beside it stay a suggestion rather than a second visible box. */
.agnes__card--stacked {
  position: relative;
  /* Below the strips (z-index 3) and above the stage background: the strips live
     in the gutter outside this card's border box, so they never cover it. */
  z-index: 2;
  background: var(--a-surface);
  box-shadow: var(--a-shadow-lift);
}
/* The generic card lift is deliberately cancelled here: a card that rises 1px
   under a pointer that is flipping it is the exact "it wobbles" complaint. The
   border highlight below is a paint-only cue, so it costs no layout. */
.agnes__card--stacked:hover {
  transform: none;
  border-color: var(--a-border-strong);
  box-shadow: var(--a-shadow-lift);
}

/* The picture area. Fixed 4:3 via the frame inside every shot, so the pile's
   height is a constant of the layout rather than a function of which version is
   showing. The badge and the hint sit above every shot and never fade. */
.agnes__stackMedia {
  position: relative;
  cursor: grab;
  touch-action: pan-y;
  /* The drag offset: one inherited custom property, so following the pointer
     costs a paint and never a React render. */
  --agnes-drag: 0px;
}
.agnes__stackMedia:active { cursor: grabbing; }
.agnes__stackShot {
  position: absolute;
  inset: 0;
  opacity: 0;
  visibility: hidden;
  transform: translate3d(var(--agnes-drag), 0, 0);
  /* Only the incoming shot animates, and only its opacity: a transform or a size
     change here would reintroduce movement under the pointer. The visibility
     flip is delayed by exactly the fade-out so the outgoing picture is still
     painted while it dims (a crossfade, not a blink). */
  transition: opacity 150ms ease-out, visibility 0s linear 150ms;
  will-change: opacity;
}
.agnes__stackShot:first-child {
  /* The first shot defines the area's height; the rest are absolutely stacked
     over it. Without a static one the container would collapse to 0. */
  position: relative;
}
.agnes__stackShot--on {
  opacity: 1;
  visibility: visible;
  /* No delay on the way in: the fade starts on the same frame as the flip. */
  transition: opacity 150ms ease-out, visibility 0s;
  /* The visible shot is the only one in the hit-test path, so the picture's own
     打开大图 button belongs to the version the user is looking at. Hidden shots
     stay in the DOM (that is what keeps their decode alive) but are unreachable
     by pointer, by tab and by screen reader. */
  z-index: 1;
}

/* Every body shares ONE grid cell. The tallest version therefore sets the card's
   height, and flipping between versions shifts nothing. */
.agnes__stackBodies {
  position: relative;
  display: grid;
  grid-template-areas: 'body';
}
.agnes__stackBody {
  grid-area: body;
  min-width: 0;
}
.agnes__stackBody--off {
  /* visibility rather than display:none or content-visibility:hidden on
     purpose: those two remove the box, which would collapse the shared grid
     cell and make the card shrink and grow as the version changes — the exact
     jump this design removes. visibility:hidden keeps the geometry while still
     taking the content out of the hit test, the tab order and the accessibility
     tree. */
  visibility: hidden;
  pointer-events: none;
}

/* The version badge: which version is on the face of the pile right now. */
.agnes__stackBadge {
  position: absolute;
  z-index: 4;
  top: 7px;
  left: 7px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 7px;
  border-radius: 999px;
  background: rgba(12, 14, 20, 0.62);
  backdrop-filter: blur(6px);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}

/* The gesture affordance: shown while the pointer is over the picture, and
   retired as soon as the user has actually flipped one, because at that point
   the badge is already explaining what happened. */
.agnes__stackHint {
  position: absolute;
  z-index: 4;
  right: 7px;
  bottom: 7px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 7px;
  border-radius: 999px;
  background: rgba(12, 14, 20, 0.62);
  backdrop-filter: blur(6px);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  white-space: nowrap;
  opacity: 0;
  transition: opacity 130ms ease-out;
  pointer-events: none;
}
.agnes__stackStage:hover .agnes__stackHint { opacity: 1; }
/* Once the pointer has committed to a flip, the label has done its job. */
.agnes__stack[data-flipping='true'] .agnes__stackHint { opacity: 0; transition: opacity 90ms ease-out; }
@media (hover: none) {
  /* Touch has no hover; the swipe itself plus the rail carry the interaction. */
  .agnes__stackHint { display: none; }
}

/* Inside a pile the picture is a swipe surface first and a button second. The
   generic card's thumbnail affordances fight both: the 2.5% zoom is a transform
   under a pointer that is trying to drag, and the "查看大图" veil covers the very
   corner the hint occupies. The action row still offers 查看大图, so nothing
   becomes unreachable — and the picture keeps its click, because clicking it
   still opens the viewer. */
.agnes__stackMedia .agnes__thumbButton:hover .agnes__thumb { transform: none; }
.agnes__stackMedia .agnes__thumbVeil { display: none; }
/* The picture is a drag surface here. A native image drag would take over the
   gesture and cancel it, and a text selection left behind by a drag looks like
   a rendering bug, so both are turned off inside the pile. */
.agnes__stackMedia .agnes__thumb { -webkit-user-drag: none; user-select: none; }

/* The bar under the card: the version rail on the left, expanding on the right.
   A fixed min-height keeps the gallery rhythm when the pending strip appears. */
.agnes__stackBar {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 24px;
  padding: 0 1px;
}
.agnes__stackBar .agnes__open { flex: none; padding: 0 6px; font-size: 10.5px; white-space: nowrap; }

/* The version rail. Clicking a pill COMMITS to that version, which is the
   precise counterpart to the swipe: a 190px pile with eight versions is fine for
   browsing and useless for "show me version 3". */
.agnes__stackPills {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px;
  min-width: 0;
  /* The rail is the PRECISE control, so it may never clip a version away: a long
     chain wraps onto a second row of numbers instead of hiding the tail. Its bar
     grows with it; the card itself does not move, because the bar lives outside
     the card in the cell's own column. */
}
.agnes__stackPill {
  appearance: none;
  flex: none;
  display: inline-grid;
  place-items: center;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--a-fg-3);
  font: inherit;
  font-size: 10px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  transition: background 110ms ease, color 110ms ease, border-color 110ms ease;
}
.agnes__stackPill:hover { background: color-mix(in srgb, var(--a-fg) 8%, transparent); color: var(--a-fg); }
.agnes__stackPill--on {
  /* Colour only — no border, no size change: the rail must not reflow when the
     active version changes, or the pills would slide out from the pointer. */
  background: var(--a-accent-soft);
  color: var(--a-accent);
}
.agnes__stackPill:focus-visible { outline: 2px solid var(--a-accent); outline-offset: 1px; }

/* The "a new version is being generated" strip, inline with the rail so it does
   not add a row that would make the card jump when it appears. */
.agnes__stackPending {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 10.5px;
  font-weight: 550;
  color: var(--a-accent);
}

/* The expanded header spans the whole grid row, so it reads as the group's
   title rather than as a card of its own. */
.agnes__stackExpandedBar {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 2px 0;
  border-top: 1px dashed var(--a-border);
  padding-top: 8px;
}
.agnes__stackExpandedLabel {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  font-weight: 600;
  color: var(--a-fg-2);
}

/* Between attempts of a continuous retry nothing is being generated: the
   shimmer is dimmed to a static tint so the card does not look busy while it
   waits out a full queue. */
.agnes__pendingShine--waiting { animation: none; opacity: 0.5; }
.agnes__attempts {
  display: inline-flex;
  align-items: center;
  font-size: 10px;
  font-weight: 600;
  color: var(--a-accent);
  font-variant-numeric: tabular-nums;
}

@media (prefers-reduced-motion: reduce) {
  .agnes__lightbox { animation: none; }
  .agnes__lightboxImage { transition: none; }
  .agnes__thumb { transition: none; }
  .agnes__card { transition: none; }
  .agnes__card:hover { transform: none; }
  .agnes__busyBar { animation-duration: 3.2s; }
  .agnes__spinner { animation-duration: 2.4s; }
  .agnes__status--loading .agnes__statusDot { animation: none; opacity: 0.6; }
}

@media (max-width: 620px) {
  .agnes { padding: 14px 13px 18px; }
  .agnes__row { grid-template-columns: 1fr; }
  .agnes__grid { grid-template-columns: repeat(auto-fill, minmax(148px, 1fr)); gap: 10px; }
  .agnes__lightboxTitle { max-width: 24ch; }
  .agnes__lightboxNav { width: 34px; height: 46px; }
}
`

/** Render the panel stylesheet as a React element. */
export function StudioStyles(): ReactElement {
  // `createElement` rather than JSX so this module stays a plain `.ts` file: the
  // stylesheet is one static string, never user data, so React can own the text
  // child directly with no escaping concern.
  return createElement('style', null, STUDIO_CSS)
}
