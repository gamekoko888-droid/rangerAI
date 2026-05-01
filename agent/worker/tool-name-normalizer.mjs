const TOOL_NAME_MAP = {
  browser: 'browser_navigate',
  exec: 'shell_exec',
  code: 'shell_exec',
  write_file: 'file_write',
  edit_file: 'file_edit',
  read_file: 'file_read',
  grep: 'file_search',
  glob: 'file_glob',
  web_search: 'web_search',
  web_fetch: 'web_fetch',
};

export function normalizeToolName(rawName) {
  if (!rawName) return 'unknown';
  const name = String(rawName).trim();
  return TOOL_NAME_MAP[name] || name;
}

export { TOOL_NAME_MAP };
