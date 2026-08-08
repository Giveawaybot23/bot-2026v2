// resize-tiers.js
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const dir = './images/tiers';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.png'));

(async () => {
  for (const f of files) {
    const input = path.join(dir, f);
    const outputName = f.replace('.png', '').toLowerCase() + '.webp';
    const output = path.join(dir, outputName);
    await sharp(input)
      .resize(128, 128, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(output);
    console.log('done:', f, '->', outputName);
  }
})();