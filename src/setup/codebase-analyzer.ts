import { readdir, readFile, stat } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import type {
  CiWorkflow,
  CodebaseAnalysis,
  ExecFn,
  ExistingRule,
  LinterConfig,
  TechStack,
} from "../types";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyse the project at {@link projectDir} to extract tech stack,
 * conventions, build commands, and existing AI rule files.
 */
export async function analyzeCodebase(
  projectDir: string,
  exec: ExecFn
): Promise<CodebaseAnalysis> {
  const [
    stack,
    testFramework,
    buildCommands,
    lintCommands,
    existingRules,
    keyDirectories,
    filePatterns,
    linterConfig,
    importAliases,
    ciWorkflows,
    envVars,
    projectDocs,
  ] = await Promise.all([
    detectStack(projectDir),
    detectTestFramework(projectDir),
    detectBuildCommands(projectDir),
    detectLintCommands(projectDir),
    readExistingRules(projectDir),
    detectKeyDirectories(projectDir, exec),
    detectFilePatterns(projectDir, exec),
    detectLinterConfig(projectDir),
    detectImportAliases(projectDir),
    detectCiWorkflows(projectDir),
    detectEnvVars(projectDir),
    detectProjectDocs(projectDir),
  ]);

  return {
    stack,
    testFramework,
    buildCommands,
    lintCommands,
    existingRules,
    keyDirectories,
    filePatterns,
    linterConfig,
    importAliases,
    ciWorkflows,
    envVars,
    projectDocs,
  };
}

/**
 * Detect the project's technology stack by reading config files and
 * dependency manifests.
 */
export async function detectStack(projectDir: string): Promise<TechStack> {
  const stack: TechStack = {
    language: "unknown",
    framework: null,
    orm: null,
    styling: null,
    stateManagement: null,
    packageManager: null,
    monorepo: false,
    dependencies: [],
  };

  // ---- JavaScript / TypeScript projects -----------------------------------
  const pkg = await readJson(join(projectDir, "package.json"));
  if (pkg) {
    const allDeps = {
      ...((pkg.dependencies as Record<string, string>) ?? {}),
      ...((pkg.devDependencies as Record<string, string>) ?? {}),
    };
    const depNames = Object.keys(allDeps);
    stack.dependencies = depNames;

    // Language
    const hasTsConfig = await fileExists(join(projectDir, "tsconfig.json"));
    stack.language = hasTsConfig ? "TypeScript" : "JavaScript";

    // Framework
    stack.framework = detectFramework(depNames);

    // ORM
    stack.orm = detectOrm(depNames);

    // Styling
    stack.styling = detectStyling(depNames, projectDir);

    // State management
    stack.stateManagement = detectStateManagement(depNames);

    // Package manager
    stack.packageManager = await detectPackageManager(projectDir);

    // Monorepo
    stack.monorepo =
      pkg.workspaces != null ||
      (await fileExists(join(projectDir, "pnpm-workspace.yaml"))) ||
      (await fileExists(join(projectDir, "lerna.json")));

    return stack;
  }

  // ---- Rust projects ------------------------------------------------------
  if (await fileExists(join(projectDir, "Cargo.toml"))) {
    stack.language = "Rust";
    const cargo = await safeReadFile(join(projectDir, "Cargo.toml"));
    if (cargo) {
      if (cargo.includes("actix-web")) stack.framework = "Actix";
      else if (cargo.includes("axum")) stack.framework = "Axum";
      else if (cargo.includes("rocket")) stack.framework = "Rocket";
    }
    return stack;
  }

  // ---- Python projects ----------------------------------------------------
  if (await fileExists(join(projectDir, "requirements.txt"))) {
    stack.language = "Python";
    const reqs = await safeReadFile(join(projectDir, "requirements.txt"));
    if (reqs) {
      if (reqs.includes("django")) stack.framework = "Django";
      else if (reqs.includes("flask")) stack.framework = "Flask";
      else if (reqs.includes("fastapi")) stack.framework = "FastAPI";
      if (reqs.includes("sqlalchemy")) stack.orm = "SQLAlchemy";
    }
    return stack;
  }
  if (await fileExists(join(projectDir, "pyproject.toml"))) {
    stack.language = "Python";
    return stack;
  }

  // ---- Go projects --------------------------------------------------------
  if (await fileExists(join(projectDir, "go.mod"))) {
    stack.language = "Go";
    const gomod = await safeReadFile(join(projectDir, "go.mod"));
    if (gomod) {
      if (gomod.includes("gin-gonic")) stack.framework = "Gin";
      else if (gomod.includes("gofiber")) stack.framework = "Fiber";
      else if (gomod.includes("echo")) stack.framework = "Echo";
    }
    return stack;
  }

  return stack;
}

