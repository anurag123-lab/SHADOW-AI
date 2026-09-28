# Third-party notices

Shadow AI uses the open-source software and fonts below. All are used within the
terms of their licences; none are modified. Full licence texts are at the links.

## Bundled inside the browser extension (`extension/vendor/`)

| Component | Version | Licence | Notes |
|---|---|---|---|
| [PDF.js](https://github.com/mozilla/pdf.js) — Mozilla Foundation | 4.6.82 | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | Reads PDF text locally. The licence header is kept intact in `pdf.min.mjs` and `pdf.worker.min.mjs`. |
| [mammoth.js](https://github.com/mwilliamson/mammoth.js) — Michael Williamson | 1.8.0 | [BSD-2-Clause](https://github.com/mwilliamson/mammoth.js/blob/master/LICENSE) | Reads Word (.docx) text locally. |

The same notice ships with the extension as `extension/THIRD_PARTY_NOTICES.txt`.

## Loaded by the web pages (from public CDNs)

| Component | Version | Licence | Used on |
|---|---|---|---|
| [supabase-js](https://github.com/supabase/supabase-js) | 2.45.4 | MIT | Sign-in and dashboard |
| [Chart.js](https://github.com/chartjs/Chart.js) | 4.4.4 | MIT | Dashboard charts |
| [three.js](https://github.com/mrdoob/three.js) | r134 | MIT | Landing page background only |

## Fonts

| Font | Source | Licence |
|---|---|---|
| Inter | Google Fonts | [SIL Open Font License 1.1](https://openfontlicense.org) |
| Clash Display, Satoshi | Fontshare (Indian Type Foundry) | [ITF Free Font License](https://www.fontshare.com/licenses/itf-ffl) — free for personal and commercial use |

## Notifier (Node.js, server side)

| Package | Licence |
|---|---|
| @supabase/supabase-js | MIT |
| nodemailer | MIT-0 |
| dotenv | BSD-2-Clause |

## Original assets

The logo, icons (inline SVG), illustrations, demo documents and all copy were created
for this project. Product names such as ChatGPT, Claude and Gemini are trademarks of
their respective owners and are used only to describe compatibility; no third-party
logos are used.
