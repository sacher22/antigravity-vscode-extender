import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";

export interface SkillItem {
  id: string;
  name: string;
  description: string;
  origin: "Personal" | "System" | "Built-in" | "Workspace";
  path: string;
}

export interface SlashCommandItem {
  command: string;
  label: string;
  description: string;
  icon?: string;
  category: "General" | "Mode" | "Skills";
  origin?: string;
  isMode?: boolean;
}

export class SkillManager {
  public static getBuiltinCommands(): SlashCommandItem[] {
    return [
      {
        command: "/plan",
        label: "Plan mode",
        description: "Turn plan mode on (explore, plan, ask questions before implementing)",
        icon: "💡",
        category: "Mode",
        isMode: true
      },
      {
        command: "/goal",
        label: "Goal",
        description: "Set a concrete goal to keep pursuing",
        icon: "🎯",
        category: "General"
      },
      {
        command: "/ide-context",
        label: "IDE context",
        description: "Include current selection, open files, and other context from your IDE",
        icon: "✨",
        category: "General"
      },
      {
        command: "/mcp",
        label: "MCP",
        description: "Show MCP server status and available tools",
        icon: "🔌",
        category: "General"
      },
      {
        command: "/status",
        label: "Status",
        description: "Show conversation ID, context usage, and token limits",
        icon: "⏱️",
        category: "General"
      },
      {
        command: "/clear",
        label: "Clear",
        description: "Clear conversation turns and start fresh",
        icon: "🧹",
        category: "General"
      },
      {
        command: "/skills",
        label: "Skills",
        description: "List all discovered personal, system, and built-in skills",
        icon: "📦",
        category: "General"
      }
    ];
  }

  public static getDiscoveredSkills(): SkillItem[] {
    const home = os.homedir();
    const searchDirs: { dir: string; origin: "Personal" | "System" | "Built-in" | "Workspace" }[] = [
      { dir: path.join(home, ".codex/skills"), origin: "Personal" },
      { dir: path.join(home, ".codex/skills/.system"), origin: "System" },
      { dir: path.join(home, ".gemini/antigravity-cli/builtin/skills"), origin: "Built-in" },
      { dir: path.join(home, ".gemini/antigravity-cli/skills"), origin: "Personal" }
    ];

    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
      for (const folder of vscode.workspace.workspaceFolders) {
        searchDirs.push(
          { dir: path.join(folder.uri.fsPath, ".agents/skills"), origin: "Workspace" },
          { dir: path.join(folder.uri.fsPath, ".skills"), origin: "Workspace" }
        );
      }
    }

    const results: SkillItem[] = [];
    const seenNames = new Set<string>();

    for (const { dir, origin } of searchDirs) {
      if (!fs.existsSync(dir)) continue;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const ent of entries) {
          if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
          const skillDir = path.join(dir, ent.name);
          const skillFile = path.join(skillDir, "SKILL.md");
          let name = ent.name;
          let description = "";

          if (fs.existsSync(skillFile)) {
            try {
              const content = fs.readFileSync(skillFile, "utf-8");
              const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
              if (match) {
                const fm = match[1];
                const nameM = fm.match(/^name:\s*(.+)$/m);
                const descM = fm.match(/^description:\s*(.+)$/m);
                if (nameM) name = nameM[1].trim().replace(/^["']|["']$/g, "");
                if (descM) description = descM[1].trim().replace(/^["']|["']$/g, "");
              }
            } catch {}
          }

          const uniqueKey = name.toLowerCase();
          if (!seenNames.has(uniqueKey)) {
            seenNames.add(uniqueKey);
            results.push({
              id: ent.name,
              name,
              description: description || "No description provided",
              origin,
              path: skillDir
            });
          }
        }
      } catch {}
    }

    return results;
  }

  public static getAllSlashItems(): SlashCommandItem[] {
    const items: SlashCommandItem[] = [...this.getBuiltinCommands()];
    const skills = this.getDiscoveredSkills();

    for (const s of skills) {
      items.push({
        command: `/${s.id}`,
        label: s.name,
        description: s.description,
        icon: "📦",
        category: "Skills",
        origin: s.origin
      });
    }

    return items;
  }
}
