// Generates the PWA / APK PNG icons (a five-petal sakura) without any image library.
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

function crc32(buf) {
    let c, crc = 0xffffffff;
    for (let n = 0; n < buf.length; n++) {
        c = (crc ^ buf[n]) & 0xff;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}

/** Is the point (in petal-local coordinates, petal pointing up) inside a sakura petal? */
function inPetal(x, y, R) {
    // petal: ellipse from the centre up to R, with a small notch at the tip
    const cy = -R * 0.55, ry = R * 0.47, rx = R * 0.27;
    const e = (x * x) / (rx * rx) + ((y - cy) * (y - cy)) / (ry * ry);
    if (e > 1) return false;
    const notch = y < -R * 0.9 && Math.abs(x) < (y + R * 1.02) * -0.9 + R * 0.02;
    return !notch;
}

function draw(size) {
    const px = Buffer.alloc(size * size * 4);
    const c = size / 2, R = size * 0.42;
    const paper = [248, 246, 242], petal = [232, 162, 180], core = [192, 96, 122];
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = x + 0.5 - c, dy = y + 0.5 - c + size * 0.02;
            let col = paper;
            for (let k = 0; k < 5; k++) {
                const a = (k * 72 * Math.PI) / 180;
                const lx = dx * Math.cos(a) + dy * Math.sin(a);
                const ly = -dx * Math.sin(a) + dy * Math.cos(a);
                if (inPetal(lx, ly, R)) { col = petal; break; }
            }
            const d = Math.hypot(dx, dy);
            if (d < R * 0.14) col = core;
            if (d < R * 0.055) col = paper;
            const i = (y * size + x) * 4;
            px[i] = col[0]; px[i + 1] = col[1]; px[i + 2] = col[2]; px[i + 3] = 255;
        }
    }
    const raw = Buffer.alloc((size * 4 + 1) * size);
    for (let y = 0; y < size; y++) {
        raw[y * (size * 4 + 1)] = 0;
        px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8; ihdr[9] = 6;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

for (const s of [192, 512]) fs.writeFileSync(path.join(OUT, `icon-${s}.png`), draw(s));
console.log('icons written');
