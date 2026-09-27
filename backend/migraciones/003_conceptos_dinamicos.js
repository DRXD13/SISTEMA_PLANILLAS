// =======================================================
// === MIGRACIÓN 003: CONCEPTOS DINÁMICOS EN LA PLANILLA ===
// =======================================================
// Antes, el motor de planilla decidía qué hacer con cada concepto buscando fragmentos de texto
// en su nombre ('320' -> DS 320, 'FAMILIA' -> Asig. familiar...). Un concepto nuevo que no
// coincidía con ningún fragmento se ignoraba sin avisar.
//
// Ahora cada concepto declara:
//   rol_calculo       qué hace el motor con él (ver ROLES)
//   columna_planilla  en qué columna aparece (conceptos de distintos regímenes comparten columna)
//   orden             orden de la columna (y de la suma de ingresos)
//
// La carga inicial replica EXACTAMENTE las reglas de texto del motor anterior, para que la
// planilla dé los mismos montos. Idempotente: solo asigna rol a conceptos que aún no lo tienen.
// Uso:  node backend/migraciones/003_conceptos_dinamicos.js

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');

const ROLES = [
    'INGRESO',          // suma al bruto, se prorratea por días, columna propia
    'INGRESO_AFP',      // igual que INGRESO, pero solo si el trabajador NO tiene aporte AFP (regla heredada)
    'DESCUENTO_FIJO',   // monto fijo que se descuenta (no se prorratea), columna propia
    'APORTE_FIJO',      // aporte del empleador (no afecta el neto), columna propia
    'AFP_APORTE', 'AFP_SEGURO', 'AFP_COMISION', 'ONP',       // tasas de pensión
    'RENTA_5TA', 'JUDICIAL', 'PRESTAMO', 'SINDICATO',        // descuentos con cálculo propio
    'ESSALUD', 'TARDANZAS_FALTAS'                            // calculados por el sistema
];

// Mismo orden en que el motor anterior sumaba los ingresos (suma idéntica al último decimal)
const COLUMNAS_INGRESO = [
    { claves: ['BASICA', 'REMUNERACION'], columna: 'REM. BÁSICA', orden: 10 },
    { claves: ['REUNIF'], columna: 'REM. REUNIF.', orden: 20 },
    { claves: ['COSTO VIDA'], columna: 'COSTO DE VIDA', orden: 30 },
    { claves: ['DIF. CARGO'], columna: 'BONIF. DIF. CARGO', orden: 40 },
    { claves: ['DIF. PERM', 'DIFERENCIAL PERMANENTE'], columna: 'BONIF. DIF. PERM.', orden: 50 },
    { claves: ['REFRIG'], columna: 'REFRIG. MOV.', orden: 60 },
    { claves: ['HOMOL'], columna: 'TRANS. HOMOL.', orden: 70 },
    { claves: ['FAMILIA'], columna: 'ASIG. FAMILIAR', orden: 80 },
    { claves: ['PERSONAL'], columna: 'BONIF. PERSONAL', orden: 90 },
    { exacto: 'AFP', columna: 'AFP (CON)', orden: 100, rol: 'INGRESO_AFP' },
    { claves: ['314'], columna: 'DS 314-2023', orden: 110 },
    { claves: ['320'], columna: 'DS 320-2022', orden: 120 },
    { claves: ['268'], columna: 'DS 268-2024', orden: 130 },
    { claves: ['280'], columna: 'DS 280-2024', orden: 140 },
    { claves: ['279'], columna: 'DS 279-2024', orden: 150 },
    { claves: ['265'], columna: 'DS 265-2024', orden: 160 },
    { claves: ['313'], columna: 'DS 313-2023', orden: 170 },
    { claves: ['311'], columna: 'DS 311-2022', orden: 180 },
    { claves: ['341'], columna: 'RA 341-2011', orden: 190 },
    { claves: ['RIESGO', 'SALUD'], columna: 'RIESGO SALUD', orden: 200 }
];