/**
 * Read any existing AI-assistant rule files from the project.
 *
 * Checks for:
 * - `CLAUDE.md`
 * - `.cursorrules`
 * - `.cursor/rules/*.mdc`
 * - `.windsurf/rules/*.md`
 * - `.github/copilot-instructions.md`
 * - `AGENTS.md`
 */
export async function readExistingRules(
  projectDir: string
): Promise<ExistingRule[]> {
  const rules: ExistingRule[] = [];

  // Single files at project root.
  const singleFiles: { source: string; rel: string }[] = [
    { source: "CLAUDE.md", rel: "CLAUDE.md" },
    { source: ".cursorrules", rel: ".cursorrules" },
    { source: "AGENTS.md", rel: "AGENTS.md" },
    {
      source: "GitHub Copilot",
      rel: ".github/copilot-instructions.md",
    },
  ];

  for (const { source, rel } of singleFiles) {
    const fullPath = join(projectDir, rel);
    const content = await safeReadFile(fullPath);
    if (content !== null) {
      rules.push({ source, path: fullPath, content });
    }
  }

  // Cursor rules directory.
  const cursorRulesDir = join(projectDir, ".cursor", "rules");
  const cursorFiles = await safeReaddir(cursorRulesDir);
  for (const name of cursorFiles) {
    if (!name.endsWith(".mdc")) continue;
    const fullPath = join(cursorRulesDir, name);
    const content = await safeReadFile(fullPath);
    if (content !== null) {
      rules.push({ source: `.cursor/rules/${name}`, path: fullPath, content });
    }
  }

  // Windsurf rules directory.
  const windsurfRulesDir = join(projectDir, ".windsurf", "rules");
  const windsurfFiles = await safeReaddir(windsurfRulesDir);
  for (const name of windsurfFiles) {
    if (!name.endsWith(".md")) continue;
    const fullPath = join(windsurfRulesDir, name);
    const content = await safeReadFile(fullPath);
    if (content !== null) {
      rules.push({
        source: `.windsurf/rules/${name}`,
        path: fullPath,
        content,
      });
    }
  }

  return rules;
}

// ---------------------------------------------------------------------------
// New data-source detectors
// ---------------------------------------------------------------------------

const MAX_CONTENT_LENGTH = 3000;

/**
 * Detect the project's linter / formatter configuration.
 * Checks Biome, ESLint, and Prettier config files in priority order and
 * returns the first match.
 */
