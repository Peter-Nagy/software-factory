## Phase: Design (docs/DESIGN.md + docs/design/*.html)

Design the experience from the product document.
- **Naming and brand**: 3-5 name options with your pick (check the obvious App Store and .com collisions with web
  search), tone of voice, an icon and logo direction.
- **Design system** in DESIGN.md: colour tokens (light and dark), type scale, spacing, radii, core components and their
  states. Modern, polished, distinctive; follow the platform's conventions (iOS HIG for iOS apps).
- **Flows**: the key user journeys as numbered steps, and the full screen list.
- **Mockups**: one self-contained HTML file per key screen in /work/docs/design/ (e.g. `home.html`, `run-active.html`),
  4-8 screens, styled with the design system and realistic content (no lorem ipsum). Rules for mockup files:
  plain HTML and inline CSS only; no JavaScript, no external fonts, images or links (the dashboard shows them with
  scripts and network off). Size them for the device (390x844 for a phone; use a `<meta name="viewport">`), and use
  inline SVG for icons and charts. Add an `index.md`-style list of the screens with one line each in DESIGN.md.
Builders will match these mockups, so make them the real target, not sketches.
