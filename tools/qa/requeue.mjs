// Refresh a still-queued QA request from its suite file (keeps its queue position / id).
// Usage: node tools/qa/requeue.mjs <request-id> <suite.json>
import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const [id, suite] = process.argv.slice(2);
const p = path.join(ROOT, 'tools/qa/requests', id + '.json');
if (!fs.existsSync(p)) { console.log('not queued (already running/done):', id); process.exit(1); }
const old = JSON.parse(fs.readFileSync(p, 'utf8'));
const rd = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const inc = (f) => { const [file, as] = f.split(':'); return as ? `${as} = () => (${rd(file)});` : rd(file); };
const job = JSON.parse(rd(suite));
if (job.setupFiles) { job.setup = job.setupFiles.map(inc).join('\n;\n') + '\n;\n' + (job.setup || ''); delete job.setupFiles; }
if (job.scriptFile) { job.script = rd(job.scriptFile); delete job.scriptFile; }
job.owner = old.owner; job.id = old.id;
fs.writeFileSync(p + '.tmp', JSON.stringify(job)); fs.renameSync(p + '.tmp', p);
console.log('requeued', id);
