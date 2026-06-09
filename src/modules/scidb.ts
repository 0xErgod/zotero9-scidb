import {
  downloadFailureMessage,
  extractPdfUrl,
  isPdfNotAvailable,
  looksLikePdf,
  resolvePdfUrl,
} from "./scidbParser";

class PdfNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfNotFoundError";
  }
}

export class SciDBManager {
  private static _instance: SciDBManager;
  private _defaultEndpoint = "https://sci-hub.ru/";

  private constructor() {
    // Private constructor to force singleton
  }

  public static getInstance(): SciDBManager {
    if (!SciDBManager._instance) {
      SciDBManager._instance = new SciDBManager();
    }
    return SciDBManager._instance;
  }

  public registerRightClickMenuItem(win: Window) {
    const menuIcon = `chrome://${addon.data.config.addonRef}/content/icons/favicon@0.5x.png`;
    // The `Menu` helper was removed in zotero-plugin-toolkit v5. Inject the
    // menuitem directly into the item context menu instead; this works across
    // Zotero 7, 8, and 9. The element is recorded by the UI tool and removed
    // automatically on `ztoolkit.unregisterAll()` (window unload / shutdown).
    const itemMenu = win.document.getElementById("zotero-itemmenu");
    if (!itemMenu) {
      return;
    }
    ztoolkit.UI.appendElement(
      {
        tag: "menuitem",
        id: "zotero-itemmenu-scidb-download",
        namespace: "xul",
        attributes: {
          label: "Download from SciDB",
          class: "menuitem-iconic",
          image: menuIcon,
        },
        listeners: [
          {
            type: "command",
            listener: () => this.downloadSelectedItems(),
          },
        ],
      },
      itemMenu,
    );
  }

  private async downloadSelectedItems() {
    const items = Zotero.getActiveZoteroPane().getSelectedItems();
    if (!items.length) {
      this.showProgressWindow("No items selected", "fail");
      return;
    }

    const progressWin = new ztoolkit.ProgressWindow("SciDB Download")
      .createLine({
        text: `Processing ${items.length} items...`,
        type: "default",
      })
      .show();

    // Process items sequentially to avoid rate limiting
    for (const item of items) {
      try {
        const doi = item.getField("DOI") as string;
        if (!doi) {
          progressWin.changeLine({
            text: `No DOI found for "${item.getField("title")}"`,
            type: "fail",
          });
          continue;
        }

        // Get endpoint from preferences
        const endpoint =
          (Zotero.Prefs.get(this._prefKey) as string) || this._defaultEndpoint;
        const initialUrl = new URL(doi, endpoint).href;

        await this.updateItem(initialUrl, item, progressWin);
      } catch (error: any) {
        if (error instanceof PdfNotFoundError) {
          progressWin.changeLine({
            text: `PDF not available for "${item.getField("title")}". Try again later.`,
            type: "fail",
          });
        } else {
          // Some other error was thrown during the scrape. Surface the real
          // reason (HTTP status, network error, attachment failure, ...) so
          // failures aren't silently misattributed. A 403 specifically means a
          // captcha/login gate (see `downloadFailureMessage`).
          const detail =
            error?.status !== undefined
              ? `HTTP ${error.status}`
              : error?.message || String(error);
          Zotero.debug(
            `[SciDB] download failed for "${item.getField("title")}": ${detail}`,
          );
          Zotero.debug(error);
          progressWin.changeLine({
            text: downloadFailureMessage(
              item.getField("title") as string,
              error,
            ),
            type: "fail",
          });
          const currentDoi = item.getField("DOI") as string;
          const currentEndpoint =
            (Zotero.Prefs.get(this._prefKey) as string) ||
            this._defaultEndpoint;
          Zotero.launchURL(new URL(currentDoi, currentEndpoint).href);
          break; // Stop processing remaining items
        }
      }
    }
  }

