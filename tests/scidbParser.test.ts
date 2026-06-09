import { describe, it, expect } from "vitest";
import {
  downloadFailureMessage,
  extractPdfUrl,
  extractPdfUrlFromHtml,
  isPdfNotAvailable,
  looksLikePdf,
  resolvePdfUrl,
  type HtmlDocLike,
  type ElementLike,
} from "../src/modules/scidbParser";

/**
 * Build a minimal fake Document. `query` decides what each selector resolves
 * to; `outerHTML` backs the regex fallback.
 */
function makeDoc(opts: {
  query?: (sel: string) => ElementLike | null;
  outerHTML?: string;
}): HtmlDocLike {
  return {
    querySelector: (sel) => (opts.query ? opts.query(sel) : null),
    documentElement:
      opts.outerHTML !== undefined ? { outerHTML: opts.outerHTML } : null,
  };
}

const el = (attrs: Record<string, string>): ElementLike => ({
  getAttribute: (n) => attrs[n] ?? null,
});

// A representative slice of the current sci-hub.ru viewer page: the canonical
// PDF path only appears inside inline JavaScript.
const SCIHUB_INLINE_JS = `
  <script>
    async function live(buffer) {
      await fetch('/live', {
        method: 'POST',
        body: JSON.stringify({ url: '/storage/zero/3625/daca/schmidt2012.pdf', doi: '10.1109/CSF.2012.25' })
      })
    }
  </script>`;

describe("extractPdfUrlFromHtml", () => {
  it("scrapes the /storage/ path out of inline JS", () => {
    expect(extractPdfUrlFromHtml(SCIHUB_INLINE_JS)).toBe(
      "/storage/zero/3625/daca/schmidt2012.pdf",
    );
  });

  it("prefers the /storage/ path over a decoy asset URL", () => {
    const html = `<style>.x{background:url('https://cdn.tld/sprite.pdf.svg')}</style><script>var u='/storage/real/paper.pdf'</script>`;
    expect(extractPdfUrlFromHtml(html)).toBe("/storage/real/paper.pdf");
  });

  it("does not match a .pdf that is not a path extension", () => {
    // CSS/SVG asset — `.pdf` is followed by `.svg`, not a boundary.
    expect(
      extractPdfUrlFromHtml(`<img src="https://cdn.tld/sprite.pdf.svg">`),
    ).toBeNull();
  });

  it("does not match a .pdf inside a query string", () => {
    expect(
      extractPdfUrlFromHtml(
        `<script src="https://sci-hub.ru/misc/libgen.js?v=2.pdf"></script>`,
      ),
    ).toBeNull();
  });

  it("preserves a query string on a real pdf url", () => {
    expect(extractPdfUrlFromHtml(`x = '/storage/x/p.pdf?download=1'`)).toBe(
      "/storage/x/p.pdf?download=1",
    );
  });

  it("falls back to an absolute pdf when there is no storage path", () => {
    const html = `<script>var u="https://host.tld/abs.pdf"</script>`;
    expect(extractPdfUrlFromHtml(html)).toBe("https://host.tld/abs.pdf");
  });

  it("matches protocol-relative URLs", () => {
    expect(extractPdfUrlFromHtml(`src="//cdn.tld/x.pdf"`)).toBe(
      "//cdn.tld/x.pdf",
    );
  });

  it("returns null when there is no pdf reference", () => {
    expect(extractPdfUrlFromHtml(`<p>no document here</p>`)).toBeNull();
  });
});

describe("extractPdfUrl", () => {
  it("returns null for a null/undefined document", () => {
    expect(extractPdfUrl(null)).toBeNull();
    expect(extractPdfUrl(undefined)).toBeNull();
  });

  it("uses the legacy #pdf embed first", () => {
    const doc = makeDoc({
      query: (sel) => (sel === "#pdf" ? el({ src: "/legacy.pdf" }) : null),
    });
    expect(extractPdfUrl(doc)).toBe("/legacy.pdf");
  });

  it("reads the current viewer object's data attribute", () => {
    const doc = makeDoc({
      query: (sel) =>
        sel === "#pdf" ? null : el({ data: "/storage/x/paper.pdf#navpanes=0" }),
    });
    expect(extractPdfUrl(doc)).toBe("/storage/x/paper.pdf#navpanes=0");
  });

  it("falls back to scraping serialized markup", () => {
    const doc = makeDoc({ query: () => null, outerHTML: SCIHUB_INLINE_JS });
    expect(extractPdfUrl(doc)).toBe("/storage/zero/3625/daca/schmidt2012.pdf");
  });
});

