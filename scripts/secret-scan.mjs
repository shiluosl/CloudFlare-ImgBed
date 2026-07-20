import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve('.');
const include = ['functions', 'deploy', 'scripts', '.github', 'database'];
const ignored = new Set(['node_modules', '.wrangler', 'frontend-dist']);
const patterns = [
  { name: 'Telegram bot token', re: /\b\d{7,}:[A-Za-z0-9_-]{30,}\b/ },
  { name: 'Cloudflare API token', re: /\b(?:cf|CF)[A-Za-z0-9_-]{35,}\b/ },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'private key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];
const findings = [];

for (const start of include) scan(join(root, start));
if (findings.length) {
  console.error(findings.join('\n'));
  process.exit(1);
}
console.log('Secret scan passed. No credential-shaped values were found in deployment code or configuration.');

function scan(path) {
  if (!statSync(path).isDirectory()) return;
  for (const entry of readdirSync(path)) {
    if (ignored.has(entry)) continue;
    const full = join(path, entry);
    if (statSync(full).isDirectory()) scan(full);
    else if (/\.(?:js|mjs|yml|yaml|toml|sql)$/i.test(entry)) inspect(full);
  }
}

function inspect(file) {
  const text = readFileSync(file, 'utf8');
  for (const pattern of patterns) if (pattern.re.test(text)) findings.push(`${pattern.name}: ${relative(root, file)}`);
}
