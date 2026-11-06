/**
 * Post-process compiled client JS so dynamic imports carry ?v=ts5 cache busters.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');
const VERSION = 'ts6';

for (const file of ['app.js', 'pipeline3d.js', 'cosine3d.js']) {
  const fp = path.join(publicDir, file);
  if (!fs.existsSync(fp)) continue;
  let src = fs.readFileSync(fp, 'utf8');
  src = src
    .replace(
      /from\s+(['"])\.\/pipeline3d\.js(?:\?v=[^'"]*)?\1/g,
      `from $1./pipeline3d.js?v=${VERSION}$1`,
    )
    .replace(
      /from\s+(['"])\.\/cosine3d\.js(?:\?v=[^'"]*)?\1/g,
      `from $1./cosine3d.js?v=${VERSION}$1`,
    );
  fs.writeFileSync(fp, src);
  console.log(`cachebust: ${file}`);
}
