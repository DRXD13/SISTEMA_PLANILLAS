// Genera un avatar ficticio tipo "cartoon" (cara simple) en JPEG, sin depender de fotos reales.
const jpeg = require('jpeg-js');

const BG_COLORS = [
    [255, 214, 165], [255, 236, 179], [209, 231, 221], [197, 225, 245],
    [230, 210, 240], [255, 205, 210], [220, 237, 200], [245, 222, 179]
];
const SKIN_COLORS = [
    [255, 224, 189], [240, 184, 160], [224, 172, 105], [198, 134, 66], [141, 85, 36]
];
const HAIR_COLORS = [
    [40, 30, 20], [80, 42, 10], [15, 15, 15], [120, 80, 40], [180, 150, 90], [200, 200, 205]
];

function dist(x1, y1, x2, y2) {
    const dx = x1 - x2, dy = y1 - y2;
    return Math.sqrt(dx * dx + dy * dy);
}

// rng: función 0..1 determinística (ver mulberry32 en fakePersonaGenerator.js)
function generarFotoFicticia(rng, size = 128) {
    const bg = BG_COLORS[Math.floor(rng() * BG_COLORS.length)];
    const skin = SKIN_COLORS[Math.floor(rng() * SKIN_COLORS.length)];
    const hair = HAIR_COLORS[Math.floor(rng() * HAIR_COLORS.length)];
    const tieneCabello = rng() > 0.12;
    const tieneLentes = rng() > 0.75;

    const cx = size / 2;
    const cy = size / 2 + size * 0.05;
    const faceR = size * 0.30;

    const data = Buffer.alloc(size * size * 4);

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            let color = bg;

            const dFace = dist(x, y, cx, cy);
            if (dFace <= faceR) {
                color = skin;
            }

            // Cabello: casquete elíptico en la parte superior de la cabeza
            if (tieneCabello) {
                const hy = (y - (cy - faceR * 0.35)) * 1.35;
                const hx = x - cx;
                const hDist = Math.sqrt(hx * hx + hy * hy);
                if (hDist <= faceR + size * 0.02 && y < cy - faceR * 0.15) {
                    color = hair;
                }
            }

            // Ojos
            const eyeY = cy - faceR * 0.15;
            const eyeOffsetX = faceR * 0.4;
            const eyeR = size * 0.035;
            if (dist(x, y, cx - eyeOffsetX, eyeY) < eyeR || dist(x, y, cx + eyeOffsetX, eyeY) < eyeR) {
                color = [45, 35, 30];
            }

            // Lentes (opcional)
            if (tieneLentes) {
                const lensR = eyeR + size * 0.02;
                const onLensRingIzq = Math.abs(dist(x, y, cx - eyeOffsetX, eyeY) - lensR) < size * 0.012;
                const onLensRingDer = Math.abs(dist(x, y, cx + eyeOffsetX, eyeY) - lensR) < size * 0.012;
                const onPuente = Math.abs(y - eyeY) < size * 0.01 && Math.abs(x - cx) < eyeOffsetX;
                if (onLensRingIzq || onLensRingDer || onPuente) {
                    color = [30, 30, 30];
                }
            }

            // Boca
            const mouthY = cy + faceR * 0.45;
            if (Math.abs(y - mouthY) < size * 0.012 && Math.abs(x - cx) < faceR * 0.35) {
                color = [130, 60, 60];
            }

            const idx = (y * size + x) * 4;
            data[idx] = color[0];
            data[idx + 1] = color[1];
            data[idx + 2] = color[2];
            data[idx + 3] = 255;
        }
    }

    const encoded = jpeg.encode({ data, width: size, height: size }, 85);
    return encoded.data.toString('base64');
}

module.exports = { generarFotoFicticia };
