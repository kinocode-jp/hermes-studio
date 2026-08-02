# Design QA — Centered Chat Reading Width

- Source visual truth: `/Users/kinocode/Desktop/スクリーンショット 2026-07-28 18.44.06.png`
- Source pixels: 2137 × 1813
- Normalized source: `artifacts/design-qa/chat-reference-normalized.png` at 849 × 720
- Implementation: `http://127.0.0.1:4173/`
- Implementation screenshot: `artifacts/design-qa/chat-content-centered-1280x720.png`
- Implementation pixels / CSS viewport: 1280 × 720 at browser density 1
- Combined comparison: `artifacts/design-qa/chat-content-comparison.png` at 2129 × 720
- State: light theme, newly created dashboard, one empty `default`-profile chat pane

## Findings

No actionable P0, P1, or P2 differences remain for the requested centered-width behavior.

- Fonts and typography: existing Hermes Studio typography is unchanged; the task does not ask to clone the reference product's type system.
- Spacing and layout rhythm: transcript and composer both render at the same 720px maximum width. At a 955px chat pane width, both measure 720px and have identical centers (0px center delta). At a 390px viewport, the composer contracts to 390px and the padded transcript content contracts to 366px.
- Colors and visual tokens: existing Hermes Studio surface, line, accent, and text tokens are preserved.
- Image quality and asset fidelity: the target contains no app-specific raster assets to reproduce; no new assets or substitutes were introduced.
- Copy and content: the reference contains an existing conversation while the implementation capture intentionally uses the requested new-chat state. This state mismatch does not affect the width/alignment comparison.

## Full-view Comparison Evidence

The combined image shows the reference on the left and the implementation on the right. In both, the working content stays in a bounded central column while the surrounding pane absorbs additional width. The implementation keeps the dashboard panel itself full width and constrains only the transcript, suggestions, and composer.

## Focused Region Evidence

A separate crop was not needed because the composer and transcript edges are clearly visible in the 1280 × 720 implementation capture. Browser measurements confirm:

- Chat pane: 955px wide, x=325–1280
- Transcript content: 720px wide, x=442.5–1162.5
- Composer: 720px wide, x=442.5–1162.5
- Transcript and composer center delta from pane center: 0px

## Comparison History

1. Initial implementation used a 760px maximum. Centering was exact, but the column appeared wider than the supplied reference.
2. The maximum was reduced to 720px to match the existing message-width convention and improve visual fidelity.
3. Post-fix capture confirmed matching transcript/composer edges, exact centering, responsive contraction, and no browser console errors.

## Primary Interaction and Runtime Checks

- Created a dashboard through the visible “ダッシュボードを作成” control.
- Confirmed the new dashboard opened with one `default`-profile chat pane.
- Confirmed the transcript and composer share the same maximum width and center axis.
- Confirmed responsive contraction at 390 × 720.
- Browser console errors: none.

## Follow-up Polish

No P3 follow-up is required for this scoped change.

final result: passed
