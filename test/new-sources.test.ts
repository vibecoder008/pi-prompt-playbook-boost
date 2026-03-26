import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectLinterConfig,
  detectImportAliases,
  detectCiWorkflows,
  detectEnvVars,
  detectProjectDocs,
} from "../src/setup/codebase-analyzer";
import {
  buildAnalysisSummary,
} from "../src/setup/playbook-generator";
import type { CodebaseAnalysis, GitAnalysis, SessionAnalysis } from "../src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "new-sources-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function emptyAnalysis(): CodebaseAnalysis {
  return {
    stack: {
      language: "unknown",
      framework: null,
      orm: null,
      styling: null,
      stateManagement: null,
      packageManager: null,
      monorepo: false,
      dependencies: [],
    },
    testFramework: null,
    buildCommands: [],
    lintCommands: [],
    existingRules: [],
    keyDirectories: [],
    filePatterns: [],
    linterConfig: null,
    importAliases: {},
    ciWorkflows: [],
    envVars: [],
    projectDocs: [],
  };
}

// ---------------------------------------------------------------------------
// detectLinterConfig
// ---------------------------------------------------------------------------

describe("detectLinterConfig", () => {
  it("returns null when no config files exist", async () => {
    const result = await detectLinterConfig(tmpDir);
    expect(result).toBeNull();
  });

  it("detects biome.json", async () => {
    const content = JSON.stringify({ formatter: { indentStyle: "space" } });
    await writeFile(join(tmpDir, "biome.json"), content);

    const result = await detectLinterConfig(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.tool).toBe("Biome");
    expect(result!.configPath).toBe("biome.json");
    expect(result!.content).toBe(content);
  });

  it("detects eslint.config.js", async () => {
    const content = "export default [{ rules: {} }];";
    await writeFile(join(tmpDir, "eslint.config.js"), content);

    const result = await detectLinterConfig(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.tool).toBe("ESLint");
    expect(result!.configPath).toBe("eslint.config.js");
    expect(result!.content).toBe(content);
  });

  it("detects .prettierrc", async () => {
    const content = JSON.stringify({ semi: false, singleQuote: true });
    await writeFile(join(tmpDir, ".prettierrc"), content);

    const result = await detectLinterConfig(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.tool).toBe("Prettier");
    expect(result!.configPath).toBe(".prettierrc");
    expect(result!.content).toBe(content);
  });

  it("returns first by priority: Biome > ESLint > Prettier", async () => {
    await writeFile(join(tmpDir, ".prettierrc"), "{}");
    await writeFile(join(tmpDir, "eslint.config.js"), "export default [];");
    await writeFile(join(tmpDir, "biome.json"), "{}");

    const result = await detectLinterConfig(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.tool).toBe("Biome");
    expect(result!.configPath).toBe("biome.json");
  });

  it("returns ESLint when Biome is absent but ESLint and Prettier exist", async () => {
    await writeFile(join(tmpDir, ".prettierrc"), "{}");
    await writeFile(join(tmpDir, "eslint.config.js"), "export default [];");

    const result = await detectLinterConfig(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.tool).toBe("ESLint");
  });

  it("truncates content to 3000 chars for large files", async () => {
    const largeContent = "x".repeat(5000);
    await writeFile(join(tmpDir, "biome.json"), largeContent);

    const result = await detectLinterConfig(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.content).toHaveLength(3000);
    expect(result!.content).toBe("x".repeat(3000));
  });

  it("detects biome.jsonc variant", async () => {
    await writeFile(join(tmpDir, "biome.jsonc"), "// biome config\n{}");

    const result = await detectLinterConfig(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.tool).toBe("Biome");
    expect(result!.configPath).toBe("biome.jsonc");
  });

  it("detects .eslintrc.json", async () => {
    await writeFile(join(tmpDir, ".eslintrc.json"), '{ "rules": {} }');

    const result = await detectLinterConfig(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.tool).toBe("ESLint");
    expect(result!.configPath).toBe(".eslintrc.json");
  });

  it("detects prettier.config.js", async () => {
    await writeFile(join(tmpDir, "prettier.config.js"), "module.exports = {};");

    const result = await detectLinterConfig(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.tool).toBe("Prettier");
    expect(result!.configPath).toBe("prettier.config.js");
  });
});

