// =======================================================
// === MIGRACIÓN 004: VIGENCIA DE LOS CONCEPTOS ===
// =======================================================
// Un concepto creado hoy aparecía como columna en las planillas de meses anteriores, porque la
// planilla dibujaba todos los conceptos activos sin importar el periodo consultado.
//
// Ahora cada concepto tiene:
//   vigente_desde   primer día del periodo desde el que existe (YYYY-MM-01).
//                   NULL = siempre existió (catálogo original).
// La planilla de un periodo solo usa los conceptos con vigente_desde NULL o <= inicio del periodo.
//
// Carga inicial: el catálogo original se cargó al instalar el sistema (su created_at no es su
// vigencia real), así que queda en NULL. Solo se fechan los conceptos creados desde el mantenedor
// (tienen auditoría 'CREACIÓN CONCEPTO CATÁLOGO'), con el mes de su creación.
// Idempotente: solo fecha conceptos que aún no tienen vigencia.
// Uso:  node backend/migraciones/004_conceptos_vigencia.js

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');

(async () => {
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST, user: process.env.DB_USER,
        password: process.env.DB_PASSWORD, database: process.env.DB_NAME
    });
    try {
        const [cols] = await conn.query("SHOW COLUMNS FROM conceptos LIKE 'vigente_desde'");
        if (!cols.length) {
            // DDL: commit implícito, por eso fuera de la transacción
            await conn.query('ALTER TABLE conceptos ADD COLUMN vigente_desde DATE NULL AFTER orden');
            console.log('Columna vigente_desde agregada.');
        } else {
            console.log('La columna vigente_desde ya existe.');
        }

        await conn.beginTransaction();
        const [creados] = await conn.query(`
            SELECT c.id, c.nombre, DATE_FORMAT(c.created_at, '%Y-%m-01') AS desde
            FROM conceptos c
            WHERE c.vigente_desde IS NULL AND c.created_at IS NOT NULL
              AND EXISTS (SELECT 1 FROM auditoria_empleados a
                          WHERE a.accion = 'CREACIÓN CONCEPTO CATÁLOGO' AND a.detalles LIKE CONCAT('Concepto #', c.id, ' %'))
            ORDER BY c.id FOR UPDATE`);
        for (const c of creados) {
            await conn.execute('UPDATE conceptos SET vigente_desde = ? WHERE id = ?', [c.desde, c.id]);
            console.log(`  #${String(c.id).padStart(2)} ${c.nombre.padEnd(30)} -> vigente desde ${c.desde}`);
        }
        await conn.commit();
        console.log(`Conceptos fechados: ${creados.length}. El resto queda vigente para todos los periodos.`);
    } catch (err) {
        await conn.rollback().catch(() => {});
        console.error('Error en la migración:', err.message);
        process.exitCode = 1;
    } finally {
        await conn.end();
    }
})();
