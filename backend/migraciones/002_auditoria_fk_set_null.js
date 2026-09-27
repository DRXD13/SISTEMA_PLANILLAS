// =======================================================
// === MIGRACIÓN 002: AUDITORÍA PERMANENTE ===
// =======================================================
// auditoria_empleados.empleado_id tenía ON DELETE CASCADE: al eliminar un trabajador se borraba
// todo su historial. Se cambia a ON DELETE SET NULL: el registro queda y solo pierde el vínculo
// (los detalles ya incluyen nombre y DNI del trabajador).
//
// Idempotente: si la llave ya es SET NULL no hace nada.
// Uso:  node backend/migraciones/002_auditoria_fk_set_null.js

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');

const FK_VIEJA = 'auditoria_empleados_ibfk_1';   // ON DELETE CASCADE
const FK_NUEVA = 'fk_auditoria_empleado';        // ON DELETE SET NULL
// (MariaDB no permite DROP + ADD de una llave con el MISMO nombre en un solo ALTER: errno 121)

// Todas las llaves de auditoria_empleados -> empleados, con su regla de borrado
async function llavesActuales(conn) {
    const [rows] = await conn.query(
        `SELECT CONSTRAINT_NAME AS nombre, DELETE_RULE AS regla FROM information_schema.REFERENTIAL_CONSTRAINTS
         WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'auditoria_empleados' AND REFERENCED_TABLE_NAME = 'empleados'`);
    return rows;
}

(async () => {
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST, user: process.env.DB_USER,
        password: process.env.DB_PASSWORD, database: process.env.DB_NAME
    });
    try {
        const antes = await llavesActuales(conn);
        console.log('Llaves actuales:', antes.map(k => `${k.nombre} = ${k.regla}`).join(', ') || '(ninguna)');

        if (antes.length === 1 && antes[0].regla === 'SET NULL') {
            console.log('Nada que hacer: la auditoría ya es permanente.');
        } else {
            const [[{ filas }]] = await conn.query('SELECT COUNT(*) AS filas FROM auditoria_empleados');
            // Un solo ALTER: quitar y volver a crear la llave es atómico (no queda la tabla sin FK a medias)
            await conn.query(`
                ALTER TABLE auditoria_empleados
                    ${antes.map(k => `DROP FOREIGN KEY ${k.nombre},`).join(' ')}
                    ADD CONSTRAINT ${FK_NUEVA} FOREIGN KEY (empleado_id) REFERENCES empleados (id) ON DELETE SET NULL`);
            const [[{ filas: filasDespues }]] = await conn.query('SELECT COUNT(*) AS filas FROM auditoria_empleados');
            if (filas !== filasDespues) throw new Error(`Cambió el número de filas (${filas} -> ${filasDespues})`);
            console.log(`Llave cambiada. Filas de auditoría intactas: ${filasDespues}.`);
        }

        const despues = await llavesActuales(conn);
        if (despues.length !== 1 || despues[0].regla !== 'SET NULL') throw new Error(`Estado final inesperado: ${JSON.stringify(despues)}`);
        console.log(`Verificación OK: ${despues[0].nombre} = ON DELETE ${despues[0].regla} (única llave hacia empleados)`);
    } catch (err) {
        console.error('Error en la migración:', err.message);
        process.exitCode = 1;
    } finally {
        await conn.end();
    }
})();
