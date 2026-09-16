# Short LinkedIn post, September 2026

_Post with a link to the full article. Suggested image: the Settings drawer showing the live version + "Check for updates", or the release page with all three platforms._

---

Hermetic's September update is out. Hermetic is an open-source, local-first AI data analyst: the model writes the analysis code, but it never sees your data.

One sentence version: it's an app now.

Four things shipped.

**Catalogs.** Point Hermetic at a data catalog — Data Package, Croissant, a file list, or STAC — and the whole thing becomes one source with many tables. One URL connects the AHI housing hub. One URL connects Overture Maps' planetary STAC catalog, and Hermetic reads only the byte ranges each question needs.

**Desktop installers.** macOS, Windows, and Linux, with signature-verified auto-update. macOS builds are signed and notarized. Windows is still unsigned — I wrote up why, and it involves my patience ending somewhere deep inside the Azure portal.

**A built-in analysis runtime.** The desktop app carries Python and DuckDB compiled to WebAssembly, running in a locked sandbox. Install one app and analyze. No Docker, no setup, and the data boundary holds.

**An MCP server.** One file installs into Claude Desktop, and any MCP agent can use Hermetic as its analysis room. Your agent asks, your data stays home, and the dashboard outlives the chat.

The full article also covers what I trust an agent with (exactly), a privacy claim I had to give up because it was incoherent, and the update-signing key I rotated after my own backup failed its first restore test.

Full article: [link]
Open source: github.com/achalp/hermetic

#opensource #dataanalytics #ai #privacy