describe("resolvePdfUrl", () => {
  const page = "https://sci-hub.ru/10.1109/CSF.2012.25";

  it("strips the viewer fragment and resolves a relative path", () => {
    expect(
      resolvePdfUrl("/storage/x/paper.pdf#navpanes=0&view=FitH", page),
    ).toBe("https://sci-hub.ru/storage/x/paper.pdf");
  });

  it("upgrades protocol-relative URLs to https", () => {
    expect(resolvePdfUrl("//cdn.tld/x.pdf", page)).toBe(
      "https://cdn.tld/x.pdf",
    );
  });

  it("upgrades http to https", () => {
    expect(resolvePdfUrl("http://host.tld/x.pdf", page)).toBe(
      "https://host.tld/x.pdf",
    );
  });

  it("upgrades an uppercase HTTP scheme to https", () => {
    expect(resolvePdfUrl("HTTP://host.tld/x.pdf", page)).toBe(
      "https://host.tld/x.pdf",
    );
  });

  it("leaves an absolute https URL intact (minus fragment)", () => {
    expect(resolvePdfUrl("https://host.tld/x.pdf#a", page)).toBe(
      "https://host.tld/x.pdf",
    );
  });

  it("keeps a query string while resolving a relative path", () => {
    expect(resolvePdfUrl("/storage/x/p.pdf?download=1", page)).toBe(
      "https://sci-hub.ru/storage/x/p.pdf?download=1",
    );
  });

  it("resolves a relative path that merely starts with 'http'", () => {
    // Not a scheme — must still be treated as relative.
    expect(resolvePdfUrl("httpfile.pdf", page)).toBe(
      "https://sci-hub.ru/httpfile.pdf",
    );
  });
});

describe("isPdfNotAvailable", () => {
  it("treats null/empty/whitespace as unavailable", () => {
    expect(isPdfNotAvailable(null)).toBe(true);
    expect(isPdfNotAvailable("")).toBe(true);
    expect(isPdfNotAvailable("   \n ")).toBe(true);
  });

  it("detects known error markers", () => {
    expect(isPdfNotAvailable("<p>article not found</p>")).toBe(true);
    expect(isPdfNotAvailable("Sci-Hub has no access to this paper")).toBe(true);
  });

  it("returns false for a real article page", () => {
    expect(isPdfNotAvailable("<div class='pdf'><object></object></div>")).toBe(
      false,
    );
  });
});

describe("downloadFailureMessage", () => {
  it("gives a captcha-specific message for HTTP 403", () => {
    const msg = downloadFailureMessage("My Paper", { status: 403 });
    expect(msg).toContain("My Paper");
    expect(msg).toContain("captcha");
    expect(msg).toContain("403");
  });

  it("reports the HTTP status for other status codes", () => {
    expect(downloadFailureMessage("P", { status: 500 })).toContain("HTTP 500");
  });

  it("falls back to the error message when there is no status", () => {
    expect(downloadFailureMessage("P", { message: "network down" })).toContain(
      "network down",
    );
  });

  it("handles a null/undefined error", () => {
    expect(downloadFailureMessage("P", null)).toContain("unknown error");
  });
});

describe("looksLikePdf", () => {
  it("accepts a %PDF header", () => {
    expect(looksLikePdf(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe(
      true,
    );
  });

  it("rejects an HTML payload", () => {
    // "<!DOC"
    expect(looksLikePdf(new Uint8Array([0x3c, 0x21, 0x44, 0x4f, 0x43]))).toBe(
      false,
    );
  });

  it("rejects a too-short buffer", () => {
    expect(looksLikePdf(new Uint8Array([0x25, 0x50]))).toBe(false);
  });
});
