// =======================================================
// === MIGRACIÓN 005: COPIA ESTÁTICA DE LA PLANILLA AL CERRAR ===
// =======================================================
// La planilla de un periodo se recalculaba siempre desde las tablas actuales: renombrar o desactivar
// un concepto, cambiar un monto o dar de baja a un trabajador alteraba planillas ya pagadas.
//
// planilla_snapshots guarda, al cerrar un periodo (POST /api/planilla/cerrar, en la misma transacción),
// lo que la pantalla necesita para dibujarlo: columnas, datos por trabajador y parámetros (UIT, RMV...).
// Una fila por periodo + tipo de planilla (normal / reincorporada) + versión: cerrar de nuevo el mismo
// periodo agrega una versión y se muestra la última. Las versiones anteriores no se borran (auditoría).
//
// Idempotente. Uso:  node backend/migraciones/005_planilla_snapshots.js

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');

(async () => {
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST, user: process.env.DB_USER,
        password: process.env.DB_PASSWORD, database: process.env.DB_NAME
    });
    try {
        await conn.query(`
            CREATE TABLE IF NOT EXISTS planilla_snapshots (
                id INT AUTO_INCREMENT PRIMARY KEY,
                periodo VARCHAR(50) NOT NULL,
                tipo_planilla ENUM('normal','reincorporada') NOT NULL,
                version INT NOT NULL,
                columnas_json LONGTEXT NOT NULL,
                datos_json LONGTEXT NOT NULL,
                config_json LONGTEXT NOT NULL,
                trabajadores INT NOT NULL DEFAULT 0,
                creado_por VARCHAR(100) NULL,
                fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_snapshot (periodo, tipo_planilla, version)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
        const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM planilla_snapshots');
        console.log(`Tabla planilla_snapshots lista (${n} copias guardadas).`);
    } catch (err) {
        console.error('Error en la migración:', err.message);
        process.exitCode = 1;
    } finally {
        await conn.end();
    }
})();
