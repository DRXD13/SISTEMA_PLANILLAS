// =======================================================
// === MIGRACIÓN 001: TABLA empleado_tramos ===
// =======================================================
// Cada fila es un periodo laborado continuo de un empleado (ingreso -> baja).
// empleados.fecha_ingreso / fecha_baja siguen existiendo como "tramo actual" para el resto de pantallas,
// pero el CÁLCULO DE PLANILLA lee exclusivamente de esta tabla.
//
// Idempotente: se puede ejecutar varias veces. Solo carga tramos a empleados que aún no tienen ninguno.
// Uso:  node backend/migraciones/001_empleado_tramos.js

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');

const SQL_CREAR_TABLA = `
CREATE TABLE IF NOT EXISTS empleado_tramos (
    id INT(11) NOT NULL AUTO_INCREMENT,
    empleado_id INT(11) NOT NULL,
    fecha_ingreso DATE NULL COMMENT 'NULL = ingreso no registrado (se toma como desde siempre)',
    fecha_baja DATE NULL COMMENT 'NULL = tramo vigente',
    motivo_baja VARCHAR(255) NULL,
    origen ENUM('ALTA','REINCORPORACION','MIGRACION') NOT NULL,
    registrado_por VARCHAR(100) NULL,
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizado_en TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
    -- 1 si el tramo está abierto, NULL si está cerrado: el UNIQUE permite muchos cerrados pero UN solo abierto
    abierto TINYINT(1) AS (IF(fecha_baja IS NULL, 1, NULL)) PERSISTENT,
    PRIMARY KEY (id),
    UNIQUE KEY uq_un_tramo_abierto (empleado_id, abierto),
    KEY idx_empleado_ingreso (empleado_id, fecha_ingreso),
    CONSTRAINT fk_tramo_empleado FOREIGN KEY (empleado_id) REFERENCES empleados (id) ON DELETE CASCADE,
    CONSTRAINT chk_tramo_fechas CHECK (fecha_baja IS NULL OR fecha_ingreso IS NULL OR fecha_baja >= fecha_ingreso)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`;

// Solo para la carga inicial: los tramos anteriores a una reincorporación hecha antes de existir esta tabla
// quedaron registrados en la auditoría con formato fijo.
const REGEX_REINCORPORACION = /^REINCORPORADO el (\d{4}-\d{2}-\d{2}) \(baja anterior: (\d{4}-\d{2}-\d{2}|-), ingreso anterior: (\d{4}-\d{2}-\d{2}|-)\)/;

(async () => {
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST, user: process.env.DB_USER,
        password: process.env.DB_PASSWORD, database: process.env.DB_NAME
    });
    try {
        // DDL (hace commit implícito en MySQL/MariaDB, por eso va fuera de la transacción)
        await conn.query(SQL_CREAR_TABLA);
        console.log('Tabla empleado_tramos lista.');

        await conn.beginTransaction();

        const [pendientes] = await conn.query(`
            SELECT e.id, CAST(e.fecha_ingreso AS CHAR) AS fecha_ingreso, CAST(e.fecha_baja AS CHAR) AS fecha_baja
            FROM empleados e
            WHERE NOT EXISTS (SELECT 1 FROM empleado_tramos t WHERE t.empleado_id = e.id)
            FOR UPDATE`);

        const [auditoria] = await conn.query(
            "SELECT id, empleado_id, detalles FROM auditoria_empleados WHERE accion = 'REINCORPORACIÓN' ORDER BY id");

        let tramosActuales = 0, tramosAnteriores = 0;
        for (const emp of pendientes) {
            // Tramos anteriores (de reincorporaciones previas a esta tabla)
            for (const fila of auditoria.filter(a => a.empleado_id === emp.id)) {
                const m = REGEX_REINCORPORACION.exec(fila.detalles || '');
                if (!m || m[2] === '-') { console.warn(`  ! Auditoría ${fila.id} (empleado ${emp.id}) sin baja anterior legible, se omite.`); continue; }
                await conn.execute(
                    `INSERT INTO empleado_tramos (empleado_id, fecha_ingreso, fecha_baja, motivo_baja, origen, registrado_por)
                     VALUES (?, ?, ?, ?, 'MIGRACION', 'migracion-001')`,
                    [emp.id, m[3] === '-' ? null : m[3], m[2], `Reconstruido de auditoría #${fila.id}`]);
                tramosAnteriores++;
            }
            // Tramo actual (lo que hoy dice empleados)
            await conn.execute(
                `INSERT INTO empleado_tramos (empleado_id, fecha_ingreso, fecha_baja, origen, registrado_por)
                 VALUES (?, ?, ?, 'MIGRACION', 'migracion-001')`,
                [emp.id, emp.fecha_ingreso || null, emp.fecha_baja || null]);
            tramosActuales++;
        }

        // Verificación: el último tramo de cada empleado debe coincidir con empleados.fecha_ingreso / fecha_baja
        const [descuadres] = await conn.query(`
            SELECT e.id, CAST(e.fecha_ingreso AS CHAR) emp_ingreso, CAST(e.fecha_baja AS CHAR) emp_baja,
                   CAST(t.fecha_ingreso AS CHAR) tramo_ingreso, CAST(t.fecha_baja AS CHAR) tramo_baja
            FROM empleados e
            LEFT JOIN empleado_tramos t ON t.id = (
                SELECT t2.id FROM empleado_tramos t2 WHERE t2.empleado_id = e.id
                ORDER BY t2.fecha_ingreso IS NULL, t2.fecha_ingreso DESC, t2.id DESC LIMIT 1)
            WHERE t.id IS NULL
               OR NOT (e.fecha_ingreso <=> t.fecha_ingreso)
               OR NOT (e.fecha_baja <=> t.fecha_baja)`);

        if (descuadres.length) {
            await conn.rollback();
            console.error('Descuadre entre empleados y empleado_tramos, se revierte la carga:', descuadres);
            process.exitCode = 1;
            return;
        }

        await conn.commit();
        console.log(`Carga inicial: ${pendientes.length} empleados, ${tramosActuales} tramos actuales, ${tramosAnteriores} tramos anteriores (auditoría).`);
        console.log('Verificación OK: el tramo actual de cada empleado coincide con la tabla empleados.');
    } catch (err) {
        await conn.rollback().catch(() => {});
        console.error('Error en la migración:', err.message);
        process.exitCode = 1;
    } finally {
        await conn.end();
    }
})();
