// Submit a QA job to the shared runner and wait for its result.
// Usage: node tools/qa/submit.mjs <owner> <job.json | inline JSON>
//   job = { views:[{name,pos,yaw,pitch,weapon,ads,fire,reload,sprint,forward,keys,release,frames,eval,read,shot}],
//           match:'tdm'|'ffa'|false, setup:'js', script:'async js expr', w, h, verbose }
// Prints result.json (screenshot paths, console errors, data) when done.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const [owner = 'anon', spec = '{}'] = process.argv.slice(2);
const job = JSON.parse(fs.existsSync(spec) ? fs.readFileSync(spec, 'utf8') : spec);
job.owner = owner;
job.id = `${Date.now()}_${owner.replace(/\W/g, '')}`;
const req = path.join(ROOT, 'tools/qa/requests');
fs.mkdirSync(req, { recursive: true });
fs.writeFileSync(path.join(req, job.id + '.json.tmp'), JSON.stringify(job));
fs.renameSync(path.join(req, job.id + '.json.tmp'), path.join(req, job.id + '.json'));
const out = path.join(ROOT, 'tools/qa/results', job.id, 'result.json');
const t0 = Date.now();
const timeoutMs = +(process.env.QA_TIMEOUT || 1500000);
while (!fs.existsSync(out)) {
  if (Date.now() - t0 > timeoutMs) { console.log('timeout waiting for QA runner (is `node tools/qa/runner.mjs` running?)'); process.exit(1); }
  const queued = fs.readdirSync(req).filter((f) => f.endsWith('.json')).length;
  if ((Date.now() - t0) % 60000 < 2000) console.log(`waiting… ${queued} job(s) queued`);
  await new Promise((r) => setTimeout(r, 2000));
}
console.log(fs.readFileSync(out, 'utf8'));
