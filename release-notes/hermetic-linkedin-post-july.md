# Short LinkedIn post, July 2026

_Post with a link to the full article. Suggested image: the loneliest-building map._

---

Hermetic's July update is out. Hermetic is an open-source, local-first AI data analyst: the model writes the analysis code, but it never sees your data.

Three themes this month.

You can query data on S3 without becoming a data engineer. So much data just sits in object storage (open datasets like Overture Maps, your company's exports and event dumps), waiting on a warehouse and a pipeline nobody has time to build. Hermetic now takes the S3 or HTTPS link directly and analyzes the data where it sits. Pointed at Overture's 2.5 billion buildings, it answered "which building on Earth is farthest from any other?" in minutes: an exact answer, on a map.

It learns your business. Your definitions (a fiscal year that starts in February, "active" meaning the last 90 days, a renewal that doesn't count as a new deal) go into a small file, once. Every subsequent analysis follows them, and a reviewer checks the generated code against your rules before it runs. Corrections hold permanently instead of living in one analyst's head.

Hard questions get the time they deserve. The 20-minute limit is gone, replaced by live progress, honest estimates, and a stop button that stops the actual work. Sleeping laptops and closed tabs no longer cost you a result.

And one change with wider reach than it sounds: you no longer need an API key. If you already use Claude through its command-line tool, that login is the entire setup. A colleague suggested this one; I hadn't thought of it, they had.

The full write-up covers what went wrong along the way, too, including the "memory failure" that turned out to be my own cleanup process terminating live runs on a schedule.

Full article: [link]
Open source: github.com/achalp/hermetic

#opensource #dataanalytics #ai #privacy
