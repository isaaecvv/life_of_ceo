// Собирает интерфейс (web/ui.html) в одну строку со встроенными шрифтами.
// Результат: src/webHtml.ts (для приложения) и web/dist/index.html (для просмотра в браузере).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fontsDir = join(root, 'web', 'fonts');

const RANGES = {
  cyrillic: 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116',
  latin: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+20BD,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
};
const FAMILIES = [
  ['Unbounded', 'unbounded', [500, 700, 800]],
  ['Manrope', 'manrope', [400, 500, 600, 700]],
];

let css = '';
for (const [family, file, weights] of FAMILIES) {
  for (const w of weights) {
    for (const subset of ['cyrillic', 'latin']) {
      const b64 = readFileSync(join(fontsDir, `${file}-${subset}-${w}-normal.woff2`)).toString('base64');
      css += `@font-face{font-family:'${family}';font-style:normal;font-weight:${w};font-display:block;src:url(data:font/woff2;base64,${b64}) format('woff2');unicode-range:${RANGES[subset]}}\n`;
    }
  }
}

const html = readFileSync(join(root, 'web', 'ui.html'), 'utf8').replace('/*@@FONTS@@*/', css);
if (html.includes('fonts.googleapis.com')) throw new Error('В интерфейсе остались внешние шрифты');

mkdirSync(join(root, 'web', 'dist'), { recursive: true });
writeFileSync(join(root, 'web', 'dist', 'index.html'), html);
writeFileSync(
  join(root, 'src', 'webHtml.ts'),
  `// Сгенерировано scripts/build-web.mjs из web/ui.html — не править вручную.\nexport const WEB_HTML: string = ${JSON.stringify(html)};\n`,
);
console.log(`webHtml.ts: ${(html.length / 1024).toFixed(0)} КБ`);