// ---------------------------------------------------------------------------
// detectImportAliases
// ---------------------------------------------------------------------------

describe("detectImportAliases", () => {
  it("returns empty object when no tsconfig exists", async () => {
    const result = await detectImportAliases(tmpDir);
    expect(result).toEqual({});
  });

  it("returns empty object when tsconfig has no paths", async () => {
    await writeFile(
      join(tmpDir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true } }),
    );

    const result = await detectImportAliases(tmpDir);
    expect(result).toEqual({});
  });

  it("returns empty object when compilerOptions is absent", async () => {
    await writeFile(
      join(tmpDir, "tsconfig.json"),
      JSON.stringify({ include: ["src"] }),
    );

    const result = await detectImportAliases(tmpDir);
    expect(result).toEqual({});
  });

  it("returns flattened record with first array entry for each alias", async () => {
    await writeFile(
      join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          paths: {
            "@/*": ["./src/*"],
          },
        },
      }),
    );

    const result = await detectImportAliases(tmpDir);
    expect(result).toEqual({ "@/*": "./src/*" });
  });

  it("returns all aliases when multiple are defined", async () => {
    await writeFile(
      join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          paths: {
            "@/*": ["./src/*"],
            "@components/*": ["./src/components/*"],
            "@utils/*": ["./src/utils/*", "./src/helpers/*"],
          },
        },
      }),
    );

    const result = await detectImportAliases(tmpDir);
    expect(result).toEqual({
      "@/*": "./src/*",
      "@components/*": "./src/components/*",
      "@utils/*": "./src/utils/*",
    });
  });

  it("takes only the first target when an alias has multiple paths", async () => {
    await writeFile(
      join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          paths: {
            "~/*": ["./app/*", "./lib/*", "./shared/*"],
          },
        },
      }),
    );

    const result = await detectImportAliases(tmpDir);
    expect(result).toEqual({ "~/*": "./app/*" });
  });

  it("returns empty object for invalid JSON", async () => {
    await writeFile(join(tmpDir, "tsconfig.json"), "{ not valid json }}");

    const result = await detectImportAliases(tmpDir);
    expect(result).toEqual({});
  });

  it("skips aliases with empty target arrays", async () => {
    await writeFile(
      join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          paths: {
            "@valid/*": ["./src/*"],
            "@empty/*": [],
          },
        },
      }),
    );

    const result = await detectImportAliases(tmpDir);
    expect(result).toEqual({ "@valid/*": "./src/*" });
    expect(result).not.toHaveProperty("@empty/*");
  });
});

// ---------------------------------------------------------------------------
// detectCiWorkflows
// ---------------------------------------------------------------------------

