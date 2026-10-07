import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export class BinaryResolver {
  public static async resolveCliPath(configuredPath?: string): Promise<string> {
    if (configuredPath && configuredPath.trim().length > 0) {
      const expanded = this.expandHome(configuredPath.trim());
      if (fs.existsSync(expanded)) {
        return expanded;
      }
      throw new Error(
        `Configured Antigravity CLI path does not exist: ${configuredPath}`,
      );
    }

    // Common standard paths
    const home = os.homedir();
    const isWindows = process.platform === "win32";
    const binaryName = isWindows ? "agy.exe" : "agy";

    const candidatePaths = [
      path.join(home, ".local", "bin", binaryName),
      path.join("/usr", "local", "bin", binaryName),
      path.join("/usr", "bin", binaryName),
      path.join(home, "bin", binaryName),
    ];

    for (const candidate of candidatePaths) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    // Try finding in PATH
    try {
      const whichCmd = isWindows ? "where" : "which";
      const { stdout } = await execFileAsync(whichCmd, [binaryName]);
      const foundPath = stdout.split(/\r?\n/)[0]?.trim();
      if (foundPath && fs.existsSync(foundPath)) {
        return foundPath;
      }
    } catch {
      // Ignored
    }

    throw new Error(
      `Could not find Antigravity CLI ("agy") binary. Please install Antigravity CLI or specify its path in settings ("antigravity.cliPath").`,
    );
  }

  private static expandHome(filePath: string): string {
    if (filePath.startsWith("~/") || filePath === "~") {
      return path.join(os.homedir(), filePath.slice(1));
    }
    return filePath;
  }
}
