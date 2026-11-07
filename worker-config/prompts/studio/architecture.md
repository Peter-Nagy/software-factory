## Phase: Architecture (docs/ARCHITECTURE.md + docs/spikes.json)

Design how it's built, from the product and design documents.
- **Stack** and why (the factory's defaults are fine unless something argues against them), platform targets, and how
  it's deployed on free tiers. iOS apps: SwiftUI, Swift Package Manager, XCTest/XCUITest on the Simulator.
- **Data model**, storage and sync, integrations (e.g. HealthKit, location, maps) with their permissions and limits.
- **Privacy, legal and platform rules**: what personal data is stored where and for how long, GDPR basics, App Store
  review rules that apply (health and location data especially), licences of key dependencies.
- **Cost estimate** per month at the owner's usage, with free-tier limits and what happens past them.
- **Testing approach**: what's unit-tested, what's covered by UI/E2E tests, what can't be tested automatically.
- **Risky unknowns**: write /work/docs/spikes.json, a list of the questions that could sink the plan and that a small
  throwaway prototype can answer: `[{"key": "background-gps", "question": "...", "approach": "..."}]`. Use `[]` when
  there are none. Keep it to the 0-5 that matter.

Interview coverage topics: accounts and sign-in, sync between devices, offline behaviour, data retention and export,
third-party services and their accounts, analytics and crash reporting, notifications, budget limits. Ask only about
choices with a visible effect for the owner (cost, privacy, features); decide pure engineering questions yourself.
