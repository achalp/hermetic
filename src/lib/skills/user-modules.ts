/**
 * User Python modules — data/user_lib/*.py (a team's metric definitions,
 * loaders) shipped into every sandbox run at /data/user_lib/ and advertised to
 * the code-gen prompt with AST-free signature extraction.
 *
 * Dependency resolution happens HERE, at load time, never at run time (spec
 * §4.5): imports are extracted host-side and validated against the sandbox
 * image's package manifest + the Python stdlib. A module that needs an
 * unavailable package is rejected with a human-readable reason instead of
 * becoming a mid-run ModuleNotFoundError that the codegen retry loop cannot
 * fix (parse-output classifies that residue as "user-config", non-retryable).
 * The host never imports/executes user code — text parsing only.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { logger } from "@/lib/logger";
import { diagEvent } from "@/lib/diagnostics/run-diagnostics";
import { extractPreloadedFns, type PreloadedFn } from "@/lib/sandbox/runtime-files";
import type { SkillFile } from "./types";
import { hermeticPaths } from "@/lib/paths";

/** Import names satisfiable inside the sandbox image (docker/sandbox/Dockerfile
 *  pins + their user-importable transitive deps). Keep in sync with the image. */
const IMAGE_PACKAGES = new Set([
  "pandas",
  "numpy",
  "scipy",
  "matplotlib",
  "seaborn",
  "sklearn",
  "duckdb",
  "pyflakes",
  // user-importable transitive deps of the pinned set
  "pytz",
  "dateutil",
  "PIL",
  "joblib",
]);

/** In-sandbox namespaces shipped by us per run. */
const SANDBOX_NAMESPACES = new Set(["hermetic_runtime", "skill_lib", "user_lib"]);

/** Python 3 stdlib top-level module names (sys.stdlib_module_names, public). */
const PY_STDLIB = new Set(
  (
    "__future__,abc,annotationlib,argparse,array,ast,asyncio,atexit,base64,bdb,binascii,bisect," +
    "builtins,bz2,cProfile,calendar,cmath,cmd,code,codecs,codeop,collections,colorsys,compileall," +
    "compression,concurrent,configparser,contextlib,contextvars,copy,copyreg,csv,ctypes,curses," +
    "dataclasses,datetime,dbm,decimal,difflib,dis,doctest,email,encodings,ensurepip,enum,errno," +
    "faulthandler,fcntl,filecmp,fileinput,fnmatch,fractions,ftplib,functools,gc,getopt,getpass," +
    "gettext,glob,graphlib,grp,gzip,hashlib,heapq,hmac,html,http,imaplib,importlib,inspect,io," +
    "ipaddress,itertools,json,keyword,linecache,locale,logging,lzma,mailbox,marshal,math,mimetypes," +
    "mmap,modulefinder,multiprocessing,netrc,numbers,operator,optparse,os,pathlib,pdb,pickle," +
    "pickletools,pkgutil,platform,plistlib,poplib,posixpath,pprint,profile,pstats,pty,pwd," +
    "py_compile,pyclbr,pydoc,pyexpat,queue,quopri,random,re,readline,reprlib,resource,rlcompleter," +
    "runpy,sched,secrets,select,selectors,shelve,shlex,shutil,signal,site,smtplib,socket," +
    "socketserver,sqlite3,ssl,stat,statistics,string,stringprep,struct,subprocess,symtable,sys," +
    "sysconfig,syslog,tabnanny,tarfile,tempfile,termios,textwrap,threading,time,timeit,token," +
    "tokenize,tomllib,trace,traceback,tracemalloc,tty,types,typing,unicodedata,unittest,urllib," +
    "uuid,venv,warnings,wave,weakref,webbrowser,wsgiref,xml,xmlrpc,zipapp,zipfile,zipimport,zlib," +
    "zoneinfo"
  ).split(",")
);

/** Top-level (or any-line) import statements → first dotted segment. */
export function extractImports(source: string): string[] {
  const names = new Set<string>();
  const re = /^\s*(?:import|from)\s+([A-Za-z_][A-Za-z0-9_.]*)/gm;
  for (const m of source.matchAll(re)) {
    names.add(m[1].split(".")[0]);
  }
  return [...names];
}

