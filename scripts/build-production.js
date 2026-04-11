const fs = require('fs');
const path = require('path');
const terser = require('terser');
const JavaScriptObfuscator = require('javascript-obfuscator');

const projectRoot = path.resolve(__dirname, '..');
const publicDir = path.join(projectRoot, 'public');
const distRoot = path.join(projectRoot, 'dist');
const distPublic = path.join(distRoot, 'public');

const ROOT_HTML_FILES = ['admin-dashboard.html', 'feedback.html'];

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function cleanDir(dirPath) {
  if (fs.existsSync(dirPath)) {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
    } catch (error) {
      console.warn(`Skipping full clean for ${dirPath}: ${error.message}`);
    }
  }
}

function copyFile(sourcePath, targetPath) {
  ensureDir(path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath);
}

function minifyCss(cssText) {
  return cssText
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}:;,>])\s*/g, '$1')
    .replace(/;}/g, '}')
    .trim();
}

function minifyHtml(htmlText) {
  return htmlText
    .replace(/>\s+</g, '><')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function obfuscateJs(jsText, fileName) {
  const minified = await terser.minify(jsText, {
    compress: {
      passes: 2,
      drop_console: false
    },
    mangle: {
      toplevel: true
    },
    format: {
      comments: false
    }
  });

  if (!minified.code) {
    throw new Error(`Failed to minify ${fileName}`);
  }

  const obfuscated = JavaScriptObfuscator.obfuscate(minified.code, {
    compact: true,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    disableConsoleOutput: false,
    identifierNamesGenerator: 'hexadecimal',
    renameGlobals: false,
    selfDefending: true,
    simplify: true,
    splitStrings: true,
    splitStringsChunkLength: 8,
    stringArray: true,
    stringArrayThreshold: 0.8,
    transformObjectKeys: true,
    unicodeEscapeSequence: false
  });

  return obfuscated.getObfuscatedCode();
}

async function processPublicDirectory(sourceDir, targetDir) {
  ensureDir(targetDir);
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      await processPublicDirectory(sourcePath, targetPath);
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();

    if (ext === '.js') {
      const sourceCode = fs.readFileSync(sourcePath, 'utf8');
      const resultCode = await obfuscateJs(sourceCode, entry.name);
      fs.writeFileSync(targetPath, resultCode, 'utf8');
      continue;
    }

    if (ext === '.css') {
      const sourceCss = fs.readFileSync(sourcePath, 'utf8');
      fs.writeFileSync(targetPath, minifyCss(sourceCss), 'utf8');
      continue;
    }

    if (ext === '.html') {
      const sourceHtml = fs.readFileSync(sourcePath, 'utf8');
      fs.writeFileSync(targetPath, minifyHtml(sourceHtml), 'utf8');
      continue;
    }

    copyFile(sourcePath, targetPath);
  }
}

async function build() {
  cleanDir(distRoot);
  ensureDir(distRoot);
  await processPublicDirectory(publicDir, distPublic);

  for (const fileName of ROOT_HTML_FILES) {
    const srcFile = path.join(projectRoot, fileName);
    if (!fs.existsSync(srcFile)) continue;

    const targetFile = path.join(distRoot, fileName);
    const htmlContent = fs.readFileSync(srcFile, 'utf8');
    fs.writeFileSync(targetFile, minifyHtml(htmlContent), 'utf8');
  }

  console.log('Production build complete: dist/');
}

build().catch((error) => {
  console.error('Production build failed:', error);
  process.exit(1);
});
