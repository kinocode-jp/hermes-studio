import assert from "node:assert/strict";
import test from "node:test";
import { extractSupportedLinkPreviewUrls, linkifyExternalUrls } from "../src/components/link-preview.tsx";

test("supported social and media URLs are selected for rich previews", () => {
  assert.deepEqual(extractSupportedLinkPreviewUrls([
    "https://youtu.be/M7lc1UVf-VE",
    "https://x.com/XDevelopers/status/1234567890",
    "https://vimeo.com/76979871",
    "https://open.spotify.com/track/2takcwOaAZWiXQijPHIx7B",
    "https://example.com/not-embedded",
  ].join("\n")), [
    "https://youtu.be/M7lc1UVf-VE",
    "https://x.com/XDevelopers/status/1234567890",
    "https://vimeo.com/76979871",
    "https://open.spotify.com/track/2takcwOaAZWiXQijPHIx7B",
  ]);
});

test("Markdown punctuation is kept outside auto-linked URLs", () => {
  assert.deepEqual(linkifyExternalUrls("See https://youtu.be/M7lc1UVf-VE)."), [
    "See ",
    { text: "https://youtu.be/M7lc1UVf-VE", href: "https://youtu.be/M7lc1UVf-VE" },
    ").",
  ]);
});

test("balanced URL parentheses stay linked while surplus closing punctuation stays outside", () => {
  assert.deepEqual(linkifyExternalUrls("See https://en.wikipedia.org/wiki/Function_(mathematics)."), [
    "See ",
    {
      text: "https://en.wikipedia.org/wiki/Function_(mathematics)",
      href: "https://en.wikipedia.org/wiki/Function_(mathematics)",
    },
    ".",
  ]);
  assert.deepEqual(linkifyExternalUrls("Query https://example.com/search?q=(foo))."), [
    "Query ",
    { text: "https://example.com/search?q=(foo)", href: "https://example.com/search?q=(foo)" },
    ").",
  ]);
});
