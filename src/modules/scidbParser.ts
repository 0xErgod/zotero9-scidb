/**
 * Pure, framework-free helpers for locating and validating the PDF that
 * Sci-Hub serves for a given DOI.
 *
 * None of these functions touch Zotero globals (`Zotero`, `ztoolkit`, `addon`),
 * the network, or the filesystem, so they can be unit-tested in plain Node.
 * `scidb.ts` is the thin, side-effectful orchestrator that wires them to the
 * Zotero HTTP/attachment APIs.
 */

/** Minimal structural view of the parts of a DOM `Document` we rely on. */
export interface ElementLike {
  getAttribute(name: string): string | null;
}
export interface HtmlDocLike {
  querySelector(selectors: string): ElementLike | null;
  documentElement: { outerHTML: string } | null;
}

/**
 * Scrape a PDF URL out of raw page markup. Sci-Hub's current layout only
 * exposes the canonical path inside inline JavaScript (e.g.
 * `url: '/storage/2024/.../paper.pdf'`), so a serialized-HTML regex is the most
 * reliable fallback.
 *
 * Each pattern matches a quoted URL whose path ends in `.pdf`, optionally
 * followed by a query (`?...`) or fragment (`#...`). Requiring `.pdf` to
 * *terminate the path* (the next character is a quote, `?`, or `#`) avoids
 * false positives such as a CSS/SVG asset `sprite.pdf.svg` or a query value
 * `lib.js?v=2.pdf`. The canonical sci-hub `/storage/` path is preferred so a
 * decoy asset URL elsewhere on the page can't outrank the real document.
 */
export function extractPdfUrlFromHtml(html: string): string | null {
  const ref = (prefix: string) =>
    // `[^"'?]` before `.pdf` keeps the extension in the path, not a query value.
    new RegExp(`["'](${prefix}[^"'?]*?\\.pdf(?:[?#][^"']*)?)["']`, "i");
  const patterns = [
    ref("\\/storage\\/"), // sci-hub canonical storage path (preferred)
    ref("https?:\\/\\/"), // absolute
    ref("\\/\\/"), // protocol-relative
    ref("\\/"), // any other root-relative .pdf
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  return null;
}

/**
 * Locate the PDF URL on a Sci-Hub viewer page, tolerating the different layouts
 * the site has shipped over time. Returns null if nothing PDF-like is found.
 *
 * Strategy order (newest-but-cheapest first):
 *   1. Legacy `<embed id="pdf" src="...">`.
 *   2. Current viewer: `<object data>` / `<embed src>` inside `div.pdf`.
 *   3. Fallback: scrape the serialized markup (inline JS) via regex.
 */
export function extractPdfUrl(
  doc: HtmlDocLike | null | undefined,
): string | null {
  if (!doc) return null;

  const legacySrc = doc.querySelector("#pdf")?.getAttribute("src");
  if (legacySrc) return legacySrc;

  const viewer = doc.querySelector(
    'embed[type="application/pdf"], div.pdf object, div.pdf embed, object[type="application/pdf"], embed[src*=".pdf"], object[data*=".pdf"]',
  );
  const viewerSrc = viewer?.getAttribute("src") || viewer?.getAttribute("data");
  if (viewerSrc) return viewerSrc;

  return extractPdfUrlFromHtml(doc.documentElement?.outerHTML || "");
}

/**
 * Normalize a raw PDF URL for download:
 *   - drop any viewer fragment (e.g. `#navpanes=0&view=FitH`),
 *   - resolve relative / protocol-relative URLs against the page,
 *   - force https.
 *
 * @param raw      The URL as found on the page.
 * @param pageUrl  The absolute URL of the viewer page it was found on.
 */
export function resolvePdfUrl(raw: string, pageUrl: string): string {
  let pdfUrl = raw.split("#")[0];

  // Resolve against the page origin unless it already has a scheme or is
  // protocol-relative. Test for an actual scheme (`https://`) rather than a
  // `"http"` prefix, so a relative path like `httpfile.pdf` still resolves.
  if (!/^https?:\/\//i.test(pdfUrl) && !pdfUrl.startsWith("//")) {
    const origin = new URL(pageUrl).origin;
    pdfUrl = new URL(pdfUrl, origin).href;
  }

  if (pdfUrl.startsWith("//")) {
    pdfUrl = "https:" + pdfUrl;
  } else if (/^http:\/\//i.test(pdfUrl)) {
    // Case-insensitive so an uppercase `HTTP://` is also upgraded.
    pdfUrl = pdfUrl.replace(/^http:\/\//i, "https://");
  }

  return pdfUrl;
}

/** Error/empty-page markers that mean Sci-Hub has no PDF for this DOI. */
const PDF_NOT_AVAILABLE_PATTERNS = [
  /Please try to search again using DOI/im,
  /статья не найдена в базе/im,
  /article not found/i,
  /sci-hub has no access to this paper/i,
  /no paper with this doi/i,
  /not found in database/i,
];

/**
 * Decide whether a Sci-Hub page indicates the PDF is unavailable. Accepts the
 * page body's innerHTML (or null/empty for a blank response).
 */
export function isPdfNotAvailable(html: string | null | undefined): boolean {
  if (!html || html.trim() === "") return true;
  return PDF_NOT_AVAILABLE_PATTERNS.some((p) => p.test(html));
}

/**
 * Build the user-facing failure message for a download error.
 *
 * A 403 from Sci-Hub means the file is gated behind a captcha/login that an
 * automated request can't satisfy, so it gets a specific hint pointing the user
 * to the browser. Everything else reports the raw reason (HTTP status or
 * message) so failures aren't misattributed.
 */
export function downloadFailureMessage(
  title: string,
  err: { status?: number; message?: string } | null | undefined,
): string {
  if (err?.status === 403) {
    return `"${title}" is behind a captcha or login on SciDB (HTTP 403). Opening in browser so you can fetch it manually...`;
  }
  const detail =
    err?.status !== undefined
      ? `HTTP ${err.status}`
      : err?.message || "unknown error";
  return `Could not auto-download "${title}" (${detail}). Opening in browser...`;
}

/**
 * A genuine PDF payload begins with the `%PDF` magic bytes. Used to reject
 * HTML/captcha pages that Sci-Hub sometimes serves at a `/storage/` URL, so we
 * never attach them to an item as a `.pdf`.
 */
export function looksLikePdf(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 // F
  );
}
