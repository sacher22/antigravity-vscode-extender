// Adapted from the agy C001 deliverable; archive only, never remove build files.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const inside = (parent, candidate) => {
  const relative = path.relative(parent, candidate);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
const canonical = candidate => {
  let ancestor = candidate;
  const remainder = [];
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error('Cannot resolve output directory');
    remainder.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  return path.join(fs.realpathSync(ancestor), ...remainder);
};
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

try {
  if (!process.argv[2]) throw new Error('Usage: node scripts/archive-debug-symbols.cjs <new-output-dir>');
  const output = path.resolve(process.argv[2]);
  const actualOutput = canonical(output);
  for (const name of ['out', 'media']) {
    const source = path.join(root, name);
    if (fs.lstatSync(source).isSymbolicLink()) throw new Error('Build roots must not be symlinks');
    if (inside(source, output) || inside(fs.realpathSync(source), actualOutput))
      throw new Error('Output directory cannot be inside out/ or media/');
  }
  const {version} = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  fs.mkdirSync(path.dirname(output), {recursive: true, mode: 0o700});
  // Exclusive mkdir also rejects a destination created after validation.
  fs.mkdirSync(output, {mode: 0o700});
  const files = {};
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const source = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {visit(source); continue;}
      if (!entry.isFile() || !entry.name.endsWith('.map')) continue;
      const relative = path.relative(root, source).split(path.sep).join('/');
      const target = path.join(output, relative);
      fs.mkdirSync(path.dirname(target), {recursive: true, mode: 0o700});
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(target, 0o600);
      const sourceHash = hash(source), sha256 = hash(target);
      if (sourceHash !== sha256) throw new Error('Build changed during symbol capture');
      const js = source.slice(0, -4);
      const jsStat = fs.existsSync(js) ? fs.lstatSync(js) : undefined;
      files[relative] = {sha256, size: fs.statSync(target).size,
        ...(jsStat?.isFile() && !jsStat.isSymbolicLink() ? {jsSha256: hash(js)} : {})};
    }
  };
  visit(path.join(root, 'out'));
  visit(path.join(root, 'media'));
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({packageVersion: version, files}, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
  console.log(JSON.stringify({output, files: Object.keys(files).length}));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
