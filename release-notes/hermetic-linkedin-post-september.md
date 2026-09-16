# Short LinkedIn post, September 2026

_Post with a link to the full article. Suggested image: the Settings drawer showing the live version + "Check for updates", or the release page with all three platforms._

---

Hermetic's September update is out. Hermetic is an open-source, local-first AI data analyst: the model writes the analysis code, but it never sees your data.

One sentence version: it's an app now.

Three themes this month.

You can just download it. Desktop apps for macOS, Windows, and Linux, with signature-verified auto-update — plus a one-file extension that installs into Claude Desktop and turns Claude into a client of your local Hermetic. Fifteen stable releases in fifteen days, every artifact build-provenance attested. macOS builds are notarized; the README is honest about Windows not being code-signed yet.

Point it at a catalog. Hand Hermetic a dataset manifest or a STAC catalog URL — like Overture Maps' planetary dataset — and it becomes one source with many tables. A small model call picks the relevant ones per question, joins work across them, and on the built-in engine nothing is downloaded whole.

My dev machine was lying to me. The first real installs failed in ways my machine couldn't reproduce: runtime assets that only existed locally because old test runs had cached them, a version label that had been wrong for six releases, and no log file to debug any of it with. Every fix shipped with an assert that makes the gap impossible to re-ship. Your first ten users are an audit — build so their findings become permanent.

The full write-up also covers the update-signing key I had to rotate after my own backup failed its first real test, and why the release runbook now demands proof you can restore a key before anything depends on it.

Full article: [link]
Open source: github.com/achalp/hermetic

#opensource #dataanalytics #ai #privacy
