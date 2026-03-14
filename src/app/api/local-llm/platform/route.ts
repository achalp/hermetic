import { execSync } from "child_process";

function checkCommand(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function checkPythonModule(mod: string): boolean {
  try {
    execSync(`python3 -c "import ${mod}"`, { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function GET() {
  const os = process.platform; // "darwin", "linux", "win32"
  const arch = process.arch; // "arm64", "x64"
  const isAppleSilicon = os === "darwin" && arch === "arm64";

  return Response.json({
    os,
    arch,
    isAppleSilicon,
    hasPython: checkCommand("python3"),
    hasMlxLm: isAppleSilicon ? checkPythonModule("mlx_lm") || checkCommand("mlx_lm.server") : false,
    hasLlamaServer:
      checkCommand("llama-server") || checkCommand(`${process.cwd()}/data/bin/llama-server`),
    hasOllama: checkCommand("ollama"),
    hasHfCli: checkPythonModule("huggingface_hub"),
  });
}
