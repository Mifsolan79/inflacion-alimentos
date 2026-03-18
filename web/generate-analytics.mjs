import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAnalyticsFromSnapshots,
  parseCsvLine,
  parseNumber,
} from './analytics-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const publicDataDir = path.resolve(__dirname, 'public', 'data');
const outputFile = path.join(publicDataDir, 'mercadona-analytics.json');
const csvPattern = /^Precios MERCADONA (\d{2})-(\d{2})-(\d{4})\.csv$/;

function parseIsoDateFromFilename(filename) {
  const match = filename.match(csvPattern);
  if (!match) return null;
  const [, day, month, year] = match;
  return `${year}-${month}-${day}`;
}

function readSnapshots() {
  const files = fs
    .readdirSync(repoRoot)
    .filter((name) => csvPattern.test(name))
    .sort((left, right) =>
      parseIsoDateFromFilename(left).localeCompare(parseIsoDateFromFilename(right)),
    );

  return files.map((filename) => {
    const filePath = path.join(repoRoot, filename);
    const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/).filter(Boolean);
    const header = parseCsvLine(lines[0]);
    const rows = new Map();

    for (let index = 1; index < lines.length; index += 1) {
      const values = parseCsvLine(lines[index]);
      const row = Object.fromEntries(header.map((key, keyIndex) => [key, values[keyIndex] ?? '']));
      const id = Number(row.ID);

      if (!Number.isFinite(id)) continue;

      rows.set(id, {
        id,
        name: String(row.Nombre || '').trim(),
        format: String(row.Formato || '').trim(),
        price: parseNumber(row.Precio),
        referencePrice: parseNumber(row['Precio Referencia']),
        url: String(row['URL Producto'] || '').trim(),
        image: String(row.Imagen || '').trim(),
        weighted: String(row.Pesado || '').trim().toLowerCase() === 'true',
      });
    }

    return {
      filename,
      date: parseIsoDateFromFilename(filename),
      rows,
      count: rows.size,
    };
  });
}

function main() {
  const snapshots = readSnapshots();
  const analytics = buildAnalyticsFromSnapshots(snapshots);
  fs.mkdirSync(publicDataDir, { recursive: true });
  fs.writeFileSync(outputFile, `${JSON.stringify(analytics, null, 2)}\n`, 'utf8');
  console.log(`Analitica generada en ${outputFile}`);
}

main();
