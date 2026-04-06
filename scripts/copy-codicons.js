const fs = require('fs');
const path = require('path');

const src = 'node_modules/@vscode/codicons/dist';
const dst = 'media/codicons';

const requiredFiles = ['codicon.css', 'codicon.ttf'];

if (!fs.existsSync(src)) {
    console.log('Source directory does not exist, skipping codicons copy');
    process.exit(0);
}

if (fs.existsSync(dst)) {
    fs.rmSync(dst, { recursive: true });
}
fs.mkdirSync(dst, { recursive: true });

requiredFiles.forEach(file => {
    const srcPath = path.join(src, file);
    const dstPath = path.join(dst, file);
    fs.copyFileSync(srcPath, dstPath);

    if (file === 'codicon.css') {
        let content = fs.readFileSync(dstPath, 'utf8');
        content = content.replace(/url\("\.\/codicon\.ttf\?[^"]+"\)/, 'url("./codicon.ttf")');
        fs.writeFileSync(dstPath, content);
    }
});

console.log('Copied codicons assets to media/codicons');
