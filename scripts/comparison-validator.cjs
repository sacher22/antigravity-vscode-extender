const PATHS = ['native', 'stream', 'sidebar'];
const SCENES = ['short', 'read', 'tool'];
const TEMPS = ['cold', 'warm'];
const METRICS = {
  native: 'submit-to-visible',
  stream: 'submit-to-first-response-event',
  sidebar: 'submit-to-visible'
};
const REQUIRED_CONFIG = {
  model: 'gemini-3.8-flash-high',
  effort: 'high',
  permission: 'Danger'
};
const STR_KEYS = ['launcherIdentity', 'cliVersion', 'binaryHash', 'workspace', 'interfaceFingerprint'];
const CFG_KEYS = ['model', 'effort', 'permission', ...STR_KEYS];

function validateComparison(rows) {
  if (!Array.isArray(rows) || rows.length !== 90) throw new Error('Malformed rows array');
  const groupsMap = new Map();
  for (const p of PATHS) {
    for (const s of SCENES) {
      for (const t of TEMPS) {
        groupsMap.set(`${p}|${s}|${t}`, {
          path: p,
          scene: s,
          temperature: t,
          samples: 0,
          passed: 0,
          failed: 0,
          durations: [],
          indices: new Set()
        });
      }
    }
  }
  let allPassed = true;
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Malformed row');
    if (!PATHS.includes(row.path) || !SCENES.includes(row.scene) || !TEMPS.includes(row.temperature)) throw new Error('Malformed combination');
    const group = groupsMap.get(`${row.path}|${row.scene}|${row.temperature}`);
    if (!group) throw new Error('Malformed combination');
    if (!Number.isInteger(row.index) || row.index < 1 || row.index > 5 || group.indices.has(row.index)) {
      throw new Error('Malformed index');
    }
    group.indices.add(row.index);
    if (row.status !== 'passed' && row.status !== 'failed') throw new Error('Malformed status');
    if (typeof row.durationMs !== 'number' || !Number.isFinite(row.durationMs) || row.durationMs < 0) {
      throw new Error('Malformed durationMs');
    }
    if (row.metric !== METRICS[row.path]) throw new Error('Malformed metric');
    if (!row.config || typeof row.config !== 'object' || Array.isArray(row.config)) throw new Error('Malformed config');
    for (const [k, v] of Object.entries(REQUIRED_CONFIG)) {
      if (row.config[k] !== v) throw new Error('Malformed config');
    }
    for (const k of STR_KEYS) {
      if (typeof row.config[k] !== 'string' || row.config[k].length === 0) throw new Error('Malformed config');
    }
    for (const k of CFG_KEYS) {
      if (row.config[k] !== rows[0].config[k]) throw new Error('Malformed config');
    }
    group.samples++;
    if (row.status === 'passed') group.passed++;
    else {
      group.failed++;
      allPassed = false;
    }
    group.durations.push(row.durationMs);
  }
  const groups = [];
  for (const g of groupsMap.values()) {
    if (g.samples !== 5) throw new Error('Malformed combination count');
    const sorted = g.durations.slice().sort((a, b) => a - b);
    const p95Ms = sorted[Math.ceil(0.95 * sorted.length) - 1];
    groups.push({
      path: g.path,
      scene: g.scene,
      temperature: g.temperature,
      samples: 5,
      passed: g.passed,
      failed: g.failed,
      p95Ms
    });
  }
  return { success: allPassed, total: rows.length, groups };
}

module.exports = { validateComparison };