export async function detectLinterConfig(
  projectDir: string
): Promise<LinterConfig | null> {
  const candidates: { tool: string; file: string }[] = [
    // Biome
    { tool: "Biome", file: "biome.json" },
    { tool: "Biome", file: "biome.jsonc" },
    // ESLint
    { tool: "ESLint", file: "eslint.config.js" },
    { tool: "ESLint", file: "eslint.config.mjs" },
    { tool: "ESLint", file: "eslint.config.ts" },
    { tool: "ESLint", file: ".eslintrc.json" },
    { tool: "ESLint", file: ".eslintrc.js" },
    { tool: "ESLint", file: ".eslintrc.yml" },
    { tool: "ESLint", file: ".eslintrc" },
    // Prettier
    { tool: "Prettier", file: ".prettierrc" },
    { tool: "Prettier", file: ".prettierrc.json" },
    { tool: "Prettier", file: ".prettierrc.js" },
    { tool: "Prettier", file: "prettier.config.js" },
    { tool: "Prettier", file: "prettier.config.mjs" },
  ];

  for (const { tool, file } of candidates) {
    const fullPath = join(projectDir, file);
    const content = await safeReadFile(fullPath);
    if (content !== null) {
      return {
        tool,
        configPath: file,
        content: content.slice(0, MAX_CONTENT_LENGTH),
      };
    }
  }

  return null;
}

/**
 * Extract TypeScript path aliases from `tsconfig.json` → `compilerOptions.paths`.
 * Returns a flat `Record<string, string>` mapping each alias to its first target path.
 */
export async function detectImportAliases(
  projectDir: string
): Promise<Record<string, string>> {
  const tsconfig = await readJson(join(projectDir, "tsconfig.json"));
  if (!tsconfig) return {};

  const paths = tsconfig.compilerOptions?.paths as
    | Record<string, string[]>
    | undefined;
  if (!paths) return {};

  const aliases: Record<string, string> = {};
  for (const [alias, targets] of Object.entries(paths)) {
    if (Array.isArray(targets) && targets.length > 0) {
      aliases[alias] = targets[0];
    }
  }
  return aliases;
}

/**
 * Discover CI/CD workflow files.
 * Reads `.github/workflows/*.yml` / `*.yaml` and `.gitlab-ci.yml`.
 */
export async function detectCiWorkflows(
  projectDir: string
): Promise<CiWorkflow[]> {
  const workflows: CiWorkflow[] = [];

  // GitHub Actions
  const ghDir = join(projectDir, ".github", "workflows");
  const ghFiles = await safeReaddir(ghDir);
  for (const name of ghFiles) {
    if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
    const fullPath = join(ghDir, name);
    const content = await safeReadFile(fullPath);
    if (content !== null) {
      workflows.push({
        name,
        path: `.github/workflows/${name}`,
        content: content.slice(0, MAX_CONTENT_LENGTH),
      });
    }
  }

  // GitLab CI
  const gitlabPath = join(projectDir, ".gitlab-ci.yml");
  const gitlabContent = await safeReadFile(gitlabPath);
  if (gitlabContent !== null) {
    workflows.push({
      name: ".gitlab-ci.yml",
      path: ".gitlab-ci.yml",
      content: gitlabContent.slice(0, MAX_CONTENT_LENGTH),
    });
  }

  return workflows;
}

/**
 * Parse variable names from `.env.example`.
 *
 * **Security boundary**: only reads `.env.example` — never `.env`,
 * `.env.local`, or any other env file.  Returns variable names only,
 * never values.
 */
export async function detectEnvVars(projectDir: string): Promise<string[]> {
  const content = await safeReadFile(join(projectDir, ".env.example"));
  if (content === null) return [];

  const varNames: string[] = [];
  for (const line of content.split("\n")) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=/);
    if (match) {
      varNames.push(match[1]);
    }
  }
  return varNames;
}

/**
 * Read project-level documentation files (CONTRIBUTING.md, ARCHITECTURE.md).
 * Returns them as `ExistingRule[]` so they slot into the existing data model.
 */
