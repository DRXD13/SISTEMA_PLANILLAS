// Generador de datos ficticios para personas (reemplaza la consulta real a RENIEC)

const { generarFotoFicticia } = require('./fakeAvatar');

const NOMBRES = [
    'JUAN CARLOS', 'MARIA FERNANDA', 'LUIS ALBERTO', 'ANA LUCIA', 'JOSE MANUEL',
    'ROSA ELENA', 'CARLOS ANDRES', 'PATRICIA ISABEL', 'MIGUEL ANGEL', 'LAURA SOFIA',
    'JORGE LUIS', 'DIANA CAROLINA', 'PEDRO PABLO', 'CLAUDIA MARCELA', 'RICARDO JAVIER',
    'SANDRA MILENA', 'FERNANDO JOSE', 'MONICA ALEJANDRA', 'ALEJANDRO DAVID', 'VALERIA NICOLE',
    'RENATO ESTEBAN', 'GABRIELA BEATRIZ', 'HECTOR RAUL', 'KAREN LISSETTE', 'OSCAR EDUARDO'
];

const APELLIDOS = [
    'GARCIA', 'RODRIGUEZ', 'GONZALEZ', 'FERNANDEZ', 'LOPEZ', 'MARTINEZ', 'SANCHEZ',
    'PEREZ', 'GOMEZ', 'DIAZ', 'TORRES', 'RAMIREZ', 'FLORES', 'VASQUEZ', 'CASTILLO',
    'ROMERO', 'CHAVEZ', 'ORTIZ', 'MEDINA', 'SILVA', 'ROJAS', 'MORALES', 'HERRERA',
    'QUISPE', 'MAMANI', 'HUAMAN', 'CONDORI', 'PAREDES', 'VARGAS', 'CASTRO'
];

const VIAS = [
    'AV. LOS PROCERES', 'CALLE LAS FLORES', 'JR. HUANCAVELICA', 'AV. LA MARINA',
    'PSJE. SAN MARTIN', 'CALLE LOS OLIVOS', 'AV. PROGRESO', 'JR. AYACUCHO',
    'CALLE REAL', 'AV. UNIVERSITARIA', 'CALLE LOS PINOS', 'AV. GRAU'
];

const UBIGEOS = [
    'LIMA/LIMA/SAN JUAN DE LURIGANCHO', 'LIMA/LIMA/SAN MARTIN DE PORRES', 'LIMA/LIMA/ATE',
    'AREQUIPA/AREQUIPA/CERCADO', 'LA LIBERTAD/TRUJILLO/EL PORVENIR', 'PIURA/PIURA/CASTILLA',
    'LAMBAYEQUE/CHICLAYO/JOSE LEONARDO ORTIZ', 'CUSCO/CUSCO/SAN SEBASTIAN',
    'ICA/ICA/LA TINGUINA', 'JUNIN/HUANCAYO/EL TAMBO', 'ANCASH/HUARAZ/INDEPENDENCIA',
    'LORETO/MAYNAS/BELEN'
];

function mulberry32(seed) {
    return function () {
        seed |= 0;
        seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function seedFromString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    return h;
}

function pick(arr, rng) {
    return arr[Math.floor(rng() * arr.length)];
}

function generarCelularAleatorio(rng = Math.random) {
    let n = '9';
    for (let i = 0; i < 8; i++) n += Math.floor(rng() * 10);
    return n;
}

function generarDniAleatorio(rng = Math.random) {
    let n = '';
    for (let i = 0; i < 8; i++) n += Math.floor(rng() * 10);
    return n;
}

// Fecha de nacimiento ficticia: persona entre 20 y 60 años (a la fecha actual).
function generarFechaNacimientoAleatoria(rng = Math.random) {
    const hoy = new Date();
    const edad = 20 + Math.floor(rng() * 41); // 20..60
    const anio = hoy.getFullYear() - edad;
    const mes = 1 + Math.floor(rng() * 12);
    const diasEnMes = new Date(anio, mes, 0).getDate();
    const dia = 1 + Math.floor(rng() * diasEnMes);
    const pad = (n) => String(n).padStart(2, '0');
    return `${anio}-${pad(mes)}-${pad(dia)}`;
}

// Misma persona ficticia para un mismo DNI (facilita pruebas repetibles),
// pero con apariencia aleatoria.
function generarPersonaFicticia(dni) {
    const rng = mulberry32(seedFromString('persona-' + dni));
    const nombre = pick(NOMBRES, rng);
    const apellido_paterno = pick(APELLIDOS, rng);
    let apellido_materno = pick(APELLIDOS, rng);
    while (apellido_materno === apellido_paterno) apellido_materno = pick(APELLIDOS, rng);
    const numero = Math.floor(rng() * 900) + 100;

    return {
        dni,
        nombre,
        apellido_paterno,
        apellido_materno,
        direccion: `${pick(VIAS, rng)} ${numero}`,
        ubigeo: pick(UBIGEOS, rng),
        celular: generarCelularAleatorio(rng),
        fecha_nacimiento: generarFechaNacimientoAleatoria(rng),
        foto: generarFotoFicticia(rng)
    };
}

module.exports = { generarPersonaFicticia, generarCelularAleatorio, generarDniAleatorio, generarFechaNacimientoAleatoria };
