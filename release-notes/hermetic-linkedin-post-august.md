I took two weeks off, and it was honestly wonderful.

Slow mornings. A lot of time with family. An amount of food I am not going to defend here, and would happily eat again tomorrow.

And then, somewhere around day three, I did the thing I always do on a break. I opened a laptop and started building. This is what relaxes me. My family has long since stopped being surprised by it, and now just asks what I am making before they ask what I want for dinner.

I will spare you the gazillion projects I started over those two weeks. Most of them lasted an afternoon. A couple made it to the second day. One of them I am still slightly embarrassed about.

But one project did get real attention, and that is the one I want to talk about.

It is called Hermetic. It is my open-source side project, and I am trying to build an AI data analyst you can actually trust with your own data. The idea is simple enough to say in a sentence. You ask a question in plain English, it writes the analysis code, that code runs on your own machine against your own data, and you get a dashboard back. The model writes the code but never sees your rows.

Here is what moved over the break.

**Verifiability.** This is the big one. Every number in the report now traces back to a specific line of code. Most AI tools compute a number, hand it to a language model, and let the model write the paragraph around it. That last step is where wrong numbers come from, and no amount of clever prompting fixes it. So I took the step out. The model decides what to say. Code computes the figures, formats the units, and attaches the data checks.

**Trust.** The report is now allowed to refuse. If a data quality check fails, it says so on the page and marks the finding unvalidated instead of quietly moving on. If nobody computed a trend, it says no direction can be stated and points you at the chart shape. I would much rather have a tool that admits what it does not know than one that sounds confident and sends me into a meeting with a wrong number.

**Claude and MCP.** Hermetic now works as a tool that Claude can call. You can ask your question inside Claude Desktop, get a real dashboard back, and your data never leaves your machine. There is no developer account or API key to set up, which was the step where most people gave up before.

**Skills.** You can teach it how your business actually counts things. When your fiscal year starts. What an active customer means to you. Which of your own Python functions it should use instead of inventing its own method. Drop a folder in and it applies from the very next question. This one came out of a conversation with graduate students at the University of Chicago, and it was a much better idea than anything I had planned.

**Scale and reliability.** It answered a question across 2.5 billion rows sitting in cloud storage without downloading any of it, or setting up a database first. Plus a pile of quieter, less glamorous work so that long analyses stop falling over halfway through.

I wrote up the whole thing, including a decent list of what I got wrong along the way. There is more of that than I would like.

Write-up: [link]
Code, free and open: github.com/achalp/hermetic

Happy to hear from anyone poking at the same problem.

#opensource #dataanalytics #ai