function clasificar(c) {
    const n = (c.nombre || '').toUpperCase().trim();
    if (c.operacion === 'Aporte' || n.includes('ESSALUD')) return { rol: 'ESSALUD', columna: 'ESSALUD 9%', orden: 900 };
    if (c.operacion === 'Descuento') {
        const d = [
            [['APORTE', 'FONDO'], 'AFP_APORTE', 'AFP APORTE'], [['SEGURO', 'PRIMA'], 'AFP_SEGURO', 'AFP PRIMA'],
            [['COMISION'], 'AFP_COMISION', 'AFP COMISIÓN'], [['ONP', 'SNP'], 'ONP', 'ONP'],
            [['SINDIC', 'GREMIO'], 'SINDICATO', 'CUOTA SINDICAL'], [['PRESTAMO'], 'PRESTAMO', 'DSCTO PRÉSTAMOS'],
            [['RENTA'], 'RENTA_5TA', 'RENTA 5TA'], [['JUDIC'], 'JUDICIAL', 'DSCTO JUDIC.'],
            [['TARD'], 'TARDANZAS_FALTAS', 'DSCTO TARD/FALTAS']
        ].find(([claves]) => claves.some(k => n.includes(k)));
        if (d) return { rol: d[1], columna: d[2], orden: 500 };
        return { rol: 'DESCUENTO_FIJO', columna: n || 'DESCUENTO', orden: 700 };
    }
    // Ingreso
    const col = COLUMNAS_INGRESO.find(x => x.exacto ? n === x.exacto : x.claves.some(k => n.includes(k)));
    if (col) return { rol: col.rol || 'INGRESO', columna: col.columna, orden: col.orden };
    return { rol: 'INGRESO', columna: n || 'INGRESO', orden: 300 };
}

(async () => {
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST, user: process.env.DB_USER,
        password: process.env.DB_PASSWORD, database: process.env.DB_NAME
    });
    try {
        const [cols] = await conn.query("SHOW COLUMNS FROM conceptos LIKE 'rol_calculo'");
        if (!cols.length) {
            // DDL: commit implícito, por eso fuera de la transacción
            await conn.query(`
                ALTER TABLE conceptos
                    ADD COLUMN rol_calculo ENUM(${ROLES.map(r => `'${r}'`).join(',')}) NULL AFTER operacion,
                    ADD COLUMN columna_planilla VARCHAR(60) NULL AFTER rol_calculo,
                    ADD COLUMN orden INT NOT NULL DEFAULT 300 AFTER columna_planilla`);
            console.log('Columnas rol_calculo, columna_planilla y orden agregadas.');
        } else {
            console.log('Las columnas ya existen.');
        }

        await conn.beginTransaction();
        const [pendientes] = await conn.query('SELECT id, nombre, aplicacion, operacion, estado FROM conceptos WHERE rol_calculo IS NULL ORDER BY id FOR UPDATE');
        for (const c of pendientes) {
            const r = clasificar(c);
            await conn.execute('UPDATE conceptos SET rol_calculo = ?, columna_planilla = ?, orden = ? WHERE id = ?', [r.rol, r.columna, r.orden, c.id]);
            console.log(`  #${String(c.id).padStart(2)} ${c.estado.padEnd(8)} ${c.operacion.padEnd(9)} ${c.aplicacion.padEnd(8)} ${c.nombre.padEnd(22)} -> ${r.rol.padEnd(16)} [${r.columna}] (${r.orden})`);
        }
        const [[{ sinRol }]] = await conn.query('SELECT COUNT(*) AS sinRol FROM conceptos WHERE rol_calculo IS NULL OR columna_planilla IS NULL');
        if (sinRol) throw new Error(`${sinRol} conceptos quedaron sin rol/columna`);
        await conn.commit();
        console.log(`Clasificados: ${pendientes.length}. Todos los conceptos tienen rol y columna.`);

        // Con todo clasificado, el rol pasa a ser obligatorio
        await conn.query(`ALTER TABLE conceptos MODIFY rol_calculo ENUM(${ROLES.map(r => `'${r}'`).join(',')}) NOT NULL,
                                                MODIFY columna_planilla VARCHAR(60) NOT NULL`);
        console.log('rol_calculo y columna_planilla ahora son obligatorios.');
    } catch (err) {
        await conn.rollback().catch(() => {});
        console.error('Error en la migración:', err.message);
        process.exitCode = 1;
    } finally {
        await conn.end();
    }
})();
