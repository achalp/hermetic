import { readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { join, dirname } from "path";

export interface OllamaConfig {
  enabled: boolean;
  baseUrl: string;
  activeModel: string;
  pid?: number;
}

export interface MlxConfig {
  enabled: boolean;
  baseUrl: string;
  activeModel: string;
  pid?: number;
}

export interface LlamaCppConfig {
  enabled: boolean;
  baseUrl: string;
  activeModel: string;
  pid?: number;
  binaryPath?: string;
}

export interface RuntimeConfig {
  ollama?: OllamaConfig;
  mlx?: MlxConfig;
  llamaCpp?: LlamaCppConfig;
}

const CONFIG_PATH = join(process.cwd(), "data", "runtime-config.json");
const CACHE_TTL_MS = 5_000;

let cached: RuntimeConfig | null = null;
let cacheTime = 0;

function readFromDisk(): RuntimeConfig {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as RuntimeConfig;
  } catch {
    return {};
  }
}

export function getRuntimeConfig(): RuntimeConfig {
  const now = Date.now();
  if (cached && now - cacheTime < CACHE_TTL_MS) {
    return cached;
  }
  cached = readFromDisk();
  cacheTime = now;
  return cached;
}

export function setRuntimeConfig(partial: Partial<RuntimeConfig>): RuntimeConfig {
  const current = readFromDisk();
  const merged: RuntimeConfig = { ...current };

  if (partial.ollama !== undefined) {
    merged.ollama = partial.ollama === null ? undefined : { ...current.ollama, ...partial.ollama };
  }
  if (partial.mlx !== undefined) {
    merged.mlx = partial.mlx === null ? undefined : { ...current.mlx, ...partial.mlx };
  }
  if (partial.llamaCpp !== undefined) {
    merged.llamaCpp =
      partial.llamaCpp === null ? undefined : { ...current.llamaCpp, ...partial.llamaCpp };
  }

  // Atomic write: write to tmp then rename
  const dir = dirname(CONFIG_PATH);
  mkdirSync(dir, { recursive: true });
  const tmpPath = CONFIG_PATH + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(merged, null, 2), "utf-8");
  renameSync(tmpPath, CONFIG_PATH);

  // Update cache immediately
  cached = merged;
  cacheTime = Date.now();

  return merged;
}

export function clearRuntimeConfigCache(): void {
  cached = null;
  cacheTime = 0;
}
