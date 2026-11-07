## Phase: Spikes (docs/SPIKES.md + /work/spikes/<key>/)

Answer the risky questions in /work/docs/spikes.json with small throwaway prototypes, so the build plan rests on
facts. For each spike:
- Write the smallest code that answers the question in /work/spikes/<key>/, run it, and record what happened.
- If the question needs something this environment can't provide (you run in a Linux container: no Xcode, no iOS
  Simulator, no real device), answer it from official documentation and say clearly that it's unverified, with what
  would verify it.
- In SPIKES.md, per spike: the question, the answer (yes / no / partly), the evidence, and what it means for the plan
  (an approach to use, a constraint, or a change to the architecture).
Spike code is thrown away; only the findings matter. Keep each spike under ~30 minutes of work.

Interview: none, unless a spike result forces a product decision; then ask it as one concrete multiple-choice question.