/**
 * The import names a user module may use. Sibling user modules are addressed
 * as user_lib.<name>, so bare sibling imports are NOT allowed (they would fail
 * at run time — /data/user_lib is a package dir, not a sys.path root).
 */
export function findUnavailableImports(source: string): string[] {
  return extractImports(source).filter(
    (name) => !PY_STDLIB.has(name) && !IMAGE_PACKAGES.has(name) && !SANDBOX_NAMESPACES.has(name)
  );
}

export interface UserModule {
  /** Import path inside the sandbox: user_lib.<moduleName>. */
  moduleName: string;
  sourcePath: string;
  content: string;
  functions: PreloadedFn[];
}

export interface UserModuleLoadResult {
  modules: UserModule[];
  errors: { path: string; reason: string }[];
}

export function defaultUserLibDir(): string {
  return hermeticPaths.userLibDir();
}

interface CacheEntry {
  mtimeMs: number;
  module: UserModule | null;
  reason?: string;
}

const cache = new Map<string, CacheEntry>();

/** Test-only: reset the mtime cache. */
export function resetUserModuleCacheForTests(): void {
  cache.clear();
}

export function loadUserModules(dir: string = defaultUserLibDir()): UserModuleLoadResult {
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".py") && !f.startsWith("_"))
      .map((f) => path.join(dir, f));
  } catch {
    return { modules: [], errors: [] }; // no user_lib dir — the common case
  }

  const modules: UserModule[] = [];
  const errors: UserModuleLoadResult["errors"] = [];
  for (const file of files) {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    const cached = cache.get(file);
    if (cached && cached.mtimeMs === mtimeMs) {
      if (cached.module) modules.push(cached.module);
      else if (cached.reason) errors.push({ path: file, reason: cached.reason });
      continue;
    }

    const moduleName = path.basename(file, ".py");
    let reason: string | null = null;
    let content = "";
    if (!/^[a-z_][a-z0-9_]*$/i.test(moduleName)) {
      reason = `module filename "${moduleName}.py" is not a valid Python module name`;
    } else {
      try {
        content = readFileSync(file, "utf8");
        if (content.length > 64 * 1024) {
          reason = "module exceeds the 64 KB limit";
        } else {
          const missing = findUnavailableImports(content);
          if (missing.length > 0) {
            reason =
              `imports ${missing.map((n) => `'${n}'`).join(", ")} — not available in the sandbox ` +
              `image (available: stdlib, ${[...IMAGE_PACKAGES].join(", ")})`;
          }
        }
      } catch (err) {
        reason = `unreadable: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    if (reason) {
      cache.set(file, { mtimeMs, module: null, reason });
      errors.push({ path: file, reason });
      logger.warn("User module rejected", { path: file, reason });
      diagEvent("user_module_invalid", { path: file, reason });
    } else {
      const userModule: UserModule = {
        moduleName,
        sourcePath: file,
        content,
        functions: extractPreloadedFns(content),
      };
      cache.set(file, { mtimeMs, module: userModule });
      modules.push(userModule);
      logger.info("User module loaded", {
        module: `user_lib.${moduleName}`,
        functions: userModule.functions.map((f) => f.name),
      });
    }
  }
  return { modules, errors };
}

/** Valid user modules as sandbox files (/data/user_lib/<name>.py). */
export function userModuleFiles(dir?: string): SkillFile[] {
  return loadUserModules(dir).modules.map((m) => ({
    path: `/data/user_lib/${m.moduleName}.py`,
    content: m.content,
  }));
}

/**
 * The "User Python modules" prompt section — module import paths + extracted
 * signatures/docstrings. Stable per user_lib contents, so it is safe inside
 * the CACHED schema-block prefix. "" when there are no valid modules.
 */
export function buildUserModulesSection(dir?: string): string {
  const { modules } = loadUserModules(dir);
  if (modules.length === 0) return "";
  const blocks = modules.map((m) => {
    const fns = m.functions.length
      ? m.functions.map((fn) => `  - ${fn.name}(${fn.signature}): ${fn.summary}`).join("\n")
      : "  - (no documented functions found — read the module before relying on it)";
    return `- \`from user_lib.${m.moduleName} import ...\` (preloaded at /data/user_lib/${m.moduleName}.py):\n${fns}`;
  });
  return (
    `\n## User Python modules (preloaded — prefer these over re-implementing their logic)\n` +
    blocks.join("\n") +
    `\n`
  );
}
