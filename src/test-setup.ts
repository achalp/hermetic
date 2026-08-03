import "@testing-library/jest-dom/vitest";

import { installEnvConfig } from "./harness/env-config";

// Tests mutate process.env per-test; give lib a LIVE view instead of a
// boot-frozen snapshot (modularization M2-B1).
installEnvConfig("live");
