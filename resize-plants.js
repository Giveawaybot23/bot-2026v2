// resize-plants.js
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const dir = './images';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.png'));

(async () => {
  for (const f of files) {
    const input = path.join(dir, f);
    const output = path.join(dir, f.replace('.png', '.webp'));
    await sharp(input)
      .resize(256, 256, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(output);
    console.log('done:', f);
  }
})();