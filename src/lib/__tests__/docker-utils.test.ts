import { describe, expect, it } from "vitest";
import { DOCKER_SANDBOX_IMAGE } from "@/lib/constants";
import { formatDockerCommandError } from "@/lib/sandbox/docker-utils";

describe("docker-utils", () => {
  it("includes a build hint when the sandbox image is missing", () => {
    const message = formatDockerCommandError("Create Docker sandbox container", {
      stdout: "",
      stderr: `Unable to find image '${DOCKER_SANDBOX_IMAGE}:latest' locally`,
      exitCode: 125,
    });

    expect(message).toContain("Create Docker sandbox container failed");
    expect(message).toContain(`docker build -t ${DOCKER_SANDBOX_IMAGE} ./docker/sandbox`);
  });

  it("uses stderr details for general Docker command failures", () => {
    const message = formatDockerCommandError("Write CSV to Docker sandbox", {
      stdout: "",
      stderr: "Error response from daemon: No such container: hermetic-warm",
      exitCode: 1,
    });

    expect(message).toBe(
      "Write CSV to Docker sandbox failed: Error response from daemon: No such container: hermetic-warm"
    );
  });
});
