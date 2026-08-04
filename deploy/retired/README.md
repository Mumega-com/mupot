# Retired host units — product-organism fleet

These files document the **retired** organ-daemon oneshot+timeout shape.
They are **not** install targets. Do not enable them.

Canonical decision: `docs/operations/organisms-retirement-2026-08-04.md`
(path **c** for mumega-com#595 / mupot task `938ca06d`).

If a project needs SOS organism pulses later, use the SOS runbook daemon unit
(`Type=simple`, `Restart=always`) — never this batch wrapper.