export async function detectProjectDocs(
  projectDir: string
): Promise<ExistingRule[]> {
  const docs: ExistingRule[] = [];

  const candidates: { source: string; rel: string }[] = [
    { source: "CONTRIBUTING.md", rel: "CONTRIBUTING.md" },
    { source: "ARCHITECTURE.md", rel: "ARCHITECTURE.md" },
    { source: "architecture.md", rel: "architecture.md" },
    { source: "docs/architecture.md", rel: "docs/architecture.md" },
  ];

  for (const { source, rel } of candidates) {
    const fullPath = join(projectDir, rel);
    const content = await safeReadFile(fullPath);
    if (content !== null) {
      docs.push({
        source,
        path: fullPath,
        content: content.slice(0, MAX_CONTENT_LENGTH),
      });
    }
  }

  return docs;
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

function detectFramework(deps: string[]): string | null {
  // Order matters — check specific frameworks before generic ones.
  if (deps.includes("next")) return "Next.js";
  if (deps.includes("nuxt")) return "Nuxt";
  if (deps.includes("@remix-run/react") || deps.includes("remix"))
    return "Remix";
  if (deps.includes("@angular/core")) return "Angular";
  if (deps.includes("svelte") || deps.includes("@sveltejs/kit"))
    return "SvelteKit";
  if (deps.includes("vue")) return "Vue";
  if (deps.includes("react")) return "React";
  if (deps.includes("express")) return "Express";
  if (deps.includes("fastify")) return "Fastify";
  if (deps.includes("hono")) return "Hono";
  if (deps.includes("astro")) return "Astro";
  if (deps.includes("solid-js")) return "SolidJS";
  return null;
}

function detectOrm(deps: string[]): string | null {
  if (deps.includes("prisma") || deps.includes("@prisma/client"))
    return "Prisma";
  if (deps.includes("drizzle-orm")) return "Drizzle";
  if (deps.includes("typeorm")) return "TypeORM";
  if (deps.includes("sequelize")) return "Sequelize";
  if (deps.includes("knex")) return "Knex";
  if (deps.includes("mongoose")) return "Mongoose";
  return null;
}

function detectStyling(deps: string[], _projectDir: string): string | null {
  if (deps.includes("tailwindcss")) return "Tailwind CSS";
  if (
    deps.includes("styled-components") ||
    deps.includes("@emotion/react")
  )
    return "CSS-in-JS";
  if (deps.includes("sass") || deps.includes("node-sass")) return "Sass";
  if (deps.includes("@vanilla-extract/css")) return "Vanilla Extract";
  return null;
}

function detectStateManagement(deps: string[]): string | null {
  if (deps.includes("zustand")) return "Zustand";
  if (deps.includes("@reduxjs/toolkit") || deps.includes("redux"))
    return "Redux";
  if (deps.includes("jotai")) return "Jotai";
  if (deps.includes("recoil")) return "Recoil";
  if (deps.includes("mobx")) return "MobX";
  if (deps.includes("pinia")) return "Pinia";
  if (deps.includes("@tanstack/react-query")) return "TanStack Query";
  return null;
}

async function detectPackageManager(
  projectDir: string
): Promise<string | null> {
  if (await fileExists(join(projectDir, "bun.lockb"))) return "bun";
  if (await fileExists(join(projectDir, "bun.lock"))) return "bun";
  if (await fileExists(join(projectDir, "pnpm-lock.yaml"))) return "pnpm";
  if (await fileExists(join(projectDir, "yarn.lock"))) return "yarn";
  if (await fileExists(join(projectDir, "package-lock.json"))) return "npm";
  return null;
}

async function detectTestFramework(
  projectDir: string
): Promise<string | null> {
  const pkg = await readJson(join(projectDir, "package.json"));
  if (pkg) {
    const allDeps = {
      ...((pkg.dependencies as Record<string, string>) ?? {}),
      ...((pkg.devDependencies as Record<string, string>) ?? {}),
    };
    const depNames = Object.keys(allDeps);

    if (depNames.includes("vitest")) return "Vitest";
    if (depNames.includes("jest")) return "Jest";
    if (depNames.includes("mocha")) return "Mocha";
    if (depNames.includes("ava")) return "Ava";
    if (depNames.includes("@playwright/test")) return "Playwright";
    if (depNames.includes("cypress")) return "Cypress";
  }

  // Python
  if (await fileExists(join(projectDir, "pytest.ini"))) return "pytest";
  if (await fileExists(join(projectDir, "setup.cfg"))) {
    const cfg = await safeReadFile(join(projectDir, "setup.cfg"));
    if (cfg?.includes("[tool:pytest]")) return "pytest";
  }

  // Rust
  if (await fileExists(join(projectDir, "Cargo.toml"))) return "cargo test";

  // Go
  if (await fileExists(join(projectDir, "go.mod"))) return "go test";

  return null;
}

async function detectBuildCommands(projectDir: string): Promise<string[]> {
  const pkg = await readJson(join(projectDir, "package.json"));
  if (!pkg?.scripts) return [];

  const scripts = pkg.scripts as Record<string, string>;
  const cmds: string[] = [];
  const buildKeys = ["build", "compile", "bundle", "typecheck", "tsc"];

  for (const key of buildKeys) {
    if (scripts[key]) cmds.push(`${key}: ${scripts[key]}`);
  }

  return cmds;
}

async function detectLintCommands(projectDir: string): Promise<string[]> {
  const pkg = await readJson(join(projectDir, "package.json"));
  if (!pkg?.scripts) return [];

  const scripts = pkg.scripts as Record<string, string>;
  const cmds: string[] = [];
  const lintKeys = [
    "lint",
    "lint:fix",
    "format",
    "prettier",
    "eslint",
    "check",
  ];

  for (const key of lintKeys) {
    if (scripts[key]) cmds.push(`${key}: ${scripts[key]}`);
  }

  return cmds;
}

async function detectKeyDirectories(
  projectDir: string,
  exec: ExecFn
): Promise<string[]> {
  // Try using find for speed; fall back to readdir.
  try {
    const result = await exec("find", [
      projectDir,
      "-maxdepth",
      "2",
      "-type",
      "d",
      "-not",
      "-path",
      "*/node_modules/*",
      "-not",
      "-path",
      "*/.git/*",
      "-not",
      "-path",
      "*/dist/*",
      "-not",
      "-path",
      "*/.next/*",
      "-not",
      "-path",
      "*/build/*",
      "-not",
      "-name",
      ".*",
    ]);

    if (result.code === 0) {
      return result.stdout
        .split("\n")
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => d.replace(projectDir + "/", ""))
        .filter((d) => d && d !== projectDir && !d.startsWith("/"))
        .sort();
    }
  } catch {
    // fall through
  }

  // Fallback: read top-level entries.
  try {
    const entries = await readdir(projectDir, { withFileTypes: true });
    return entries
      .filter(
        (e: { isDirectory: () => boolean; name: string }) =>
          e.isDirectory() &&
          !e.name.startsWith(".") &&
          !["node_modules", "dist", "build", ".next"].includes(e.name)
      )
      .map((e: { name: string }) => e.name)
      .sort();
  } catch {
    return [];
  }
}

async function detectFilePatterns(
  projectDir: string,
  exec: ExecFn
): Promise<{ extension: string; count: number }[]> {
  try {
    const result = await exec("find", [
      projectDir,
      "-maxdepth",
      "5",
      "-type",
      "f",
      "-not",
      "-path",
      "*/node_modules/*",
      "-not",
      "-path",
      "*/.git/*",
      "-not",
      "-path",
      "*/dist/*",
      "-not",
      "-path",
      "*/.next/*",
    ]);

    if (result.code !== 0) return [];

    const extCounts = new Map<string, number>();
    for (const line of result.stdout.split("\n")) {
      const file = line.trim();
      if (!file) continue;
      const ext = extname(basename(file));
      if (!ext) continue;
      extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
    }

    return [...extCounts.entries()]
      .map(([extension, count]) => ({ extension, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20); // top 20 extensions
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// File I/O helpers
// ---------------------------------------------------------------------------

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function safeReadFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function readJson(path: string): Promise<Record<string, any> | null> {
  const raw = await safeReadFile(path);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
