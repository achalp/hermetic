import "server-only";
import { spawn } from "node:child_process";
import { reportProgress, type SandboxProgress } from "@/lib/pipeline/run-control";

export interface StreamExecResult {
  exitCode: number;
  /** True when the run's signal fired (the user hit Stop). */
  aborted: boolean;
}

/**
 * Run the analysis script inside an existing container, STREAMING its stdout so
 * progress heartbeats surface live and the run can be stopped on demand.
 *
 * There is NO timeout — a connected, progressing run is never killed by us. It
 * ends only two ways: the process exits, or the run's AbortSignal fires (Stop),
 * which `docker rm -f`s the container. Removing the container kills the
 * in-container Python; killing the `docker exec` client process alone would
 * leave it running.
 *
 * The script writes its FINAL result to /data/output.json (the caller reads it);
 * stdout carries only progress — JSONL lines shaped {"__progress": {...}} from
 * the prelude's progress() helper. `python3 -u` keeps stdout unbuffered so the
 * heartbeats arrive live rather than in one lump at the end.
 */
export function streamExec(containerId: string, signal?: AbortSignal): Promise<StreamExecResult> {
  return new Promise((resolve, reject) => {
    let aborted = false;
    const child = spawn("docker", [
      "exec",
      containerId,
      "sh",
      "-c",
      "python3 -u /data/script.py 2>/data/stderr.txt",
    ]);

    let buf = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? ""; // keep the trailing partial line
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try {
          const obj = JSON.parse(t) as { __progress?: SandboxProgress };
          if (obj && obj.__progress) reportProgress(obj.__progress);
        } catch {
          // Not a progress line — ignore (the real result is in output.json).
        }
      }
    });
    // Drain stderr so the pipe never blocks (content also goes to the file).
    child.stderr?.resume();

    const onAbort = () => {
      aborted = true;
      spawn("docker", ["rm", "-f", containerId]); // kills the in-container process
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const cleanup = () => {
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    child.on("error", (err) => {
      cleanup();
      if (aborted) resolve({ exitCode: -1, aborted: true });
      else reject(err);
    });
    child.on("exit", (code) => {
      cleanup();
      resolve({ exitCode: aborted ? -1 : (code ?? 1), aborted });
    });
  });
}
