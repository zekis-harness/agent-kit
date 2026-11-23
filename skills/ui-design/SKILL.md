---
name: ui-design
description: Visual rules for building or restyling any UI (sites, web apps, dashboards, landing pages, chat screens). Lists the AI default looks to avoid, a default futuristic modern style, layout, color, motion, mobile web and CSS details. Use whenever building or editing UI, together with ui-copy for the words.
---

# UI design

AI-built UI looks AI-built because agents reach for the same defaults every time. Treat every default below as banned unless the project already uses it or the user asks for it. Words on the screen follow the `ui-copy` skill.

## Never

### AI default looks
- Eyebrow labels (small all-caps line) above headings. Allowed only when the label carries information the heading does not.
- Purple or purple-to-blue gradients, gradient headline text, frosted-glass panels.
- Cursor-following glow or spotlight on cards.
- A pill badge above a centered hero title. An italic serif accent word inside a sans headline (the Instrument Serif look).
- A border on every container, cards nested in cards, dividers between every row.
- Section numbering ("01 / 02") and code-style breadcrumbs as decoration. ASCII art, dithering, squircles as decoration.
- Mono font on every label. Mono is for numbers, code, IDs and data.
- A single floating 3D object as the hero.
- Stock "modern and professional" with no stated reference. If there is no brief, pick fonts and one reference site on purpose and say which.

### Layout and hierarchy
- Two buttons with equal weight. Each screen has one main action, visually stronger than everything near it.
- Advanced options shown up front. Reveal them on demand, at most two levels deep.
- Deleting options to look minimal. Group them and set defaults instead.
- Dead-end empty states. One line on what appears here plus one button with a verb label ("Start an order", never "OK").
- Layout shift. Reserve space for anything that loads or streams; bold or active tab text must not change the row width.
- Cards of uneven height from long titles. Cap with `line-clamp`.

### Color and contrast
- Body text under 4.5:1 contrast (3:1 for large text and UI borders). Compute it, do not eyeball light grey.
- More than one accent color. The accent goes on the main action and at most one highlighted word or element.
- HSL palettes. Build shades in OKLCH so equal lightness looks equal. Gradients use `in oklch` (or `in oklab` to avoid hue sweep) so the middle does not go grey.
- Solid hex borders across varied backgrounds. Use alpha borders (`rgb(0 0 0 / 0.12)`, or white alpha on dark).
- Shadows as the only depth cue in dark mode. Raised surfaces get lighter.
- Neumorphism without visible borders that pass 3:1.

### Motion
- UI animation over about 300ms (400ms only for large moves). Default ease-out.
- Animating actions people repeat constantly.
- Ignoring `prefers-reduced-motion`.
- Motion that cannot be interrupted. A second click must win over a running animation.

### Mobile web
- Input font size under 16px (iPhone zooms on focus).
- Hover styles outside `@media (hover: hover)`.
- `100vh` for full-height layouts. Use `100svh` when content must never hide, `100dvh` when resizing on scroll is fine, with a `vh` fallback.
- Disabling pinch zoom. Use `touch-action: manipulation` to stop double-tap zoom only.
- The default keyboard for typed fields. Set `inputmode="numeric"`, `type="email"` with `autocapitalize="none"`, `autocomplete="one-time-code"`, `enterkeyhint="send"` in chat inputs.
- Popups whose scroll leaks to the page. Add `overscroll-behavior: contain`.
- Carousels that stop between cards. Use `scroll-snap-type: x mandatory` with `scroll-snap-align: start`.
- Tap targets under 44px.

### Type and CSS details
- Underlines through descenders. Set `text-underline-offset: 0.2em`.
- Headline sizes that jump at breakpoints. Use `clamp()`, with the max at least twice the min.
- Straight quotes in display text. Use curly quotes.
- End-truncated file names. Truncate in the middle and keep the extension.
- Inner radius that ignores the outer one. Inner = outer minus padding, floor at zero.
- Icon stroke weight that does not match the adjacent text weight.
- `hyphens: auto` without `lang` on `<html>`.
- `text-box-trim` without an `@supports` guard.

### Chat and agent screens
- Hidden work. Show steps and cite sources while the agent runs.
- Writes without approval. Hard-to-undo or outward-facing actions get approve, edit or reject.
- Blank starts. Offer a few tappable starter prompts.

## Default style

If `~/.zekis-harness/profile.md` has a `## UI style` section, it overrides this one.

For sites and apps with no existing design system, default to futuristic and modern. That means precise and technical, not sci-fi costume.

- Type: a geometric or grotesk sans with character for display, a clean sans for body, a mono for data. Free picks: Geist + Geist Mono, Sora, Space Grotesk, Unbounded or Syne (display only), Satoshi, General Sans or Clash Display (Fontshare), JetBrains Mono or IBM Plex Mono. Vary the pick between projects. Never Orbitron or Audiowide. Do not default to Inter or Roboto.
- Surfaces: dark-first, near-black with a slight hue (not pure `#000`), lighter raised surfaces, thin alpha borders where a boundary is needed.
- Color: neutrals plus one saturated accent in OKLCH. Not purple-blue.
- Layout: strict grid, generous negative space, large confident headlines, tight data density in tool UIs (Linear is the reference for app UI).
- Detail: tabular numerals for data, small precise motion, subtle grain on large gradients to stop banding.
- Light mode still has to work when the product needs it.

When unsure whether a choice reads as futuristic or as an AI default, pick the quieter option.

## References

Name 2 or 3 references and the specific quality to borrow from each ("Linear's density", "Stripe's landing hierarchy", "Apple's motion timing"). Never copy a brand's fonts, colors or animations.

## Before calling UI done

- Open it in a browser (`use-chrome`) at about 390px and 1440px wide, in dark and light if both exist. Screenshot and look.
- Check text contrast on every new color pair.
- Read the Never list against the screen and remove anything that matches.
- Run the `ui-copy` check on every new string.
