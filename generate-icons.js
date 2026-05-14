/**
 * Generate placeholder PNG icons for the extension.
 * Run with: node generate-icons.js
 */

const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

const sizes = [16, 48, 128];

function drawIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Dark background
  ctx.fillStyle = '#0f1a12';
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, size * 0.18);
  ctx.fill();

  const cx = size / 2;
  const cy = size / 2;

  if (size >= 48) {
    // Radar/pulse rings
    const ringCount = 3;
    for (let i = ringCount; i >= 1; i--) {
      const r = (size * 0.42) * (i / ringCount);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(74, 222, 128, ${0.12 + (ringCount - i) * 0.08})`;
      ctx.lineWidth = size * 0.025;
      ctx.stroke();
    }

    // Radar sweep line
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + size * 0.35, cy - size * 0.1);
    ctx.strokeStyle = 'rgba(74, 222, 128, 0.55)';
    ctx.lineWidth = size * 0.03;
    ctx.lineCap = 'round';
    ctx.stroke();

    // Center dot
    ctx.beginPath();
    ctx.arc(cx, cy, size * 0.07, 0, Math.PI * 2);
    ctx.fillStyle = '#4ade80';
    ctx.fill();

    // "EP" text for 128px
    if (size >= 128) {
      ctx.fillStyle = 'rgba(74, 222, 128, 0.7)';
      ctx.font = `bold ${size * 0.14}px -apple-system, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('EP', cx, cy + size * 0.31);
    }

  } else {
    // Small icon: just a green dot on dark bg
    ctx.beginPath();
    ctx.arc(cx, cy, size * 0.32, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(74, 222, 128, 0.5)';
    ctx.lineWidth = size * 0.08;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, size * 0.14, 0, Math.PI * 2);
    ctx.fillStyle = '#4ade80';
    ctx.fill();
  }

  return canvas.toBuffer('image/png');
}

const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir);

for (const size of sizes) {
  const buf = drawIcon(size);
  const outPath = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(outPath, buf);
  console.log(`Created ${outPath}`);
}

console.log('Icons generated successfully.');