describe("detectCiWorkflows", () => {
  it("returns empty array when no .github dir exists", async () => {
    const result = await detectCiWorkflows(tmpDir);
    expect(result).toEqual([]);
  });

  it("returns empty array when .github/workflows dir is empty", async () => {
    await mkdir(join(tmpDir, ".github", "workflows"), { recursive: true });

    const result = await detectCiWorkflows(tmpDir);
    expect(result).toEqual([]);
  });

  it("detects .yml files in .github/workflows", async () => {
    const workflowsDir = join(tmpDir, ".github", "workflows");
    await mkdir(workflowsDir, { recursive: true });
    const ciContent = "name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest";
    await writeFile(join(workflowsDir, "ci.yml"), ciContent);

    const result = await detectCiWorkflows(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("ci.yml");
    expect(result[0].path).toBe(".github/workflows/ci.yml");
    expect(result[0].content).toBe(ciContent);
  });

  it("detects .yaml files in .github/workflows", async () => {
    const workflowsDir = join(tmpDir, ".github", "workflows");
    await mkdir(workflowsDir, { recursive: true });
    const deployContent = "name: Deploy\non: push";
    await writeFile(join(workflowsDir, "deploy.yaml"), deployContent);

    const result = await detectCiWorkflows(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("deploy.yaml");
    expect(result[0].path).toBe(".github/workflows/deploy.yaml");
    expect(result[0].content).toBe(deployContent);
  });

  it("detects both .yml and .yaml files", async () => {
    const workflowsDir = join(tmpDir, ".github", "workflows");
    await mkdir(workflowsDir, { recursive: true });
    await writeFile(join(workflowsDir, "ci.yml"), "name: CI");
    await writeFile(join(workflowsDir, "deploy.yaml"), "name: Deploy");

    const result = await detectCiWorkflows(tmpDir);
    expect(result).toHaveLength(2);
    const names = result.map((w) => w.name).sort();
    expect(names).toEqual(["ci.yml", "deploy.yaml"]);
  });

  it("ignores non-yml files in workflows dir", async () => {
    const workflowsDir = join(tmpDir, ".github", "workflows");
    await mkdir(workflowsDir, { recursive: true });
    await writeFile(join(workflowsDir, "ci.yml"), "name: CI");
    await writeFile(join(workflowsDir, "README.md"), "# Workflows");
    await writeFile(join(workflowsDir, "notes.txt"), "some notes");
    await writeFile(join(workflowsDir, "config.json"), "{}");

    const result = await detectCiWorkflows(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("ci.yml");
  });

  it("detects .gitlab-ci.yml at project root", async () => {
    const content = "stages:\n  - test\n  - deploy";
    await writeFile(join(tmpDir, ".gitlab-ci.yml"), content);

    const result = await detectCiWorkflows(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe(".gitlab-ci.yml");
    expect(result[0].path).toBe(".gitlab-ci.yml");
    expect(result[0].content).toBe(content);
  });

  it("returns both GitHub Actions and GitLab CI when both exist", async () => {
    const workflowsDir = join(tmpDir, ".github", "workflows");
    await mkdir(workflowsDir, { recursive: true });
    await writeFile(join(workflowsDir, "ci.yml"), "name: GH CI");
    await writeFile(join(tmpDir, ".gitlab-ci.yml"), "stages: [test]");

    const result = await detectCiWorkflows(tmpDir);
    expect(result).toHaveLength(2);
    const names = result.map((w) => w.name);
    expect(names).toContain("ci.yml");
    expect(names).toContain(".gitlab-ci.yml");
  });

  it("truncates large workflow content to 3000 chars", async () => {
    const workflowsDir = join(tmpDir, ".github", "workflows");
    await mkdir(workflowsDir, { recursive: true });
    const largeContent = "y".repeat(5000);
    await writeFile(join(workflowsDir, "big.yml"), largeContent);

    const result = await detectCiWorkflows(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].content).toHaveLength(3000);
    expect(result[0].content).toBe("y".repeat(3000));
  });

  it("truncates .gitlab-ci.yml content to 3000 chars", async () => {
    const largeContent = "z".repeat(4000);
    await writeFile(join(tmpDir, ".gitlab-ci.yml"), largeContent);

    const result = await detectCiWorkflows(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].content).toHaveLength(3000);
  });
});

// ---------------------------------------------------------------------------
// detectEnvVars
// ---------------------------------------------------------------------------

describe("detectEnvVars", () => {
  it("returns empty array when no .env.example exists", async () => {
    const result = await detectEnvVars(tmpDir);
    expect(result).toEqual([]);
  });

  it("returns variable names from .env.example", async () => {
    await writeFile(
      join(tmpDir, ".env.example"),
      "DATABASE_URL=postgres://localhost/db\nAPI_KEY=secret123\n",
    );

    const result = await detectEnvVars(tmpDir);
    expect(result).toEqual(["DATABASE_URL", "API_KEY"]);
  });

  it("returns names only, never values", async () => {
    await writeFile(
      join(tmpDir, ".env.example"),
      "SECRET_TOKEN=super-secret-value-12345\n",
    );

    const result = await detectEnvVars(tmpDir);
    expect(result).toEqual(["SECRET_TOKEN"]);
    expect(result.join("")).not.toContain("super-secret-value-12345");
  });

  it("skips comments", async () => {
    await writeFile(
      join(tmpDir, ".env.example"),
      "# This is a comment\nDATABASE_URL=value\n# Another comment\nAPI_KEY=value\n",
    );

    const result = await detectEnvVars(tmpDir);
    expect(result).toEqual(["DATABASE_URL", "API_KEY"]);
  });

  it("skips empty lines", async () => {
    await writeFile(
      join(tmpDir, ".env.example"),
      "DB_HOST=localhost\n\n\nDB_PORT=5432\n",
    );

    const result = await detectEnvVars(tmpDir);
    expect(result).toEqual(["DB_HOST", "DB_PORT"]);
  });

  it("only reads .env.example, not .env or .env.local", async () => {
    // Create .env and .env.local with variables that should NOT be read
    await writeFile(join(tmpDir, ".env"), "REAL_SECRET=do-not-read\n");
    await writeFile(join(tmpDir, ".env.local"), "LOCAL_SECRET=do-not-read\n");
    // No .env.example

    const result = await detectEnvVars(tmpDir);
    expect(result).toEqual([]);
    expect(result).not.toContain("REAL_SECRET");
    expect(result).not.toContain("LOCAL_SECRET");
  });

  it("reads only .env.example when all env files exist", async () => {
    await writeFile(join(tmpDir, ".env"), "REAL_SECRET=hidden\n");
    await writeFile(join(tmpDir, ".env.local"), "LOCAL_SECRET=hidden\n");
    await writeFile(join(tmpDir, ".env.example"), "EXAMPLE_VAR=placeholder\n");

    const result = await detectEnvVars(tmpDir);
    expect(result).toEqual(["EXAMPLE_VAR"]);
    expect(result).not.toContain("REAL_SECRET");
    expect(result).not.toContain("LOCAL_SECRET");
  });

  it("handles KEY=value format", async () => {
    await writeFile(join(tmpDir, ".env.example"), "MY_VAR=some_value\n");

    const result = await detectEnvVars(tmpDir);
    expect(result).toEqual(["MY_VAR"]);
  });

  it('handles KEY="value" format', async () => {
    await writeFile(join(tmpDir, ".env.example"), 'MY_VAR="quoted value"\n');

    const result = await detectEnvVars(tmpDir);
    expect(result).toEqual(["MY_VAR"]);
  });

  it("handles KEY= (empty value) format", async () => {
    await writeFile(join(tmpDir, ".env.example"), "MY_VAR=\n");

    const result = await detectEnvVars(tmpDir);
    expect(result).toEqual(["MY_VAR"]);
  });

  it("handles mixed variable formats", async () => {
    await writeFile(
      join(tmpDir, ".env.example"),
      [
        "# Database config",
        "DATABASE_URL=postgres://localhost/db",
        'REDIS_URL="redis://localhost:6379"',
        "SECRET_KEY=",
        "",
        "# API settings",
        "API_PORT=3000",
      ].join("\n"),
    );

    const result = await detectEnvVars(tmpDir);
    expect(result).toEqual(["DATABASE_URL", "REDIS_URL", "SECRET_KEY", "API_PORT"]);
  });

  it("ignores lines that do not start with uppercase/underscore variable names", async () => {
    await writeFile(
      join(tmpDir, ".env.example"),
      [
        "VALID_VAR=yes",
        "lowercase=nope",
        "123INVALID=no",
        "_UNDERSCORE_START=yes",
      ].join("\n"),
    );

    const result = await detectEnvVars(tmpDir);
    // The regex requires ^[A-Z_][A-Z0-9_]*=
    expect(result).toContain("VALID_VAR");
    expect(result).toContain("_UNDERSCORE_START");
    expect(result).not.toContain("lowercase");
    expect(result).not.toContain("123INVALID");
  });
});

// ---------------------------------------------------------------------------
// detectProjectDocs
// ---------------------------------------------------------------------------

describe("detectProjectDocs", () => {
  it("returns empty array when no doc files exist", async () => {
    const result = await detectProjectDocs(tmpDir);
    expect(result).toEqual([]);
  });

  it("detects CONTRIBUTING.md at root", async () => {
    const content = "# Contributing\nPlease follow the guidelines.";
    await writeFile(join(tmpDir, "CONTRIBUTING.md"), content);

    const result = await detectProjectDocs(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("CONTRIBUTING.md");
    expect(result[0].path).toBe(join(tmpDir, "CONTRIBUTING.md"));
    expect(result[0].content).toBe(content);
  });

  it("detects ARCHITECTURE.md at root", async () => {
    const content = "# Architecture\nThis project uses a layered architecture.";
    await writeFile(join(tmpDir, "ARCHITECTURE.md"), content);

    const result = await detectProjectDocs(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("ARCHITECTURE.md");
    expect(result[0].content).toBe(content);
  });

  it("detects docs/architecture.md", async () => {
    await mkdir(join(tmpDir, "docs"), { recursive: true });
    const content = "# Architecture\nFrom the docs directory.";
    await writeFile(join(tmpDir, "docs", "architecture.md"), content);

    const result = await detectProjectDocs(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("docs/architecture.md");
    expect(result[0].path).toBe(join(tmpDir, "docs", "architecture.md"));
    expect(result[0].content).toBe(content);
  });

  it("returns multiple docs when several exist", async () => {
    await mkdir(join(tmpDir, "docs"), { recursive: true });
    await writeFile(join(tmpDir, "CONTRIBUTING.md"), "# Contributing");
    await writeFile(join(tmpDir, "ARCHITECTURE.md"), "# Arch upper");
    await writeFile(join(tmpDir, "docs", "architecture.md"), "# Arch docs");

    const result = await detectProjectDocs(tmpDir);
    expect(result).toHaveLength(3);
    const sources = result.map((d) => d.source);
    expect(sources).toContain("CONTRIBUTING.md");
    expect(sources).toContain("ARCHITECTURE.md");
    expect(sources).toContain("docs/architecture.md");
  });

  it("truncates large doc content to 3000 chars", async () => {
    const largeContent = "W".repeat(5000);
    await writeFile(join(tmpDir, "CONTRIBUTING.md"), largeContent);

    const result = await detectProjectDocs(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].content).toHaveLength(3000);
    expect(result[0].content).toBe("W".repeat(3000));
  });

  it("detects architecture.md (lowercase) at root", async () => {
    await writeFile(join(tmpDir, "architecture.md"), "# Arch lowercase");

    const result = await detectProjectDocs(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("architecture.md");
  });

  it("returns all four doc types when all exist", async () => {
    await mkdir(join(tmpDir, "docs"), { recursive: true });
    await writeFile(join(tmpDir, "CONTRIBUTING.md"), "contrib");
    await writeFile(join(tmpDir, "ARCHITECTURE.md"), "arch-upper");
    await writeFile(join(tmpDir, "architecture.md"), "arch-lower");
    await writeFile(join(tmpDir, "docs", "architecture.md"), "arch-docs");

    const result = await detectProjectDocs(tmpDir);
    expect(result).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Integration: playbook-generator with new fields
// ---------------------------------------------------------------------------

describe("buildAnalysisSummary with new fields", () => {
  it("mentions linter when linterConfig is set", () => {
    const analysis = emptyAnalysis();
    analysis.linterConfig = {
      tool: "Biome",
      configPath: "biome.json",
      content: "{}",
    };

    const summary = buildAnalysisSummary(null, null, analysis);
    expect(summary).toContain("Linter: Biome");
  });

  it("does not mention linter when linterConfig is null", () => {
    const analysis = emptyAnalysis();

    const summary = buildAnalysisSummary(null, null, analysis);
    expect(summary).not.toContain("Linter");
  });

  it("mentions CI workflows count", () => {
    const analysis = emptyAnalysis();
    analysis.ciWorkflows = [
      { name: "ci.yml", path: ".github/workflows/ci.yml", content: "name: CI" },
      { name: "deploy.yml", path: ".github/workflows/deploy.yml", content: "name: Deploy" },
    ];

    const summary = buildAnalysisSummary(null, null, analysis);
    expect(summary).toContain("2 CI workflow(s) detected");
  });

  it("does not mention CI when ciWorkflows is empty", () => {
    const analysis = emptyAnalysis();

    const summary = buildAnalysisSummary(null, null, analysis);
    expect(summary).not.toContain("CI workflow");
  });

  it("mentions env vars count from .env.example", () => {
    const analysis = emptyAnalysis();
    analysis.envVars = ["DATABASE_URL", "API_KEY", "SECRET"];

    const summary = buildAnalysisSummary(null, null, analysis);
    expect(summary).toContain("3 environment variables from .env.example");
  });

  it("does not mention env vars when envVars is empty", () => {
    const analysis = emptyAnalysis();

    const summary = buildAnalysisSummary(null, null, analysis);
    expect(summary).not.toContain("environment variables");
  });

  it("mentions project docs by name", () => {
    const analysis = emptyAnalysis();
    analysis.projectDocs = [
      { source: "CONTRIBUTING.md", path: "/project/CONTRIBUTING.md", content: "contrib" },
      { source: "ARCHITECTURE.md", path: "/project/ARCHITECTURE.md", content: "arch" },
    ];

    const summary = buildAnalysisSummary(null, null, analysis);
    expect(summary).toContain("Project docs found: CONTRIBUTING.md, ARCHITECTURE.md");
  });

  it("does not mention project docs when projectDocs is empty", () => {
    const analysis = emptyAnalysis();

    const summary = buildAnalysisSummary(null, null, analysis);
    expect(summary).not.toContain("Project docs");
  });

  it("includes all new fields in a fully-populated summary", () => {
    const analysis = emptyAnalysis();
    analysis.stack.language = "TypeScript";
    analysis.stack.framework = "Next.js";
    analysis.testFramework = "Vitest";
    analysis.linterConfig = {
      tool: "ESLint",
      configPath: "eslint.config.js",
      content: "export default [];",
    };
    analysis.ciWorkflows = [
      { name: "ci.yml", path: ".github/workflows/ci.yml", content: "name: CI" },
    ];
    analysis.envVars = ["DATABASE_URL", "API_KEY"];
    analysis.projectDocs = [
      { source: "CONTRIBUTING.md", path: "/p/CONTRIBUTING.md", content: "guide" },
    ];
    analysis.existingRules = [
      { source: "CLAUDE.md", path: "/p/CLAUDE.md", content: "rules" },
    ];
    analysis.buildCommands = ["build: next build"];
    analysis.lintCommands = ["lint: eslint ."];

    const summary = buildAnalysisSummary(null, null, analysis);
    expect(summary).toContain("Tech stack: TypeScript, Next.js");
    expect(summary).toContain("Test framework: Vitest");
    expect(summary).toContain("Linter: ESLint");
    expect(summary).toContain("1 CI workflow(s) detected");
    expect(summary).toContain("2 environment variables from .env.example");
    expect(summary).toContain("Project docs found: CONTRIBUTING.md");
    expect(summary).toContain("Existing rules imported from: CLAUDE.md");
  });

  it("produces a clean summary when all new fields are empty/null", () => {
    const analysis = emptyAnalysis();

    const summary = buildAnalysisSummary(null, null, analysis);
    // Should not contain any new-field section labels
    expect(summary).not.toContain("Linter");
    expect(summary).not.toContain("CI workflow");
    expect(summary).not.toContain("environment variables");
    expect(summary).not.toContain("Project docs");
    // But should still have the basics
    expect(summary).toContain("No git history");
    expect(summary).toContain("No pi session history");
  });
});

// ---------------------------------------------------------------------------
// Integration: formatCodebaseAnalysis output validation
// ---------------------------------------------------------------------------

// formatCodebaseAnalysis is not exported directly, but we can test it
// indirectly through generatePlaybookPrompt which uses it. However, the
// spec asks us to test its output. Since it's a private function in the
// module, we test the observable behavior through buildAnalysisSummary
// (which IS exported) and by verifying generatePlaybookPrompt output.

// We import generatePlaybookPrompt for integration tests.
import { generatePlaybookPrompt } from "../src/setup/playbook-generator";

describe("formatCodebaseAnalysis via generatePlaybookPrompt", () => {
  it("includes all new sections when fields are populated", () => {
    const analysis = emptyAnalysis();
    analysis.stack.language = "TypeScript";
    analysis.linterConfig = {
      tool: "Biome",
      configPath: "biome.json",
      content: '{ "formatter": {} }',
    };
    analysis.importAliases = {
      "@/*": "./src/*",
      "@utils/*": "./src/utils/*",
    };
    analysis.ciWorkflows = [
      {
        name: "ci.yml",
        path: ".github/workflows/ci.yml",
        content: "name: CI\non: push",
      },
    ];
    analysis.envVars = ["DATABASE_URL", "API_KEY"];
    analysis.projectDocs = [
      {
        source: "CONTRIBUTING.md",
        path: "/project/CONTRIBUTING.md",
        content: "# How to contribute",
      },
    ];

    const prompt = generatePlaybookPrompt(null, null, analysis);

    // Linter section
    expect(prompt).toContain("Linter/Formatter Configuration");
    expect(prompt).toContain("Tool: Biome");
    expect(prompt).toContain("Config: biome.json");
    expect(prompt).toContain('{ "formatter": {} }');

    // Import aliases section
    expect(prompt).toContain("Import Aliases (tsconfig paths)");
    expect(prompt).toContain("@/* → ./src/*");
    expect(prompt).toContain("@utils/* → ./src/utils/*");

    // CI/CD section
    expect(prompt).toContain("CI/CD Workflows");
    expect(prompt).toContain("Workflow: ci.yml");
    expect(prompt).toContain("name: CI");

    // Env vars section
    expect(prompt).toContain("Required Environment Variables (.env.example)");
    expect(prompt).toContain("DATABASE_URL");
    expect(prompt).toContain("API_KEY");

    // Project docs section
    expect(prompt).toContain("Project Documentation");
    expect(prompt).toContain("Source: CONTRIBUTING.md");
    expect(prompt).toContain("# How to contribute");
  });

  it("omits new sections when fields are empty/null", () => {
    const analysis = emptyAnalysis();
    analysis.stack.language = "TypeScript";

    const prompt = generatePlaybookPrompt(null, null, analysis);

    expect(prompt).not.toContain("Linter/Formatter Configuration");
    expect(prompt).not.toContain("Import Aliases");
    expect(prompt).not.toContain("CI/CD Workflows");
    expect(prompt).not.toContain("Required Environment Variables");
    expect(prompt).not.toContain("Project Documentation");
  });

  it("includes linter section but omits others when only linter is set", () => {
    const analysis = emptyAnalysis();
    analysis.linterConfig = {
      tool: "Prettier",
      configPath: ".prettierrc",
      content: '{ "semi": false }',
    };

    const prompt = generatePlaybookPrompt(null, null, analysis);

    expect(prompt).toContain("Linter/Formatter Configuration");
    expect(prompt).toContain("Tool: Prettier");
    expect(prompt).not.toContain("Import Aliases");
    expect(prompt).not.toContain("CI/CD Workflows");
    expect(prompt).not.toContain("Required Environment Variables");
    expect(prompt).not.toContain("Project Documentation");
  });
});
