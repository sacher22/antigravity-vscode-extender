import path from "node:path";

export interface ResolveFileReferenceOptions {
  roots: readonly (string | undefined)[];
  home: string;
  platform: NodeJS.Platform;
  exists(path: string): boolean;
  fileUriToPath(uri: string): string;
}

export function resolveFileReference(
  href: string,
  options: ResolveFileReferenceOptions,
): {
  filePath?: string;
  line?: number;
  column?: number;
} {
  const paths = options.platform === "win32" ? path.win32 : path.posix;
  let value = href.trim();
  let line: number | undefined;
  let column: number | undefined;
  const lineMatch = value.match(/(?:#L|:)(\d+)(?:(?::|C)(\d+))?$/i);
  if (lineMatch) {
    line = Number(lineMatch[1]);
    column = lineMatch[2] ? Number(lineMatch[2]) : undefined;
    value = value.slice(0, lineMatch.index);
  }

  const fileUri = value.startsWith("file://");
  if (!fileUri && /^[a-z][a-z\d+.-]*:/i.test(value) && !/^[A-Za-z]:[\\/]/.test(value))
    throw new Error("不支持此链接类型");
  if (fileUri) {
    // URI parsing decodes its path once. Encoded #/: belong to the filename,
    // whereas only an explicit raw suffix above selects a line/column.
    value = options.fileUriToPath(value);
    if (options.platform !== "win32" && /^\/[A-Za-z]:[\\/]/.test(value))
      value = value.slice(1);
  } else {
    try { value = decodeURIComponent(value); }
    catch { /* Literal percent in a filename. */ }
  }
  // CLI output in WSL may still contain Windows paths.
  if (options.platform !== "win32" && /^[A-Za-z]:[\\/]/.test(value))
    value = `/mnt/${value[0].toLowerCase()}/${value.slice(3).replace(/\\/g, "/")}`;
  if (value.startsWith("~/")) value = paths.join(options.home, value.slice(2));
  if (paths.isAbsolute(value))
    return {
      filePath: paths.normalize(value),
      line,
      ...(column === undefined ? {} : { column }),
    };

  const roots = options.roots.filter(
    (root, index, all): root is string =>
      Boolean(root) && all.indexOf(root) === index,
  );
  for (const root of roots) {
    const candidate = paths.resolve(root, value);
    if (options.exists(candidate))
      return {
        filePath: candidate,
        line,
        ...(column === undefined ? {} : { column }),
      };
  }
  const root = roots[0];
  return {
    filePath: root ? paths.resolve(root, value) : undefined,
    line,
    ...(column === undefined ? {} : { column }),
  };
}
