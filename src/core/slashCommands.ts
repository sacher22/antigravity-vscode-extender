import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { SlashCommandItem } from "./types";

export class SlashCommandResolver {
  private static cachedItems: SlashCommandItem[] | null = null;

  public static async getAvailableItems(workspaceRoot?: string): Promise<SlashCommandItem[]> {
    if (this.cachedItems) {
      return this.cachedItems;
    }

    const items: SlashCommandItem[] = [
      // Common & Control Commands
      {
        command: "/plan",
        label: "Plan mode",
        description: "Turn plan mode on (switch execution mode to planning)",
        icon: "💡",
        category: "Mode",
        isMode: true
      },
      {
        command: "/status",
        label: "Status",
        description: "Show chat ID, context usage, and rate limits",
        icon: "⏱️",
        category: "General"
      },
      {
        command: "/mcp",
        label: "MCP",
        description: "Show MCP server status & connections",
        icon: "🔌",
        category: "General"
      },
      {
        command: "/skills",
        label: "Skills",
        description: "List all discovered skills in workspace and system",
        icon: "📦",
        category: "General"
      },
      {
        command: "/clear",
        label: "Clear",
        description: "Clear conversation history in current session",
        icon: "🧹",
        category: "General"
      },
      {
        command: "/help",
        label: "Help",
        description: "Show general help and available commands",
        icon: "❓",
        category: "General"
      }
    ];

    // Scan skills from standard locations
    const skillRoots: { dir: string; origin: string }[] = [
      { dir: path.join(os.homedir(), ".gemini", "antigravity-cli", "builtin", "skills"), origin: "System" },
      { dir: path.join(os.homedir(), ".codex", "skills", ".system"), origin: "System" },
      { dir: path.join(os.homedir(), ".codex", "skills"), origin: "Personal" },
      { dir: path.join(os.homedir(), ".agents", "skills"), origin: "Personal" }
    ];

    if (workspaceRoot) {
      skillRoots.push({
        dir: path.join(workspaceRoot, ".agents", "skills"),
        origin: "Workspace"
      });
      skillRoots.push({
        dir: path.join(workspaceRoot, ".skills"),
        origin: "Workspace"
      });
    }

    const seenSkills = new Set<string>();

    for (const root of skillRoots) {
      try {
        if (!fs.existsSync(root.dir)) {
          continue;
        }
        const entries = fs.readdirSync(root.dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith(".")) {
            continue;
          }
          const skillDir = path.join(root.dir, entry.name);
          const skillFile = path.join(skillDir, "SKILL.md");
          if (!fs.existsSync(skillFile)) {
            continue;
          }

          const skillName = entry.name;
          if (seenSkills.has(skillName)) {
            continue;
          }
          seenSkills.add(skillName);

          const { name, description } = this.parseSkillMd(skillFile, skillName);
          items.push({
            command: `/${skillName}`,
            label: name,
            description: description,
            icon: "📦",
            category: "Skills",
            origin: root.origin
          });
        }
      } catch {
        // ignore read error
      }
    }

    this.cachedItems = items;
    return items;
  }

  private static parseSkillMd(filePath: string, fallbackName: string): { name: string; description: string } {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      let name = fallbackName;
      let description = `Skill: ${fallbackName}`;

      // Check YAML frontmatter: --- name: ... description: ... ---
      if (content.startsWith("---")) {
        const parts = content.split("---");
        if (parts.length >= 3) {
          const frontmatter = parts[1];
          const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
          if (nameMatch) {
            name = nameMatch[1].trim().replace(/^["']|["']$/g, "");
          }
          const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
          if (descMatch) {
            description = descMatch[1].trim().replace(/^["']|["']$/g, "");
          }
          return { name, description };
        }
      }

      // Fallback: search # Heading and first paragraph
      const lines = content.split("\n");
      for (const line of lines) {
        if (line.startsWith("# ") && name === fallbackName) {
          name = line.replace("# ", "").trim();
        } else if (line.trim().length > 15 && !line.startsWith("#") && description.startsWith("Skill:")) {
          description = line.trim();
          break;
        }
      }

      return { name, description };
    } catch {
      return { name: fallbackName, description: `Skill: ${fallbackName}` };
    }
  }
}
