#!/usr/bin/env node
/**
 * generate-api-docs.mjs — Auto-generate API documentation from Schema Registries
 * 
 * Reads IPC and HTTP schemas, introspects Zod v4 shapes, and outputs Markdown.
 * Usage: node generate-api-docs.mjs > docs/api-reference.md
 */
import { IPC_SCHEMA_REGISTRY } from "./lib/schemas/ipc-schemas.mjs";
import { HTTP_SCHEMA_REGISTRY } from "./lib/schemas/http-schemas.mjs";

/**
 * Extract type info from a Zod v4 schema field
 */
function getFieldInfo(zodField) {
  const def = zodField._def;
  if (!def) return { type: "unknown", required: true, description: "" };

  let type = def.type || "unknown";
  let required = true;
  let description = "";
  let enumValues = null;
  let innerType = null;

  // Unwrap optional/default
  if (type === "optional" || type === "default") {
    required = false;
    if (def.innerType) {
      const inner = getFieldInfo(def.innerType);
      type = inner.type;
      enumValues = inner.enumValues;
      innerType = inner.innerType;
      if (def.type === "default" && def.defaultValue !== undefined) {
        const dv = typeof def.defaultValue === "function" ? def.defaultValue() : def.defaultValue;
        description = `default: \`${JSON.stringify(dv)}\``;
      }
    }
  }

  // Handle enums
  if (type === "enum" && def.entries) {
    enumValues = Object.keys(def.entries);
  } else if (type === "enum" && def.values) {
    enumValues = def.values;
  }

  // Handle arrays
  if (type === "array" && def.element) {
    const elemInfo = getFieldInfo(def.element);
    innerType = elemInfo.type;
  }

  // Handle nullable
  if (type === "nullable" && def.innerType) {
    const inner = getFieldInfo(def.innerType);
    type = inner.type + " | null";
    enumValues = inner.enumValues;
  }

  return { type, required, description, enumValues, innerType };
}

function schemaToMarkdownTable(zodSchema) {
  if (!zodSchema || !zodSchema.shape) return "_(no properties)_\n";
  
  let md = "";
  md += "| Field | Type | Required | Notes |\n";
  md += "|-------|------|----------|-------|\n";
  
  for (const [key, field] of Object.entries(zodSchema.shape)) {
    const info = getFieldInfo(field);
    let typeStr = info.type;
    if (info.enumValues) {
      typeStr = info.enumValues.map(v => `\`${v}\``).join(" / ");
    }
    if (info.type === "array") {
      typeStr = `array<${info.innerType || "any"}>`;
    }
    
    const reqStr = info.required ? "✓" : "";
    const checks = field._def?.checks || [];
    let notes = info.description;
    for (const c of checks) {
      if (c.kind === "min_length" || c.constructor?.name?.includes("MinLength")) {
        const val = c.minimum ?? c.value;
        if (val) notes += (notes ? ", " : "") + `min: ${val}`;
      }
      if (c.kind === "max_length" || c.constructor?.name?.includes("MaxLength")) {
        const val = c.maximum ?? c.value;
        if (val) notes += (notes ? ", " : "") + `max: ${val}`;
      }
    }
    
    md += `| \`${key}\` | ${typeStr} | ${reqStr} | ${notes} |\n`;
  }
  return md;
}

function generateDoc() {
  let md = "";
  md += "# RangerAI API Reference\n\n";
  md += `> Auto-generated from Zod Schema Registries — ${new Date().toISOString().split("T")[0]}\n\n`;
  md += "---\n\n";

  // ─── HTTP API ───
  md += "## 1. HTTP API Schemas\n\n";
  md += "These schemas validate request bodies for all write (POST/PUT/PATCH/DELETE) endpoints.\n\n";
  
  const httpGroups = {};
  for (const [name, schema] of Object.entries(HTTP_SCHEMA_REGISTRY)) {
    const [group] = name.split(".");
    if (!httpGroups[group]) httpGroups[group] = [];
    httpGroups[group].push({ name, schema });
  }

  for (const [group, entries] of Object.entries(httpGroups)) {
    md += `### 1.${Object.keys(httpGroups).indexOf(group) + 1} ${group.charAt(0).toUpperCase() + group.slice(1)}\n\n`;
    for (const { name, schema } of entries) {
      md += `#### \`${name}\`\n\n`;
      md += schemaToMarkdownTable(schema);
      md += "\n";
    }
  }

  // ─── IPC API ───
  md += "---\n\n";
  md += "## 2. IPC Message Schemas\n\n";
  md += "These schemas validate messages between the Main Process and Worker Process via Node.js IPC.\n\n";

  md += "### 2.1 Downlink (Main → Worker)\n\n";
  for (const [type, schema] of Object.entries(IPC_SCHEMA_REGISTRY.downlink)) {
    md += `#### \`${type}\`\n\n`;
    md += schemaToMarkdownTable(schema);
    md += "\n";
  }

  md += "### 2.2 Uplink (Worker → Main)\n\n";
  for (const [type, schema] of Object.entries(IPC_SCHEMA_REGISTRY.uplink)) {
    md += `#### \`${type}\`\n\n`;
    md += schemaToMarkdownTable(schema);
    md += "\n";
  }

  // ─── Summary ───
  md += "---\n\n";
  md += "## 3. Summary\n\n";
  md += `| Category | Count |\n`;
  md += `|----------|-------|\n`;
  md += `| HTTP Schemas | ${Object.keys(HTTP_SCHEMA_REGISTRY).length} |\n`;
  md += `| IPC Downlink Schemas | ${Object.keys(IPC_SCHEMA_REGISTRY.downlink).length} |\n`;
  md += `| IPC Uplink Schemas | ${Object.keys(IPC_SCHEMA_REGISTRY.uplink).length} |\n`;
  md += `| **Total** | **${Object.keys(HTTP_SCHEMA_REGISTRY).length + Object.keys(IPC_SCHEMA_REGISTRY.downlink).length + Object.keys(IPC_SCHEMA_REGISTRY.uplink).length}** |\n`;

  return md;
}

const doc = generateDoc();
process.stdout.write(doc);
