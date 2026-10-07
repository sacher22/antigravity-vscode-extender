const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
try {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (!manifest.files?.length || manifest.files.some(pattern => pattern.startsWith('!')))
    throw new Error('Use positive package files patterns; negative patterns expand the vsce allowlist');
  const cli = path.join(path.dirname(require.resolve('@vscode/vsce/package.json')), 'vsce');
  const result = spawnSync(process.execPath, [cli, 'ls', '--no-dependencies'], {
    cwd: root, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error('vsce file discovery failed');
  const files = new Set(result.stdout.trim().split(/\r?\n/).filter(Boolean));
  const allowed = /^(?:package\.json|README\.md|LICENSE|out\/(?:extension\.js|(?:adapters|commands|conversation|core|services|ui)\/.+\.js)|media\/chat\.(?:js|css)|resources\/.+\.(?:png|svg)|docs\/.+\.md)$/;
  for (const file of files) {
    if (!allowed.test(file) || file.endsWith('.map') || file.startsWith('out/webview/'))
      throw new Error('Unexpected release file: ' + file);
  }
  const host = [];
  const visit = folder => {
    for (const entry of fs.readdirSync(folder, {withFileTypes: true})) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (file !== path.join(root, 'out/webview')) visit(file);
      } else if (entry.isFile() && entry.name.endsWith('.js')) host.push(path.relative(root, file).split(path.sep).join('/'));
    }
  };
  visit(path.join(root, 'out'));
  for (const file of [...host, 'media/chat.js', 'media/chat.css', manifest.icon])
    if (!files.has(file)) throw new Error('Required runtime file excluded: ' + file);
  if (!host.length) throw new Error('No Host modules found; compile before packaging');
  console.log(JSON.stringify({files: files.size, hostModules: host.length, sourcemaps: 0, browserDuplicates: 0}));
} catch (error) {console.error(error.message); process.exitCode = 1;}
