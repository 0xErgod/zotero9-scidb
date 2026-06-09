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
 * reliable fallback. Ordered most-specific first.
 */
export function extractPdfUrlFromHtml(html: string): string | null {
  const patterns = [
    /["'](https?:\/\/[^"']+?\.pdf[^"']*)["']/i, // absolute
    /["'](\/\/[^"']+?\.pdf[^"']*)["']/i, // protocol-relative
    /["'](\/storage\/[^"']+?\.pdf[^"']*)["']/i, // sci-hub storage path
    /["'](\/[^"']+?\.pdf[^"']*)["']/i, // any root-relative .pdf
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

  if (!pdfUrl.startsWith("http") && !pdfUrl.startsWith("//")) {
    const origin = new URL(pageUrl).origin;
    pdfUrl = new URL(pdfUrl, origin).href;
  }

  if (pdfUrl.startsWith("//")) {
    pdfUrl = "https:" + pdfUrl;
  } else if (pdfUrl.startsWith("http:")) {
    pdfUrl = pdfUrl.replace(/^http:/, "https:");
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
