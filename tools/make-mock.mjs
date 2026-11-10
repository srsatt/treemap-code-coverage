// Writes an Istanbul coverage-summary.json from the seeded data of the design reference.
// Usage: unzip -p "reference/Coverage map-html.zip" Main.dc.html > /tmp/Main.dc.html
//        node tools/make-mock.mjs /tmp/Main.dc.html mock/coverage-summary.json
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';

const [input, output = 'mock/coverage-summary.json'] = process.argv.slice(2);
if (!input) {
  console.error('Usage: node tools/make-mock.mjs <Main.dc.html> [out]');
  process.exit(1);
}

const html = readFileSync(input, 'utf8');
const script = /<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
if (!script) throw new Error('No design component script found.');
const Component = new Function(`class DCLogic {}\n${script}\nreturn Component;`)();
const {map} = new Component().data();

const metric = ([covered, total]) => ({total, covered, skipped: 0, pct: total === 0 ? 100 : Math.round((covered / total) * 10000) / 100});
const entry = s => ({lines: metric(s.ln), statements: metric(s.st), functions: metric(s.fn), branches: metric(s.br)});

const files = [...map.values()].filter(node => !node.dir);
const sum = key => files.reduce((acc, f) => [acc[0] + f.s[key][0], acc[1] + f.s[key][1]], [0, 0]);
const report = {total: entry({ln: sum('ln'), st: sum('st'), fn: sum('fn'), br: sum('br')})};
for (const file of files) report[`/frontend/${file.path}`] = entry(file.s);

mkdirSync(path.dirname(output), {recursive: true});
writeFileSync(output, `${JSON.stringify(report, null, 1)}\n`);
console.log(`${files.length} files -> ${output}`);
