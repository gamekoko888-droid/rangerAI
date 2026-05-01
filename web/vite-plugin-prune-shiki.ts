/**
 * vite-plugin-prune-shiki — 瘦身 Shiki 语言/主题包
 *
 * streamdown 通过 `import {bundledLanguages,createHighlighter} from 'shiki'`
 * 导入全部 200+ 种语言和 50+ 主题。
 *
 * 本插件拦截 shiki/dist/langs.mjs 和 shiki/dist/themes.mjs，
 * 替换为仅包含常用 20+ 语言的子集，阻止 Vite 为未使用语言生成 chunk。
 *
 * 预期收益: dist 减少 3-5MB
 */

import type { Plugin } from 'vite';

// ─── 常用语言条目（从 shiki 3.14.0 langs.mjs 提取） ─────────────────────

const PRUNED_LANGS_ENTRIES = [
  { id: "c", name: "C", import: "c" },
  { id: "cpp", name: "C++", aliases: ["c++"], import: "cpp" },
  { id: "css", name: "CSS", import: "css" },
  { id: "diff", name: "Diff", import: "diff" },
  { id: "docker", name: "Dockerfile", aliases: ["dockerfile"], import: "docker" },
  { id: "dotenv", name: "dotEnv", import: "dotenv" },
  { id: "git-commit", name: "Git Commit Message", import: "git-commit" },
  { id: "go", name: "Go", import: "go" },
  { id: "graphql", name: "GraphQL", aliases: ["gql"], import: "graphql" },
  { id: "html", name: "HTML", import: "html" },
  { id: "http", name: "HTTP", import: "http" },
  { id: "ini", name: "INI", aliases: ["properties"], import: "ini" },
  { id: "java", name: "Java", import: "java" },
  { id: "javascript", name: "JavaScript", aliases: ["js", "cjs", "mjs"], import: "javascript" },
  { id: "json", name: "JSON", import: "json" },
  { id: "json5", name: "JSON5", import: "json5" },
  { id: "jsonc", name: "JSON with Comments", import: "jsonc" },
  { id: "jsonl", name: "JSON Lines", import: "jsonl" },
  { id: "jsx", name: "JSX", import: "jsx" },
  { id: "less", name: "Less", import: "less" },
  { id: "markdown", name: "Markdown", aliases: ["md"], import: "markdown" },
  { id: "mdx", name: "MDX", import: "mdx" },
  { id: "python", name: "Python", aliases: ["py"], import: "python" },
  { id: "ruby", name: "Ruby", aliases: ["rb"], import: "ruby" },
  { id: "rust", name: "Rust", aliases: ["rs"], import: "rust" },
  { id: "scss", name: "SCSS", import: "scss" },
  { id: "shellscript", name: "Shell", aliases: ["bash", "sh", "shell", "zsh"], import: "shellscript" },
  { id: "sql", name: "SQL", import: "sql" },
  { id: "toml", name: "TOML", import: "toml" },
  { id: "tsx", name: "TSX", import: "tsx" },
  { id: "typescript", name: "TypeScript", aliases: ["ts", "cts", "mts"], import: "typescript" },
  { id: "xml", name: "XML", import: "xml" },
  { id: "yaml", name: "YAML", aliases: ["yml"], import: "yaml" },
];

// ─── 常用主题条目（从 shiki 3.14.0 themes.mjs 提取） ──────────────────────

const PRUNED_THEMES_ENTRIES = [
  { id: "github-light", displayName: "GitHub Light", type: "light", import: "github-light" },
  { id: "github-dark", displayName: "GitHub Dark", type: "dark", import: "github-dark" },
  { id: "one-dark-pro", displayName: "One Dark Pro", type: "dark", import: "one-dark-pro" },
  { id: "one-light", displayName: "One Light", type: "light", import: "one-light" },
];

// ─── 代码生成 ────────────────────────────────────────────────────────────

function generatePrunedLangs(): string {
  const entries = PRUNED_LANGS_ENTRIES.map((e) => {
    const aliasesPart = e.aliases?.length
      ? `\n    "aliases": ${JSON.stringify(e.aliases)},`
      : "";
    return `  {
    "id": ${JSON.stringify(e.id)},
    "name": ${JSON.stringify(e.name)},${aliasesPart}
    "import": (() => import(${JSON.stringify(`@shikijs/langs/${e.import}`)}))
  }`;
  });

  return `const bundledLanguagesInfo = [
${entries.join(",\n")}
];
const bundledLanguagesBase = Object.fromEntries(bundledLanguagesInfo.map((i) => [i.id, i.import]));
const bundledLanguagesAlias = Object.fromEntries(bundledLanguagesInfo.flatMap((i) => i.aliases?.map((a) => [a, i.import]) || []));
const bundledLanguages = {
  ...bundledLanguagesBase,
  ...bundledLanguagesAlias
};

export { bundledLanguages, bundledLanguagesAlias, bundledLanguagesBase, bundledLanguagesInfo };
`;
}

function generatePrunedThemes(): string {
  const entries = PRUNED_THEMES_ENTRIES.map(
    (e) => `  {
    "id": ${JSON.stringify(e.id)},
    "displayName": ${JSON.stringify(e.displayName)},
    "type": ${JSON.stringify(e.type)},
    "import": (() => import(${JSON.stringify(`@shikijs/themes/${e.import}`)}))
  }`
  );

  return `const bundledThemesInfo = [
${entries.join(",\n")}
];
const bundledThemes = Object.fromEntries(bundledThemesInfo.map((i) => [i.id, i.import]));

export { bundledThemes, bundledThemesInfo };
`;
}

// ─── Vite 插件 ────────────────────────────────────────────────────────────

export function vitePluginPruneShiki(): Plugin {
  return {
    name: "prune-shiki",
    enforce: "pre", // 在其他插件之前运行

    transform(code, id) {
      // 拦截 shiki/dist/langs.mjs（包括 .pnpm 路径）
      if (id.includes("shiki") && id.endsWith("/dist/langs.mjs")) {
        this.info(`prune-shiki: replacing langs.mjs (${(code.length / 1024).toFixed(0)}KB → ~2KB)`);
        return {
          code: generatePrunedLangs(),
          map: null,
        };
      }

      // 拦截 shiki/dist/themes.mjs（包括 .pnpm 路径）
      if (id.includes("shiki") && id.endsWith("/dist/themes.mjs")) {
        this.info(`prune-shiki: replacing themes.mjs (${(code.length / 1024).toFixed(0)}KB → ~0.5KB)`);
        return {
          code: generatePrunedThemes(),
          map: null,
        };
      }

      return null;
    },
  };
}
