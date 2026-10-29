// Minimal PNG tEXt chunk reader/writer for SillyTavern character cards (chara / ccv3).

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function readTextChunks(buf) {
    if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a png');
    const out = {};
    let i = 8;
    while (i + 8 <= buf.length) {
        const len = buf.readUInt32BE(i);
        const type = buf.toString('latin1', i + 4, i + 8);
        if (type === 'tEXt') {
            const data = buf.subarray(i + 8, i + 8 + len);
            const z = data.indexOf(0);
            out[data.toString('latin1', 0, z)] = data.toString('latin1', z + 1);
        }
        if (type === 'IEND') break;
        i += 12 + len;
    }
    return out;
}

/** Returns the parsed card JSON (v3 preferred) or null. */
export function readCard(buf) {
    const t = readTextChunks(buf);
    const raw = t.ccv3 || t.chara;
    if (!raw) return null;
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}

/** Write card JSON into png, replacing existing chara/ccv3 chunks. */
export function writeCard(buf, card) {
    const parts = [SIG];
    let i = 8;
    const json = JSON.stringify(card);
    const b64 = Buffer.from(json, 'utf8').toString('base64');
    const v2 = { ...card, spec: 'chara_card_v2', spec_version: '2.0' };
    const b64v2 = Buffer.from(JSON.stringify(v2), 'utf8').toString('base64');
    while (i + 8 <= buf.length) {
        const len = buf.readUInt32BE(i);
        const type = buf.toString('latin1', i + 4, i + 8);
        const whole = buf.subarray(i, i + 12 + len);
        if (type === 'tEXt') {
            const data = buf.subarray(i + 8, i + 8 + len);
            const key = data.toString('latin1', 0, data.indexOf(0));
            if (key === 'chara' || key === 'ccv3') { i += 12 + len; continue; }
        }
        if (type === 'IEND') {
            parts.push(chunk('tEXt', Buffer.concat([Buffer.from('chara\0', 'latin1'), Buffer.from(b64v2, 'latin1')])));
            parts.push(chunk('tEXt', Buffer.concat([Buffer.from('ccv3\0', 'latin1'), Buffer.from(b64, 'latin1')])));
            parts.push(whole);
            break;
        }
        parts.push(whole);
        i += 12 + len;
    }
    return Buffer.concat(parts);
}

/** A 1x1 transparent-ish placeholder png for cards imported as JSON. */
export function blankPng() {
    return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64');
}
