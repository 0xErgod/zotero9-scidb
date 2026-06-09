/**
 * In-Zotero integration tests, executed by `zotero-plugin test` (the
 * zotero-plugin-scaffold runner) inside a live, headless Zotero instance.
 *
 * The runner provides mocha's BDD globals (`describe`/`it`) and chai's `expect`
 * (injected as `window.expect`). `Zotero` is the real client. We reach the
 * plugin through its addon instance and exercise the *real bundled* parser
 * against a *real* DOM — coverage the Node unit tests can't provide.
 */

declare const expect: Chai.ExpectStatic;

describe("Zotero SciDB plugin", () => {
  const plugin = (Zotero as any).ZoteroSciDB;

  it("is loaded and exposes its parser API", () => {
    expect(plugin).to.be.an("object");
    expect(plugin.data.alive).to.equal(true);
    expect(plugin.api.parser).to.be.an("object");
  });

  it("registers a default endpoint preference", () => {
    const endpoint = Zotero.Prefs.get("extensions.zotero.zoteroscidb.endpoint");
    expect(endpoint).to.be.a("string");
    expect(endpoint as string).to.match(/^https?:\/\//);
  });

  it("injects the download item into the item context menu", () => {
    const doc = Zotero.getMainWindow().document;
    const menuitem = doc.getElementById("zotero-itemmenu-scidb-download");
    expect(menuitem, "menu item should be injected").to.not.equal(null);
    expect(menuitem!.getAttribute("label")).to.contain("SciDB");
  });

  describe("PDF extraction against a real DOM", () => {
    const parse = (html: string): Document =>
      new DOMParser().parseFromString(html, "text/html");

    it("scrapes a /storage/ path from inline JS", () => {
      const doc = parse(
        `<html><body><script>var x = { url: '/storage/2024/x/paper.pdf', doi: '10.x' }</script></body></html>`,
      );
      expect(plugin.api.parser.extractPdfUrl(doc)).to.equal(
        "/storage/2024/x/paper.pdf",
      );
    });

    it("reads a div.pdf object[data] and normalizes it", () => {
      const doc = parse(
        `<html><body><div class="pdf"><object data="/storage/y/z.pdf#navpanes=0"></object></div></body></html>`,
      );
      const raw = plugin.api.parser.extractPdfUrl(doc);
      expect(raw).to.equal("/storage/y/z.pdf#navpanes=0");
      expect(
        plugin.api.parser.resolvePdfUrl(raw, "https://sci-hub.ru/10.x"),
      ).to.equal("https://sci-hub.ru/storage/y/z.pdf");
    });

    it("validates PDF magic bytes", () => {
      expect(
        plugin.api.parser.looksLikePdf(
          new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        ),
      ).to.equal(true);
      expect(
        plugin.api.parser.looksLikePdf(
          new TextEncoder().encode("<!DOCTYPE html>"),
        ),
      ).to.equal(false);
    });
  });
});
