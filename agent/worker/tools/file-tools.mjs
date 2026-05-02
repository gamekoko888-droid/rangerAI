import fs from "fs/promises";
import path from "path";
import { getOrCreateWorkspace } from "../workspace-manager.mjs";

async function resolveSafe(sessionKey, relPath) {
  if (!relPath || relPath.includes("..") || path.isAbsolute(relPath)) throw new Error("invalid path");
  const workspace = await getOrCreateWorkspace(sessionKey);
  const full = path.resolve(workspace, relPath);
  if (!full.startsWith(path.resolve(workspace))) throw new Error("path escape");
  return { workspace, full };
}

export async function fileRead(sessionKey, filePath, startLine, endLine) {
  const { full } = await resolveSafe(sessionKey, filePath);
  const content = await fs.readFile(full, "utf8");
  if (!startLine) return content;
  const lines = content.split("\n");
  return lines.slice(startLine - 1, endLine || startLine).join("\n");
}

export async function fileWrite(sessionKey, filePath, content) {
  const { full } = await resolveSafe(sessionKey, filePath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf8");
  return { success: true, bytesWritten: Buffer.byteLength(content || "") };
}
export async function fileAppend(sessionKey, filePath, content) {
  const { full } = await resolveSafe(sessionKey, filePath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.appendFile(full, content, "utf8");
  return { success: true, bytesWritten: Buffer.byteLength(content || "") };
}
export async function fileEdit(sessionKey, filePath, edits=[]) {
  let content = await fileRead(sessionKey, filePath);
  let replacements = 0;
  for (const e of edits) {
    if (e.all) {
      const parts = content.split(e.find);
      replacements += Math.max(0, parts.length - 1);
      content = parts.join(e.replace);
    } else if (content.includes(e.find)) {
      content = content.replace(e.find, e.replace); replacements += 1;
    }
  }
  await fileWrite(sessionKey, filePath, content);
  return { success: true, replacements };
}
async function walkFiles(dir, base, out=[]) {
  const ents = await fs.readdir(dir, { withFileTypes: true });
  for (const e of ents){ const full=path.join(dir,e.name); const rel=path.relative(base, full); if(e.isSymbolicLink()) continue; if(e.isDirectory()) await walkFiles(full, base, out); else if(e.isFile()){ const st=await fs.stat(full); out.push({name:rel,size:st.size,modified:st.mtime.toISOString()}); }}
  return out;
}

export async function fileList(sessionKey) {
  const workspace = await getOrCreateWorkspace(sessionKey);
  return walkFiles(workspace, workspace, []);
}
export async function fileGrep(sessionKey, regex) {
  const workspace = await getOrCreateWorkspace(sessionKey);
  const re = new RegExp(regex, "g");
  const out=[];
  for (const f of await walkFiles(workspace, workspace, [])){ const full=path.join(workspace,f.name); const lines=(await fs.readFile(full,'utf8')).split('\n'); lines.forEach((line,i)=>{ const m=[...line.matchAll(re)]; m.forEach(mm=>out.push({file:f.name,line:i+1,match:mm[0],context:line}));});}
  return out;
}
export async function fileDelete(sessionKey, filePath) { const { full } = await resolveSafe(sessionKey, filePath); await fs.rm(full, { force:true }); return { success:true }; }
