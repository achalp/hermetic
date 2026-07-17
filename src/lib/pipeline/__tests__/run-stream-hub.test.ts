import { describe, it, expect, beforeEach } from "vitest";
import {
  openRunChannel,
  publishRunLine,
  closeRunChannel,
  subscribeRunChannel,
  setRunChannelMeta,
  hasRunChannel,
  findActiveRunForCsv,
  listActiveRuns,
  reapStaleRunChannels,
  __resetRunStreamHubForTests,
} from "@/lib/pipeline/run-stream-hub";

beforeEach(() => __resetRunStreamHubForTests());

/** Collect a subscriber's deliveries; `ended` flips on the null sentinel. */
function collector() {
  const lines: string[] = [];
  let ended = false;
  const cb = (line: string | null) => {
    if (line === null) ended = true;
    else lines.push(line);
  };
  return {
    cb,
    lines,
    get ended() {
      return ended;
    },
  };
}

describe("run-stream-hub", () => {
  it("openRunChannel returns the shared buffer used as emittedLines", () => {
    const buf = openRunChannel("r1", { route: "/api/query" });
    publishRunLine("r1", "a");
    publishRunLine("r1", "b");
    expect(buf).toEqual(["a", "b"]); // patch-stream reads this as emittedLines
  });

  it("replays the buffer to a late subscriber, then streams live lines", () => {
    openRunChannel("r1", { route: "/api/query" });
    publishRunLine("r1", "one");
    publishRunLine("r1", "two");

    const c = collector();
    const unsub = subscribeRunChannel("r1", c.cb);
    expect(unsub).toBeTypeOf("function");
    expect(c.lines).toEqual(["one", "two"]); // replay so far

    publishRunLine("r1", "three"); // live
    expect(c.lines).toEqual(["one", "two", "three"]);
    expect(c.ended).toBe(false);
  });

  it("delivers each line exactly once with no gap across the subscribe boundary", () => {
    openRunChannel("r1", { route: "/api/query" });
    publishRunLine("r1", "1");
    const c = collector();
    subscribeRunChannel("r1", c.cb);
    publishRunLine("r1", "2");
    publishRunLine("r1", "3");
    expect(c.lines).toEqual(["1", "2", "3"]); // no dup of "1", no missing "2"
  });

  it("fans out to multiple concurrent subscribers", () => {
    openRunChannel("r1", { route: "/api/query" });
    const a = collector();
    const b = collector();
    subscribeRunChannel("r1", a.cb);
    publishRunLine("r1", "x");
    subscribeRunChannel("r1", b.cb); // b joins later — replays "x"
    publishRunLine("r1", "y");
    expect(a.lines).toEqual(["x", "y"]);
    expect(b.lines).toEqual(["x", "y"]);
  });

  it("close signals the end sentinel to all subscribers and stops delivery", () => {
    openRunChannel("r1", { route: "/api/query" });
    const c = collector();
    subscribeRunChannel("r1", c.cb);
    publishRunLine("r1", "a");
    closeRunChannel("r1");
    expect(c.ended).toBe(true);
    publishRunLine("r1", "after"); // ignored — closed
    expect(c.lines).toEqual(["a"]);
  });

  it("a subscriber that joins AFTER close still gets the full buffer then ends", () => {
    openRunChannel("r1", { route: "/api/query" });
    publishRunLine("r1", "done-result");
    closeRunChannel("r1");
    const c = collector();
    const unsub = subscribeRunChannel("r1", c.cb); // channel retained in grace window
    expect(c.lines).toEqual(["done-result"]);
    expect(c.ended).toBe(true);
    expect(unsub).toBeTypeOf("function");
  });

  it("subscribing to an unknown run returns null (caller → 404/history)", () => {
    expect(subscribeRunChannel("nope", () => {})).toBeNull();
  });

  it("unsubscribe stops further delivery", () => {
    openRunChannel("r1", { route: "/api/query" });
    const c = collector();
    const unsub = subscribeRunChannel("r1", c.cb)!;
    publishRunLine("r1", "a");
    unsub();
    publishRunLine("r1", "b");
    expect(c.lines).toEqual(["a"]);
  });

  it("a throwing subscriber cannot break the run or other subscribers", () => {
    openRunChannel("r1", { route: "/api/query" });
    const good = collector();
    subscribeRunChannel("r1", () => {
      throw new Error("boom");
    });
    subscribeRunChannel("r1", good.cb);
    expect(() => publishRunLine("r1", "a")).not.toThrow();
    expect(good.lines).toEqual(["a"]);
  });

  it("discovers the most-recent active run for a source, ignoring closed ones", () => {
    openRunChannel("old", { route: "/api/query" });
    setRunChannelMeta("old", { csvId: "csv-1", question: "q old" });
    openRunChannel("new", { route: "/api/query" });
    setRunChannelMeta("new", { csvId: "csv-1", question: "q new" });

    const found = findActiveRunForCsv("csv-1");
    expect(found?.runId).toBe("new");
    expect(found?.question).toBe("q new");

    closeRunChannel("new");
    expect(findActiveRunForCsv("csv-1")?.runId).toBe("old"); // falls back to the other live one
    closeRunChannel("old");
    expect(findActiveRunForCsv("csv-1")).toBeNull();
  });

  it("listActiveRuns returns only open channels, most-recent first", () => {
    openRunChannel("a", { route: "/api/query" });
    openRunChannel("b", { route: "/api/query/investigate" });
    closeRunChannel("a");
    const active = listActiveRuns();
    expect(active.map((r) => r.runId)).toEqual(["b"]);
  });

  it("reaps closed channels only after the grace window", () => {
    openRunChannel("r1", { route: "/api/query" });
    closeRunChannel("r1");
    expect(hasRunChannel("r1")).toBe(true);
    expect(reapStaleRunChannels(Date.now() + 60_000)).toBe(0); // within grace
    expect(hasRunChannel("r1")).toBe(true);
    expect(reapStaleRunChannels(Date.now() + 5 * 60_000)).toBe(1); // past grace
    expect(hasRunChannel("r1")).toBe(false);
  });
});
