## Phase: Launch kit (docs/LAUNCH.md + docs/launch/*.html)

The build plan is executed and the factory is building the product. Prepare everything needed to launch it, from the
approved documents (brief, research, product, design, architecture). Skip what doesn't apply (a personal tool needs no
store listing or pricing page): say so in one line and move on.

- **Positioning recap**: the one-line pitch, who it's for, and the 3 benefits to lead with.
- **Store listing** (App Store / Play, or the web equivalent): name, subtitle (30 chars), promotional text, description,
  keywords (100 chars, comma-separated, no spaces), category, age rating answers, and the 5-8 screenshots to capture,
  each with its caption and which screen and state to show. Check the length limits.
- **Privacy**: the App Store privacy "nutrition label" answers (data types, linked to the user or not, tracking), and a
  plain-language privacy policy as `docs/launch/privacy.html`, true to ARCHITECTURE.md's data handling. Mark it as a
  draft that a person must check before publishing.
- **Landing page**: `docs/launch/landing.html`, one self-contained page in the product's design system: hero, 3
  benefits, how it works, a call to action, the privacy link. Same rules as design mockups: plain HTML and inline CSS,
  no JavaScript, no external fonts, images or links (it's shown with scripts and network off), realistic copy.
- **Launch posts**: a short announcement for each channel the brief's audience uses (e.g. Reddit community, Product
  Hunt, X, a friends' group chat), each in that channel's style and length.
- **Checklist**: accounts and fees (Apple developer program, domains), review-risk items (from the architecture's
  platform rules), what to measure in the first two weeks (from PRODUCT.md's metrics), and the order to do it all in.

Interview coverage topics: launch goal (friends, a niche community, the store at large), channels, pricing and trial,
the domain and contact address, support, timing. Anything that costs money goes in the checklist with its price.