  private async updateItem(
    url: string,
    item: Zotero.Item,
    progressWin: any,
    depth = 0,
  ): Promise<void> {
    // Guard the iframe/redirect recursion below against a page that embeds an
    // iframe pointing back at itself (or a chain of them).
    if (depth > 3) {
      throw new PdfNotFoundError(`Too many redirects resolving ${url}`);
    }

    progressWin.changeLine({
      text: `Fetching PDF for "${item.getField("title")}"...`,
      type: "default",
    });

    // First request to get the HTML page
    const xhr = await Zotero.HTTP.request("GET", url, {
      responseType: "document",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 11_3_1 like Mac OS X) AppleWebKit/603.1.30 (KHTML, like Gecko) Version/10.0 Mobile/14E304 Safari/602.1",
      },
    });

    if (xhr.status !== 200) {
      throw new Error(`Failed to fetch page: ${xhr.status}`);
    }

    // Check if we're on annas-archive and need to extract the sci-hub URL
    const iframe = xhr.responseXML?.querySelector("iframe");
    if (iframe) {
      const iframeSrc = iframe.getAttribute("src");
      if (iframeSrc) {
        Zotero.debug(`Found iframe source: ${iframeSrc}`);
        // Make a new request to the sci-hub URL
        return this.updateItem(iframeSrc, item, progressWin, depth + 1);
      }
    }

    // Find the PDF URL in the response (see `extractPdfUrl` for the layout
    // strategies it tries), then normalize it for download.
    const rawPdfUrl = extractPdfUrl(xhr.responseXML);
    Zotero.debug(`[SciDB] extracted pdfUrl: ${rawPdfUrl ?? "(none)"}`);
    const pdfUrl = rawPdfUrl ? resolvePdfUrl(rawPdfUrl, url) : null;

    const bodyHtml = xhr.responseXML?.querySelector("body")?.innerHTML;
    Zotero.debug(
      `[SciDB] resolved pdfUrl: ${pdfUrl ?? "(none)"}; body length: ${bodyHtml?.length ?? 0}`,
    );

    // Check for empty response or error messages
    if (!pdfUrl || isPdfNotAvailable(bodyHtml)) {
      // Try to find alternative download links
      const links = Array.from(
        xhr.responseXML?.querySelectorAll("a") || [],
      ) as Element[];
      const downloadLinks = links
        .filter((link) => {
          const href = link.getAttribute("href");
          if (!href) return false;

          // Look for PDF-related links or known paper repositories
          return (
            href.endsWith(".pdf") ||
            href.includes("/pdf/") ||
            href.includes("gateway") ||
            href.includes("sci-hub") ||
            href.includes("doi.org") ||
            href.includes("ipfs")
          );
        })
        .map((link) => link.getAttribute("href"))
        .filter(Boolean) as string[];

      if (downloadLinks.length > 0) {
        // Open the first alternative link in browser
        Zotero.launchURL(downloadLinks[0]);
        throw new Error("Opening alternative download link...");
      }

      throw new PdfNotFoundError(`PDF not available at ${url}`);
    }

    // Download and attach the PDF. Pass the viewer page as Referer; Sci-Hub
    // sometimes refuses a cold, direct request to the /storage/ path.
    Zotero.debug(`[SciDB] downloading PDF from: ${pdfUrl} (referer: ${url})`);
    await this.attachPdfToItem(pdfUrl, item, url);

    progressWin.changeLine({
      text: `Downloaded PDF for "${item.getField("title")}"`,
      type: "success",
    });
  }

  private async attachPdfToItem(
    pdfUrl: string,
    item: Zotero.Item,
    referer?: string,
  ): Promise<void> {
    const tmpDir = await Zotero.getTempDirectory();
    const tmpFileName = `scidb_${Date.now()}.pdf`;
    // Use PathUtils.join so the separator is correct on every OS. Hand-joining
    // with "/" produced an invalid mixed-separator path on Windows
    // (e.g. "C:\...\Temp\Zotero/scidb_x.pdf") that IOUtils rejects.
    const tmpFile = PathUtils.join(tmpDir.path, tmpFileName);

    // Download PDF
    const headers: Record<string, string> = {
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 11_3_1 like Mac OS X) AppleWebKit/603.1.30 (KHTML, like Gecko) Version/10.0 Mobile/14E304 Safari/602.1",
    };
    if (referer) {
      headers["Referer"] = referer;
    }
    const response = await Zotero.HTTP.request("GET", pdfUrl, {
      responseType: "arraybuffer",
      headers,
    });

    if (response.status !== 200) {
      throw new Error(`Failed to download PDF: ${response.status}`);
    }

    const buffer = new Uint8Array(response.response);
    Zotero.debug(`[SciDB] downloaded ${buffer.byteLength} bytes`);

    // Sanity-check the payload is actually a PDF. If Sci-Hub served an HTML
    // error/captcha page at the storage URL instead, we must not save it as a
    // .pdf. See `looksLikePdf` (checks the "%PDF" magic bytes).
    if (!looksLikePdf(buffer)) {
      const header = String.fromCharCode(...buffer.slice(0, 5)).replace(
        /[^\x20-\x7e]/g,
        ".",
      );
      throw new Error(
        `Downloaded file is not a PDF (starts with "${header}", ${buffer.byteLength} bytes)`,
      );
    }

    // Save PDF to temp file
    await IOUtils.write(tmpFile, buffer);

    // Attach PDF to item
    const attachment = await Zotero.Attachments.importFromFile({
      file: tmpFile,
      parentItemID: item.id,
      contentType: "application/pdf",
      title: item.getField("title") + ".pdf",
    });
    Zotero.debug(`[SciDB] attached PDF as item ${attachment?.id}`);

    // Clean up the temp file.
    try {
      await IOUtils.remove(tmpFile);
    } catch (e) {
      Zotero.debug(`[SciDB] could not remove temp file: ${e}`);
    }
  }

  private showProgressWindow(
    message: string,
    type: "success" | "fail" | "default" = "default",
  ) {
    new ztoolkit.ProgressWindow(addon.data.config.addonName)
      .createLine({
        text: message,
        type: type,
      })
      .show();
  }

  private _prefKey = `extensions.zotero.${addon.data.config.addonRef}.endpoint`;

  public registerPrefs() {
    // Initialize the endpoint preference
    if (!Zotero.Prefs.get(this._prefKey)) {
      Zotero.Prefs.set(this._prefKey, this._defaultEndpoint);
    }
  }
}
