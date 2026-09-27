const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const express = require('express');
const mysql = require('mysql2/promise');
// const bodyParser = require('body-parser'); // <--- YA NO LO NECESITAMOS
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const saltRounds = 10;
const fetch = require('node-fetch');
const puppeteer = require('puppeteer');
const { generarPersonaFicticia } = require('./fakePersonaGenerator');
const { calcularDiasMes } = require('./planilla-dias');

const app = express();
app.set('trust proxy', true);
const port = 3000;

app.use(cors());

// --- CAMBIO IMPORTANTE AQUÍ ---
// Usamos el parser nativo de Express que es más seguro
app.use(express.json()); 
app.use(express.urlencoded({ extended: true }));
// ------------------------------

// Rutas estáticas
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'frontend', 'login.html'));
});
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ==================== CONEXIÓN A LA BASE DE DATOS (POOL) ====================
// Antes se usaba una unica conexion compartida por toda la app: si dos peticiones
// llegaban al mismo tiempo, competian por la misma conexion y un error de red la
// tumbaba para TODOS hasta que algo disparara la reconexion manual.
// Con un pool, cada peticion toma una conexion libre y mysql2 la reconecta sola.
let pool;

async function obtenerConexion() {
    if (!pool) {
        pool = mysql.createPool({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0
        });
        console.log('Pool de conexiones a MySQL creado.');
    }
    return pool;
}

const JWT_SECRET = process.env.JWT_SECRET;

const verifyToken = (req, res, next) => {
    const bearerHeader = req.headers['authorization'];
    if (typeof bearerHeader !== 'undefined') {
        const bearerToken = bearerHeader.split(' ')[1];
        req.token = bearerToken;
        jwt.verify(req.token, JWT_SECRET, (err, authData) => {
            if (err) {
                return res.sendStatus(403);
            }
            req.authData = authData;
            next();
        });
    } else {
        res.sendStatus(403);
    }
};

// ==================== BLOQUEO GLOBAL DEL SISTEMA (PLANILLA CERRADA) ====================
// Cuando la planilla esta cerrada, NINGUN endpoint de escritura (POST/PUT/DELETE) puede
// ejecutarse en todo el sistema, salvo login y los propios endpoints de cerrar/activar.
// Estas rutas son de NAVEGACIÓN (elegir/organizar qué periodo se está viendo), no modifican
// datos de planilla ya pagados, así que deben seguir funcionando aunque el sistema esté bloqueado.
const RUTAS_EXENTAS_DE_BLOQUEO = [
    '/login',
    '/api/planilla/cerrar',
    '/api/planilla/reabrir',
    '/api/periodos-movidos',
    '/api/configuracion/anio-ui',
    '/api/periodo-global',
    '/api/periodo-actual'
];

const verificarSistemaDesbloqueado = async (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (RUTAS_EXENTAS_DE_BLOQUEO.includes(req.path)) return next();

    try {
        const conn = await obtenerConexion();
        const [rows] = await conn.execute("SELECT valor FROM configuracion_sistema WHERE clave = 'sistema_bloqueado'");
        const bloqueado = rows.length > 0 && rows[0].valor === '1';
        if (bloqueado) {
            return res.status(423).json({ message: 'El sistema está bloqueado porque la planilla fue cerrada. Actívala con la contraseña para poder hacer cambios.' });
        }
        next();
    } catch (err) {
        console.error('Error verificando el bloqueo del sistema:', err);
        next(); // Si falla la verificacion, no tumbamos todo el sistema por esto.
    }
};

app.use(verificarSistemaDesbloqueado);

// ==================== AUDITORÍA (PROFESIONAL: SOPORTA ACCIONES DEL SISTEMA) ====================
async function registrarAuditoria(usuario, accion, empleadoId, ipAddress, detalles = null, userAgent = null) {
    try {
        const connAuditoria = await obtenerConexion();
        
        // LÓGICA INTELIGENTE:
        // Si el ID es 0, '0', null o undefined, enviamos NULL a la base de datos.
        // Esto respeta la Clave Foránea: "Si no es un empleado real, no apuntes a nadie".
        const idParaBD = (empleadoId && empleadoId != 0 && empleadoId !== '0') ? empleadoId : null;

        const sql = 'INSERT INTO auditoria_empleados (usuario, accion, empleado_id, ip_address, user_agent, detalles) VALUES (?, ?, ?, ?, ?, ?)';
        
        await connAuditoria.execute(sql, [
            usuario || 'desconocido',
            accion,
            idParaBD, // <--- Aquí enviamos el valor limpio (ID o NULL)
            ipAddress || null,
            userAgent || null,
            detalles
        ]);
        
        // Log limpio para verificar que funciona
        console.log(`✅ Auditoría: ${accion} | Usuario: ${usuario} | EmpleadoID: ${idParaBD || 'SISTEMA'}`);

    } catch (err) {
        // Ahora sí, si falla es por algo grave (conexión, etc), así que lo mostramos completo
        console.error('🔥 Error CRÍTICO en Auditoría:', err);
    }
}

// --- AGREGAR EN LA PARTE SUPERIOR (Junto a los otros require) ---
const nodemailer = require('nodemailer');
const crypto = require('crypto');

// Configuración del emisor de correos
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});
// ----------------------------------------------------------------

// ==================== ELIMINAR LA RUTA app.post('/login', ...) ANTERIOR ====================
// ==================== E INSERTAR ESTE NUEVO BLOQUE DE AUTENTICACIÓN ====================

// PASO 1: Validar correo/contraseña (y verificar dispositivo)
app.post('/api/auth/login-step1', async (req, res) => {
    const { correo, password, dispositivo_token } = req.body;
    try {
        const conn = await obtenerConexion();
        const [rows] = await conn.execute('SELECT * FROM usuarios WHERE correo = ?', [correo]);

        if (rows.length === 0) return res.status(401).json({ message: 'Credenciales incorrectas' });

        const user = rows[0];
        const match = await bcrypt.compare(password, user.password);

        if (!match) return res.status(401).json({ message: 'Credenciales incorrectas' });

        // Verificamos si el usuario está bloqueado
        if (user.estado === 'Inactivo') return res.status(403).json({ message: 'Tu cuenta ha sido suspendida. Contacta al administrador.' });

        let dispositivosGuardados = [];
        if (user.dispositivo_token) {
            try { dispositivosGuardados = JSON.parse(user.dispositivo_token); } 
            catch (e) { dispositivosGuardados = [user.dispositivo_token]; }
        }

        // Si es un dispositivo de confianza, enviamos el rol
        if (dispositivo_token && dispositivosGuardados.includes(dispositivo_token)) {
            const tokenPayload = { user: { id: user.id, username: user.username, correo: user.correo, rol: user.rol } };
            const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '8h' });
            // AGREGAMOS EL ROL A LA RESPUESTA
            return res.json({ skipOTP: true, token, username: user.username, rol: user.rol });
        }

        const otp = crypto.randomInt(100000, 999999).toString();
        const expires = new Date(Date.now() + 5 * 60000); 

        await conn.execute('UPDATE usuarios SET otp_code = ?, otp_expires = ? WHERE id = ?', [otp, expires, user.id]);

        const mailOptions = {
            from: `"Sistema de Planillas" <${process.env.EMAIL_USER}>`,
            to: user.correo,
            subject: 'Código de Seguridad - Ingreso al Sistema',
            html: `
                <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #ddd; border-radius: 10px; max-width: 500px;">
                    <h2 style="color: #0f172a;">Código de Verificación</h2>
                    <p>Has intentado iniciar sesión desde un dispositivo no reconocido o nuevo.</p>
                    <p>Tu código de seguridad de 6 dígitos es:</p>
                    <h1 style="color: #2563eb; letter-spacing: 5px; font-size: 32px;">${otp}</h1>
                    <p style="color: #64748b; font-size: 12px;">Este código expirará en 5 minutos.</p>
                </div>
            `
        };

        await transporter.sendMail(mailOptions);
        const [alias, dominio] = user.correo.split('@');
        res.json({ message: 'Código enviado', correoOculto: `${alias.substring(0, 3)}****@${dominio}` });
    } catch (err) {
        res.status(500).json({ message: 'Error interno del servidor' });
    }
});

// PASO 2: Validar OTP y registrar el dispositivo
app.post('/api/auth/login-step2', async (req, res) => {
    const { correo, otp } = req.body;
    try {
        const conn = await obtenerConexion();
        const [rows] = await conn.execute('SELECT * FROM usuarios WHERE correo = ?', [correo]);
        if (rows.length === 0) return res.status(401).json({ message: 'Usuario no encontrado' });

        const user = rows[0];
        if (user.otp_code !== otp) return res.status(401).json({ message: 'Código incorrecto' });
        if (new Date() > new Date(user.otp_expires)) return res.status(401).json({ message: 'El código ha expirado.' });

        let dispositivosGuardados = [];
        if (user.dispositivo_token) {
            try { dispositivosGuardados = JSON.parse(user.dispositivo_token); } 
            catch (e) { dispositivosGuardados = [user.dispositivo_token]; }
        }

        const nuevoDispositivoToken = crypto.randomBytes(32).toString('hex');
        dispositivosGuardados.push(nuevoDispositivoToken);
        if (dispositivosGuardados.length > 5) dispositivosGuardados.shift(); 

        await conn.execute(
            'UPDATE usuarios SET otp_code = NULL, otp_expires = NULL, dispositivo_token = ? WHERE id = ?', 
            [JSON.stringify(dispositivosGuardados), user.id]
        );

        const tokenPayload = { user: { id: user.id, username: user.username, correo: user.correo, rol: user.rol } };
        jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '8h' }, (err, token) => {
            if (err) return res.status(500).json({ message: 'Error al generar token' });
            // AGREGAMOS EL ROL A LA RESPUESTA
            res.json({ token, username: user.username, dispositivo_token: nuevoDispositivoToken, rol: user.rol });
        });
    } catch (err) {
        res.status(500).json({ message: 'Error interno' });
    }
});
// ==================== RECUPERACIÓN DE CONTRASEÑA ====================

// PASO 3: Solicitar código para recuperar contraseña
app.post('/api/auth/olvide-password', async (req, res) => {
    const { correo } = req.body;
    try {
        const conn = await obtenerConexion();
        const [rows] = await conn.execute('SELECT id, correo FROM usuarios WHERE correo = ?', [correo]);

        if (rows.length === 0) {
            return res.status(404).json({ message: 'No existe un usuario registrado con este correo.' });
        }

        const user = rows[0];
        const otp = crypto.randomInt(100000, 999999).toString();
        const expires = new Date(Date.now() + 10 * 60000); // 10 minutos para recuperar

        await conn.execute('UPDATE usuarios SET otp_code = ?, otp_expires = ? WHERE id = ?', [otp, expires, user.id]);

        const mailOptions = {
            from: `"Sistema de Planillas" <${process.env.EMAIL_USER}>`,
            to: user.correo,
            subject: 'Recuperación de Contraseña',
            html: `
                <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #ddd; border-radius: 10px; max-width: 500px;">
                    <h2 style="color: #0f172a;">Recuperación de Contraseña</h2>
                    <p>Has solicitado restablecer tu contraseña en el Sistema de Planillas.</p>
                    <p>Usa el siguiente código para crear una nueva contraseña:</p>
                    <h1 style="color: #10b981; letter-spacing: 5px; font-size: 32px;">${otp}</h1>
                    <p style="color: #64748b; font-size: 12px;">Este código expirará en 10 minutos. Si no solicitaste esto, ignora este correo.</p>
                </div>
            `
        };

        await transporter.sendMail(mailOptions);
        res.json({ message: 'Se ha enviado un código de recuperación a tu correo.' });
    } catch (err) {
        console.error('Error en olvide-password:', err);
        res.status(500).json({ message: 'Error interno al enviar el correo.' });
    }
});

// PASO 4: Validar código y cambiar la contraseña
app.post('/api/auth/reset-password', async (req, res) => {
    const { correo, otp, nuevaContrasena } = req.body;
    try {
        const conn = await obtenerConexion();
        const [rows] = await conn.execute('SELECT * FROM usuarios WHERE correo = ?', [correo]);

        if (rows.length === 0) return res.status(404).json({ message: 'Usuario no encontrado.' });

        const user = rows[0];

        if (user.otp_code !== otp) {
            return res.status(401).json({ message: 'El código de recuperación es incorrecto.' });
        }

        if (new Date() > new Date(user.otp_expires)) {
            return res.status(401).json({ message: 'El código ha expirado. Solicita uno nuevo.' });
        }

        // Encriptar la nueva contraseña
        const hash = await bcrypt.hash(nuevaContrasena, saltRounds);

        // Actualizar contraseña y limpiar OTP
        await conn.execute('UPDATE usuarios SET password = ?, otp_code = NULL, otp_expires = NULL WHERE id = ?', [hash, user.id]);

        res.json({ message: 'Tu contraseña ha sido actualizada correctamente. Ya puedes iniciar sesión.' });
    } catch (err) {
        console.error('Error en reset-password:', err);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// ==================== ENDPOINT RENIEC (GLOBAL, DATOS FICTICIOS) ====================
app.get('/reniec-consulta/:dni', async (req, res) => {
    const { dni } = req.params;
    if (!/^\d{8}$/.test(dni)) {
        return res.status(400).json({ mensaje: 'El DNI debe tener 8 dígitos.' });
    }
    return res.json(generarPersonaFicticia(dni));
});

// ============================================================
// === RUTAS DE "DATOS MAESTROS" (GLOBALES, SIN PERÍODO) ===
// ============================================================

app.get('/personas', verifyToken, async (req, res) => {
    const { periodo } = req.query;
    if (!periodo) return res.status(400).json({ message: 'Falta periodo.' });
    
    const fechaCorte = convertirPeriodoAFecha(periodo);
    
    // Si la fecha es inválida (ej. mes mal escrito), no buscamos nada
    if (!fechaCorte) {
        return res.status(400).json({ message: 'Periodo inválido o mes desconocido.' });
    }

    try {
        const conn = await obtenerConexion();
        
        const sql = `
            SELECT 
                p.*, 
                pr.descripcion AS profesion,
                e.id AS empleado_id, 
                e.tipo_contrato,
                COALESCE(
                    (SELECT h.nuevo_estado FROM persona_historial_estado h 
                     WHERE h.persona_id = p.id AND h.fecha_efectiva <= ? 
                     ORDER BY h.fecha_efectiva DESC LIMIT 1), 
                    'inactivo' 
                ) AS estado_historico
            FROM personas p
            LEFT JOIN profesiones pr ON p.profesion_id = pr.id
            LEFT JOIN empleados e ON p.id = e.persona_id
        `;
        // NOTA: Cambié el COALESCE(..., 'activo') por 'inactivo'.
        // Esto significa: "Si no sé qué pasó contigo antes de esta fecha, asumo que no estabas".
        
        const [rows] = await conn.execute(sql, [fechaCorte]);
        
        const personasProcesadas = rows.map(p => ({
            ...p,
            foto: p.foto ? (p.foto instanceof Buffer ? p.foto.toString('base64') : p.foto) : null,
            estado: p.estado_historico 
        }));
        
        res.json(personasProcesadas);
    } catch (err) { 
        console.error('Error GET /personas:', err); 
        res.status(500).json({ message: 'Error servidor' }); 
    }
});

// ==================== CAMBIAR ESTADO (BAJA REAL CON FECHA EN EMPLEADOS) ====================
app.post('/personas/cambiar-estado', verifyToken, async (req, res) => {
    const { persona_id, nuevo_estado, periodo, empleado_id, detalles_baja } = req.body;
    const usuario = req.authData?.user?.username || 'sistema';

    if (!persona_id || !nuevo_estado || !periodo) {
        return res.status(400).json({ message: 'Faltan datos.' });
    }

    // 1. Calculamos la fecha exacta (Ej: "2025-Octubre" -> "2025-10-01")
    const fecha_efectiva = convertirPeriodoAFecha(periodo);

    // Historial + personas + empleados van juntos: o se aplican los 3 o ninguno.
    const pool = await obtenerConexion();
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        // 2. Guardar en el Historial de la Persona (Rastro de auditoría)
        const sqlHistorial = "INSERT INTO persona_historial_estado (persona_id, nuevo_estado, fecha_efectiva, registrado_por, fecha_registro) VALUES (?, ?, ?, ?, NOW()) ON DUPLICATE KEY UPDATE nuevo_estado = ?, registrado_por = ?, fecha_registro = NOW()";
        await conn.execute(sqlHistorial, [
            persona_id, 
            nuevo_estado, 
            fecha_efectiva, 
            usuario, 
            nuevo_estado, 
            usuario
        ]);

        // 3. ACTUALIZAR TABLA PERSONAS (Estado global)
        const sqlUpdatePersona = "UPDATE personas SET estado = ? WHERE id = ?";
        await conn.execute(sqlUpdatePersona, [nuevo_estado, persona_id]);

        // === [ESTO ES LO QUE FALTABA EN TU CÓDIGO] ===
        // 4. ACTUALIZAR FECHA DE BAJA EN EMPLEADOS
        // Si lo estamos inactivando, marcamos la fecha en la tabla 'empleados'
        // para que el filtro de periodos sepa cuándo dejar de mostrarlo.
        if (nuevo_estado === 'inactivo' && empleado_id) {
            await conn.execute(
                "UPDATE empleados SET fecha_baja = ? WHERE id = ?", 
                [fecha_efectiva, empleado_id]
            );
            // El tramo laboral vigente se cierra en la misma transacción (la planilla lee de empleado_tramos)
            await cerrarTramoVigente(conn, empleado_id, fecha_efectiva, detalles_baja || null);
        }
        // ==============================================

        await conn.commit();

        // 5. Auditoría del Sistema
        if (empleado_id && detalles_baja && nuevo_estado === 'inactivo') {
            await registrarAuditoria(usuario, 'BAJA', empleado_id, req.ip, detalles_baja, req.headers['user-agent']);
        }

        res.status(200).json({ message: `Estado actualizado a ${nuevo_estado} en ${periodo}.` });

    } catch (err) {
        if (conn) await conn.rollback().catch(() => {});
        console.error('Error al cambiar estado:', err);
        res.status(500).json({ message: 'Error interno del servidor.' });
    } finally {
        if (conn) conn.release();
    }
});

// ==================== BAJA Y REINCORPORACIÓN DE EMPLEADOS ====================
// empleados tiene UNIQUE(persona_id): un trabajador tiene UNA sola fila de por vida.
// Dar de baja y reincorporar NUNCA insertan en empleados, solo hacen UPDATE de esa fila.
const REGEX_FECHA = /^\d{4}-\d{2}-\d{2}$/;

// Bloquea la fila del empleado (FOR UPDATE) para que dos bajas/reincorporaciones simultáneas no se pisen.
async function obtenerEmpleadoParaCambioEstado(conn, empleadoId) {
    const [rows] = await conn.execute(
        `SELECT e.id, e.persona_id,
                CAST(e.fecha_ingreso AS CHAR) AS fecha_ingreso,
                CAST(e.fecha_baja AS CHAR) AS fecha_baja,
                p.estado, p.dni,
                CONCAT(COALESCE(p.apellido_paterno,''), ' ', COALESCE(p.apellido_materno,''), ', ', COALESCE(p.nombre,'')) AS nombre_completo
         FROM empleados e JOIN personas p ON p.id = e.persona_id
         WHERE e.id = ? FOR UPDATE`,
        [empleadoId]
    );
    return rows[0] || null;
}

async function registrarHistorialEstado(conn, personaId, estado, fecha, usuario) {
    // El historial trabaja por periodo: GET /personas corta en el día 1 del mes, así que guardamos
    // el día 1 del mes de la fecha real (2026-03-10 -> 2026-03-01) para que el cambio se vea ese mismo mes.
    // La fecha exacta queda en empleados.fecha_baja / fecha_ingreso y en la auditoría.
    const fechaPeriodo = `${fecha.slice(0, 7)}-01`;
    // UNIQUE(persona_id, fecha_efectiva): si ya hay un movimiento en ese periodo, se sobrescribe.
    await conn.execute(
        `INSERT INTO persona_historial_estado (persona_id, nuevo_estado, fecha_efectiva, registrado_por, fecha_registro)
         VALUES (?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE nuevo_estado = VALUES(nuevo_estado), registrado_por = VALUES(registrado_por), fecha_registro = NOW()`,
        [personaId, estado, fechaPeriodo, usuario]
    );
}

// --- TRAMOS LABORALES (tabla empleado_tramos) ---
// empleados.fecha_ingreso / fecha_baja = tramo ACTUAL (lo usan las pantallas de mantenimiento).
// empleado_tramos = TODOS los tramos (lo usa el cálculo de planilla, exclusivamente).
// Por eso se escriben SIEMPRE juntos, con la misma conexión y dentro de la misma transacción.
async function abrirTramo(conn, empleadoId, fechaIngreso, origen, usuario) {
    // UNIQUE(empleado_id, abierto): si ya hay un tramo abierto, MariaDB lo rechaza (ER_DUP_ENTRY)
    await conn.execute(
        'INSERT INTO empleado_tramos (empleado_id, fecha_ingreso, origen, registrado_por) VALUES (?, ?, ?, ?)',
        [empleadoId, fechaIngreso || null, origen, usuario || 'sistema']
    );
}

async function cerrarTramoVigente(conn, empleadoId, fechaBaja, motivo) {
    const [r] = await conn.execute(
        'UPDATE empleado_tramos SET fecha_baja = ?, motivo_baja = ? WHERE empleado_id = ? AND fecha_baja IS NULL',
        [fechaBaja, motivo ? String(motivo).slice(0, 255) : null, empleadoId]
    );
    // Lanzar aborta la transacción completa: nunca queda empleados cerrado con el tramo abierto (o al revés)
    if (r.affectedRows !== 1) throw new Error(`El empleado ${empleadoId} no tiene un tramo laboral vigente que cerrar.`);
}

// --- DAR DE BAJA ---
app.post('/empleados/:id/baja', verifyToken, async (req, res) => {
    const empleadoId = req.params.id;
    const { fecha_baja, motivo, detalle } = req.body;
    const usuario = req.authData?.user?.username || 'sistema';

    if (!fecha_baja || !REGEX_FECHA.test(fecha_baja)) return res.status(400).json({ message: 'Fecha de baja inválida (AAAA-MM-DD).' });
    if (!motivo) return res.status(400).json({ message: 'El motivo de baja es obligatorio.' });

    const pool = await obtenerConexion();
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        const emp = await obtenerEmpleadoParaCambioEstado(conn, empleadoId);
        if (!emp) {
            await conn.rollback();
            return res.status(404).json({ message: 'Empleado no encontrado.' });
        }
        if (emp.fecha_baja) {
            await conn.rollback();
            return res.status(409).json({ message: `El empleado ya fue dado de baja el ${emp.fecha_baja}.` });
        }
        if (emp.fecha_ingreso && fecha_baja < emp.fecha_ingreso) {
            await conn.rollback();
            return res.status(400).json({ message: `La fecha de baja no puede ser anterior a la de ingreso (${emp.fecha_ingreso}).` });
        }

        await conn.execute('UPDATE empleados SET fecha_baja = ? WHERE id = ?', [fecha_baja, emp.id]);
        await cerrarTramoVigente(conn, emp.id, fecha_baja, `${motivo}${detalle ? ' - ' + detalle : ''}`);
        await conn.execute("UPDATE personas SET estado = 'inactivo' WHERE id = ?", [emp.persona_id]);
        await registrarHistorialEstado(conn, emp.persona_id, 'inactivo', fecha_baja, usuario);

        await conn.commit();

        await registrarAuditoria(usuario, 'BAJA', emp.id, req.ip,
            `BAJA: ${motivo} (${fecha_baja})${detalle ? ' - ' + detalle : ''}`, req.headers['user-agent']);

        res.json({ message: `${emp.nombre_completo} dado de baja con fecha ${fecha_baja}.` });
    } catch (err) {
        if (conn) await conn.rollback().catch(() => {});
        console.error('Error POST /empleados/:id/baja:', err);
        res.status(500).json({ message: 'Error interno al registrar la baja.' });
    } finally {
        if (conn) conn.release();
    }
});

// --- REINCORPORAR ---
app.post('/empleados/:id/reincorporar', verifyToken, async (req, res) => {
    const empleadoId = req.params.id;
    const { fecha_ingreso, detalle } = req.body;
    const usuario = req.authData?.user?.username || 'sistema';

    if (!fecha_ingreso || !REGEX_FECHA.test(fecha_ingreso)) return res.status(400).json({ message: 'Fecha de reingreso inválida (AAAA-MM-DD).' });

    const pool = await obtenerConexion();
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        const emp = await obtenerEmpleadoParaCambioEstado(conn, empleadoId);
        if (!emp) {
            await conn.rollback();
            return res.status(404).json({ message: 'Empleado no encontrado.' });
        }
        if (!emp.fecha_baja && emp.estado === 'activo') {
            await conn.rollback();
            return res.status(409).json({ message: 'El empleado ya está activo; no hay nada que reincorporar.' });
        }
        if (emp.fecha_baja && fecha_ingreso <= emp.fecha_baja) {
            await conn.rollback();
            return res.status(400).json({ message: `La fecha de reingreso debe ser posterior a la fecha de baja (${emp.fecha_baja}).` });
        }

        // Los tramos mandan: no puede haber uno abierto ni solaparse con la última baja registrada
        const [[tramos]] = await conn.execute(
            `SELECT SUM(fecha_baja IS NULL) AS abiertos, CAST(MAX(fecha_baja) AS CHAR) AS ultima_baja
             FROM empleado_tramos WHERE empleado_id = ?`, [emp.id]);
        if (Number(tramos.abiertos) > 0) {
            await conn.rollback();
            return res.status(409).json({ message: 'El empleado tiene un tramo laboral vigente; primero debe registrarse la baja.' });
        }
        if (tramos.ultima_baja && fecha_ingreso <= tramos.ultima_baja) {
            await conn.rollback();
            return res.status(400).json({ message: `La fecha de reingreso debe ser posterior a la última baja (${tramos.ultima_baja}).` });
        }

        // UPDATE (no INSERT): se reutiliza la misma fila por el UNIQUE(persona_id).
        await conn.execute('UPDATE empleados SET fecha_baja = NULL, fecha_ingreso = ? WHERE id = ?', [fecha_ingreso, emp.id]);
        // Nuevo tramo: el anterior (cerrado en la baja) se conserva, así la planilla suma ambos
        await abrirTramo(conn, emp.id, fecha_ingreso, 'REINCORPORACION', usuario);
        await conn.execute("UPDATE personas SET estado = 'activo' WHERE id = ?", [emp.persona_id]);
        await registrarHistorialEstado(conn, emp.persona_id, 'activo', fecha_ingreso, usuario);

        await conn.commit();

        await registrarAuditoria(usuario, 'REINCORPORACIÓN', emp.id, req.ip,
            `REINCORPORADO el ${fecha_ingreso} (baja anterior: ${emp.fecha_baja || '-'}, ingreso anterior: ${emp.fecha_ingreso || '-'})${detalle ? ' - ' + detalle : ''}`,
            req.headers['user-agent']);

        res.json({ message: `${emp.nombre_completo} reincorporado con fecha ${fecha_ingreso}.` });
    } catch (err) {
        if (conn) await conn.rollback().catch(() => {});
        console.error('Error POST /empleados/:id/reincorporar:', err);
        res.status(500).json({ message: 'Error interno al reincorporar.' });
    } finally {
        if (conn) conn.release();
    }
});

// --- LISTAR / BUSCAR EMPLEADOS DADOS DE BAJA (para reincorporarlos) ---
app.get('/empleados-inactivos', verifyToken, async (req, res) => {
    const term = (req.query.term || '').trim();
    try {
        const conn = await obtenerConexion();
        let sql = `
            SELECT e.id, e.persona_id, p.dni, e.tipo_contrato,
                   CONCAT(COALESCE(p.apellido_paterno,''), ' ', COALESCE(p.apellido_materno,''), ', ', COALESCE(p.nombre,'')) AS nombre_completo,
                   CAST(e.fecha_ingreso AS CHAR) AS fecha_ingreso,
                   CAST(e.fecha_baja AS CHAR) AS fecha_baja
            FROM empleados e JOIN personas p ON p.id = e.persona_id
            WHERE (e.fecha_baja IS NOT NULL OR p.estado = 'inactivo')`;
        const params = [];
        if (term) {
            if (/^\d+$/.test(term)) {
                sql += ' AND p.dni LIKE ?';
                params.push(`${term}%`);
            } else {
                sql += ` AND CONCAT_WS(' ', p.nombre, p.apellido_paterno, p.apellido_materno) LIKE ?`;
                params.push(`%${term}%`);
            }
        }
        sql += ' ORDER BY e.fecha_baja DESC, p.apellido_paterno ASC LIMIT 200';
        const [rows] = await conn.execute(sql, params);
        res.json(rows);
    } catch (err) {
        console.error('Error GET /empleados-inactivos:', err);
        res.status(500).json({ message: 'Error al buscar empleados inactivos.' });
    }
});
app.post('/buscar-persona-modal', verifyToken, async (req, res) => {
    // Ya no recibe 'periodo', solo busca por DNI en la tabla maestra
    const { dni } = req.body;
    if (!dni) {
        return res.status(400).send('Se requiere el DNI.');
    }
    try {
        const conn = await obtenerConexion();
        const [results] = await conn.execute(
        'SELECT p.*, pr.descripcion AS profesion FROM personas p LEFT JOIN profesiones pr ON p.profesion_id = pr.id WHERE p.dni = ?',
        [dni]
        );
        if (results.length === 0) {
            return res.status(404).json({ message: 'DNI no encontrado.' });
        }
        const persona = results[0];
        delete persona.contrasena;
        if (persona.foto && persona.foto instanceof Buffer) {
            persona.foto = persona.foto.toString('base64');
        } else if (typeof persona.foto === 'string' && persona.foto.length > 0) {
            persona.foto = persona.foto;
        } else {
            persona.foto = null;
        }
        res.json(persona);
    } catch (err) {
        console.error('Error al buscar persona:', err);
        return res.status(500).send('Error interno del servidor.');
    }
});

// ==================== CORRECCIÓN: CREAR PERSONA (SQL LIMPIO) ====================
app.post('/crear-persona', verifyToken, async (req, res) => {
    // 1. AHORA RECIBIMOS EL PERIODO
    const { dni, nombre, apellido_paterno, apellido_materno, contrasena, sexo, estado_civil, fecha_nacimiento, profesion, direccion, ubigeo, celular, correo, estado, foto, periodo } = req.body;
    
    if (!dni || !nombre) return res.status(400).json({ message: 'DNI y Nombre son obligatorios.' });

    try {
        const conn = await obtenerConexion();
        
        let profesionId = null;
        if (profesion) {
            const [rows] = await conn.execute('SELECT id FROM profesiones WHERE descripcion = ?', [profesion]);
            if (rows.length > 0) profesionId = rows[0].id;
        }

        const hash = await bcrypt.hash(contrasena || '123456', saltRounds);
        const buffer = foto ? Buffer.from(foto, 'base64') : null;
        const estadoIni = estado || 'activo';

        const [resIns] = await conn.execute(
            'INSERT INTO personas (dni, nombre, apellido_paterno, apellido_materno, contrasena, sexo, estado_civil, fecha_nacimiento, direccion, ubigeo, celular, profesion_id, correo, estado, foto) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [dni, nombre, apellido_paterno, apellido_materno, hash, sexo, estado_civil, fecha_nacimiento, direccion, ubigeo, celular, profesionId, correo, estadoIni, buffer]
        );
        
        const newId = resIns.insertId;
        const usuario = req.authData?.user?.username || 'sistema';
        
        // =========================================================================
        // === CORRECCIÓN CRÍTICA AQUÍ ===
        // Antes usaba: new Date() (Fecha de hoy)
        // Ahora usa: convertirPeriodoAFecha(periodo) (La fecha que seleccionaste)
        // =========================================================================
        let fechaInicio;
        if (periodo) {
            fechaInicio = convertirPeriodoAFecha(periodo);
        } else {
            // Solo si falla todo, usamos fecha actual
            const now = new Date();
            fechaInicio = `${now.getFullYear()}-${(now.getMonth()+1).toString().padStart(2,'0')}-01`;
        }
        
        await conn.execute(
            'INSERT INTO persona_historial_estado (persona_id, nuevo_estado, fecha_efectiva, registrado_por) VALUES (?, ?, ?, ?)',
            [newId, estadoIni, fechaInicio, usuario]
        );

        res.status(201).json({ message: 'Persona creada correctamente.', id: newId });

    } catch (err) {
        console.error(err);
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'El DNI o Correo ya existe.' });
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

app.put('/editar-persona/:id', verifyToken, async (req, res) => {
    // Ya no recibe 'periodo'
    const persona_id = req.params.id;
    const { periodo, ...datosActualizar } = req.body; // Ignoramos 'periodo' si llega
    
    try {
        const conn = await obtenerConexion();
        
        // Las validaciones de DNI y Correo ahora son simples
        if (datosActualizar.dni) {
            const [dniExiste] = await conn.execute(
                'SELECT id FROM personas WHERE dni = ? AND id != ?', 
                [datosActualizar.dni, persona_id]
            );
            if (dniExiste.length > 0) {
                return res.status(409).json({ message: 'El DNI ya está en uso por otro usuario.' });
            }
        }
        if (datosActualizar.correo && datosActualizar.correo.trim() !== '') {
            const [correoExiste] = await conn.execute(
                'SELECT id FROM personas WHERE correo = ? AND id != ?', 
                [datosActualizar.correo, persona_id]
            );
            if (correoExiste.length > 0) {
                return res.status(409).json({ message: 'El correo electrónico ya está en uso por otro usuario.' });
            }
        }
        
        if (datosActualizar.profesion !== undefined) {
            let profesionId = null;
            const [profesionRows] = await conn.execute(
                'SELECT id FROM profesiones WHERE descripcion = ?',
                [datosActualizar.profesion]
            );
            if (profesionRows.length > 0) {
                profesionId = profesionRows[0].id;
            }
            datosActualizar.profesion_id = profesionId;
            delete datosActualizar.profesion;
        }
        
        if (datosActualizar.foto && typeof datosActualizar.foto === 'string') {
            datosActualizar.foto = Buffer.from(datosActualizar.foto, 'base64');
        }
        if (Object.keys(datosActualizar).length === 0) {
            return res.status(400).json({ message: 'No se recibieron datos para actualizar.' });
        }

        const campos = Object.keys(datosActualizar);
        const valores = Object.values(datosActualizar);
        const setQuery = campos.map(campo => `${campo} = ?`).join(', ');
        valores.push(persona_id);

        // El WHERE ya no usa 'periodo'
        const [result] = await conn.execute(
            `UPDATE personas SET ${setQuery} WHERE id = ?`,
            valores
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Persona no encontrada.' });
        }
        res.status(200).json({ message: 'Persona actualizada con éxito.' });
    } catch (err) {
        console.error('Error al actualizar la persona:', err);
        res.status(500).json({ message: 'Error interno del servidor al actualizar la persona.' });
    }
});

app.delete('/eliminar-persona/:id', verifyToken, async (req, res) => {
    const { id } = req.params;
    const usuario = req.authData?.user?.username || 'sistema';
    // Borrado + auditoría en la misma transacción: o queda registrada la eliminación o no se elimina nada
    const pool = await obtenerConexion();
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        // ¿Es trabajador? (empleados cae en cascada junto con la persona)
        const [[trabajador]] = await conn.execute(`
            SELECT e.id AS empleado_id, p.dni,
                   CONCAT(COALESCE(p.apellido_paterno,''), ' ', COALESCE(p.apellido_materno,''), ', ', COALESCE(p.nombre,'')) AS nombre_completo
            FROM personas p JOIN empleados e ON e.persona_id = p.id WHERE p.id = ?`, [id]);

        const [result] = await conn.execute('DELETE FROM personas WHERE id = ?', [id]);
        if (result.affectedRows === 0) {
            await conn.rollback();
            return res.status(404).json({ message: 'Persona no encontrada.' });
        }

        if (trabajador) {
            // empleado_id va NULL: el empleado ya no existe. Nombre, DNI y código quedan en los detalles.
            // (Sus registros anteriores se conservan: la FK es ON DELETE SET NULL, ver migraciones/002.)
            await conn.execute(
                'INSERT INTO auditoria_empleados (usuario, accion, empleado_id, ip_address, user_agent, detalles) VALUES (?, ?, NULL, ?, ?, ?)',
                [usuario, 'ELIMINACIÓN', req.ip || null, req.headers['user-agent'] || null,
                 `Se eliminó al trabajador: ${trabajador.nombre_completo} (DNI ${trabajador.dni}, código de empleado ${trabajador.empleado_id})`]);
        }

        await conn.commit();
        res.status(200).json({ message: 'Persona eliminada con éxito.' });
    } catch (err) {
        if (conn) await conn.rollback().catch(() => {});
        console.error('Error al eliminar la persona:', err);
        res.status(500).json({ message: 'Error interno del servidor al eliminar la persona.' });
    } finally {
        if (conn) conn.release();
    }
});

app.get('/buscar-persona', verifyToken, async (req, res) => {
    // (Respetamos tu lógica actual, sin periodo aquí)
    const { type, term } = req.query;
    if (!term) {
        return res.status(200).json([]);
    }
    try {
        const conn = await obtenerConexion();
        let query;
        let params;

        // === CAMBIO CLAVE PARA JUDICIALES ===
        // Agregamos: e.id as empleado_id
        // Hacemos LEFT JOIN con empleados para saber si es trabajador o no
        const baseQuery = `
            SELECT 
                p.*, 
                pr.descripcion AS profesion,
                e.id as empleado_id,
                CAST(e.fecha_baja AS CHAR) as empleado_fecha_baja
            FROM personas p
            LEFT JOIN profesiones pr ON p.profesion_id = pr.id 
            LEFT JOIN empleados e ON p.id = e.persona_id
        `;

        if (type === 'dni') {
            query = `${baseQuery} WHERE p.dni = ?`;
            params = [term];
        } else {
            query = `${baseQuery} WHERE (p.nombre LIKE ? OR p.apellido_paterno LIKE ? OR p.apellido_materno LIKE ?)`;
            params = [`%${term}%`, `%${term}%`, `%${term}%`];
        }
        
        const [rows] = await conn.query(query, params);
        
        const personasCorregidas = rows.map(persona => {
            let fotoBase64 = null;
            if (persona.foto && persona.foto instanceof Buffer) { fotoBase64 = persona.foto.toString('base64'); } 
            else if (typeof persona.foto === 'string' && persona.foto.length > 0) { fotoBase64 = persona.foto; }
            return { ...persona, foto: fotoBase64, ubigeo: persona.ubigeo || '' };
        });
        res.status(200).json(personasCorregidas);
    } catch (err) {
        console.error('Error al buscar persona:', err);
        res.status(500).json({ message: 'Error interno del servidor al buscar persona.' });
    }
});

// --- PROFESIONES (GLOBAL) ---
app.get('/profesiones', verifyToken, async (req, res) => {
    // Ya no recibe 'periodo'
    try {
        const conn = await obtenerConexion();
        const [rows] = await conn.execute('SELECT * FROM profesiones');
        res.json(rows);
    } catch (err) {
        console.error('Error al obtener la lista de profesiones:', err);
        res.status(500).json({ message: 'Error interno del servidor al obtener las profesiones.' });
    }
});
app.post('/crear-profesion', verifyToken, async (req, res) => {
    // Ya no recibe 'periodo'
    const { descripcion, estado } = req.body;
    if (!descripcion || descripcion.trim() === '') {
        return res.status(400).json({ message: 'La descripción no puede estar vacía.' });
    }
    try {
        const conn = await obtenerConexion();
        // Validación simple
        const [rows] = await conn.execute(
            'SELECT id FROM profesiones WHERE LOWER(TRIM(descripcion)) = LOWER(TRIM(?))',
            [descripcion]
        );
        if (rows.length > 0) {
            return res.status(409).json({ message: `La profesión '${descripcion}' ya se encuentra registrada.` });
        }
        const [result] = await conn.execute(
            'INSERT INTO profesiones (descripcion, estado) VALUES (?, ?)',
            [descripcion.trim(), estado || 'activo']
        );
        res.status(201).json({ message: 'Profesión creada con éxito', id: result.insertId });
    } catch (err) {
        console.error('Error al crear profesión:', err);
        res.status(500).json({ message: 'Error interno del servidor al crear la profesión.' });
    }
});
app.put('/editar-profesion/:id', verifyToken, async (req, res) => {
    // Ya no recibe 'periodo'
    const { id } = req.params;
    const { periodo, ...datosActualizar } = req.body;
    if (Object.keys(datosActualizar).length === 0) {
        return res.status(400).json({ message: 'No se recibieron datos para actualizar.' });
    }
    try {
        const conn = await obtenerConexion();
        if (datosActualizar.descripcion) {
            const [rows] = await conn.execute(
                'SELECT id FROM profesiones WHERE LOWER(TRIM(descripcion)) = LOWER(TRIM(?)) AND id != ?',
                [datosActualizar.descripcion, id]
            );
            if (rows.length > 0) {
                return res.status(409).json({ message: `La profesión '${datosActualizar.descripcion}' ya existe.` });
            }
        }
        const campos = Object.keys(datosActualizar);
        const valores = Object.values(datosActualizar);
        const setQuery = campos.map(campo => `${campo} = ?`).join(', ');
        valores.push(id);
        const [result] = await conn.execute(
            `UPDATE profesiones SET ${setQuery} WHERE id = ?`,
            valores
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Profesión no encontrada.' });
        }
        res.status(200).json({ message: 'Profesión actualizada con éxito.' });
    } catch (err) {
        console.error('Error al actualizar la profesión:', err);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});
app.delete('/eliminar-profesion/:id', verifyToken, async (req, res) => {
    // Ya no recibe 'periodo'
    const { id } = req.params;
    try {
        const conn = await obtenerConexion();
        const [result] = await conn.execute('DELETE FROM profesiones WHERE id = ?', [id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Profesión no encontrada.' });
        }
        res.status(200).json({ message: 'Profesión eliminada con éxito.' });
    } catch (err) {
        console.error('Error al eliminar la profesión:', err);
        res.status(500).json({ message: 'Error interno del servidor al eliminar la profesión.' });
    }
});

// --- CARGOS (GLOBAL) ---
app.get('/cargos', verifyToken, async (req, res) => {
    // Ya no recibe 'periodo'
    try {
        const conn = await obtenerConexion();
        const [rows] = await conn.execute('SELECT id, descripcion, anio, estado FROM cargos');
        res.json(rows);
    } catch (err) {
        console.error('Error al obtener la lista de cargos:', err);
        res.status(500).json({ message: 'Error interno del servidor al obtener los cargos.' });
    }
});
app.get('/cargos/:id', verifyToken, async (req, res) => {
    // Ya no recibe 'periodo'
    const { id } = req.params;
    try {
        const conn = await obtenerConexion();
        const [rows] = await conn.execute('SELECT id, descripcion, anio, estado FROM cargos WHERE id = ?', [id]);
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Cargo no encontrado.' });
        }
        res.json(rows[0]);
    } catch (err) {
        console.error('Error al obtener cargo por ID:', err);
        res.status(500).json({ message: 'Error interno del servidor al obtener el cargo.' });
    }
});
app.post('/cargos', verifyToken, async (req, res) => {
    // Ya no recibe 'periodo'
    const { descripcion, anio, estado } = req.body;
    if (!descripcion || !anio || !estado) {
        return res.status(400).json({ message: 'La descripción, el año y el estado son obligatorios.' });
    }
    try {
        const conn = await obtenerConexion();
        const [result] = await conn.execute(
            'INSERT INTO cargos (descripcion, anio, estado) VALUES (?, ?, ?)',
            [descripcion, anio, estado]
        );
        res.status(201).json({ message: 'Cargo creado con éxito', id: result.insertId });
    } catch (err) {
        console.error('Error al crear cargo:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ message: 'Ya existe un cargo con esa descripción y año.' });
        }
        res.status(500).json({ message: 'Error interno del servidor al crear el cargo.' });
    }
});
app.put('/cargos/:id', verifyToken, async (req, res) => {
    // Ya no recibe 'periodo'
    const { id } = req.params;
    const { descripcion, anio, estado } = req.body;
    if (!descripcion || !anio || !estado) {
        return res.status(400).json({ message: 'La descripción, el año y el estado son obligatorios.' });
    }
    try {
        const conn = await obtenerConexion();
        const [result] = await conn.execute(
            'UPDATE cargos SET descripcion = ?, anio = ?, estado = ? WHERE id = ?',
            [descripcion, anio, estado, id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Cargo no encontrado.' });
        }
        res.status(200).json({ message: 'Cargo actualizado con éxito.' });
    } catch (err) {
        console.error('Error al actualizar el cargo:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ message: 'Ya existe un cargo con esa descripción y año.' });
        }
        res.status(500).json({ message: 'Error interno del servidor al actualizar el cargo.' });
    }
});
app.delete('/cargos/:id', verifyToken, async (req, res) => {
    // Ya no recibe 'periodo'
    const { id } = req.params;
    try {
        const conn = await obtenerConexion();
        const [result] = await conn.execute('DELETE FROM cargos WHERE id = ?', [id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Cargo no encontrado.' });
        }
        res.status(200).json({ message: 'Cargo eliminado con éxito.' });
    } catch (err) {
        console.error('Error al eliminar el cargo:', err);
        res.status(500).json({ message: 'Error interno del servidor al eliminar el cargo.' });
    }
});

// ==================== INICIALIZAR COMISIONES DESDE MAESTRO ====================
app.post('/comisiones-spp/inicializar', verifyToken, async (req, res) => {
    const { periodo } = req.body; // Recibimos "2025-Enero"

    if (!periodo) return res.status(400).json({ message: 'Falta el periodo.' });

    // 1. Convertimos el periodo visual a formato BD (ej: "2025-01")
    const periodoBD = formatearPeriodoParaSPP(periodo);
    if (!periodoBD) return res.status(400).json({ message: 'Periodo inválido.' });

    try {
        const conn = await obtenerConexion();

        // 2. Obtenemos TODOS los sistemas de pensiones activos (Habitat, Integra, etc.)
        const [sistemas] = await conn.execute("SELECT descripcion FROM sistemas_pensiones WHERE estado = 'activo'");

        if (sistemas.length === 0) {
            return res.status(400).json({ message: 'No hay Sistemas de Pensiones registrados en el maestro.' });
        }

        let contados = 0;

        // 3. Recorremos cada sistema y lo insertamos si no existe
        for (const sis of sistemas) {
            const nombreRegimen = sis.descripcion.toUpperCase();

            // Verificamos si YA existe para este periodo (para no duplicar)
            const [existe] = await conn.execute(
                "SELECT id FROM comisiones_spp WHERE regimen = ? AND periodo = ?",
                [nombreRegimen, periodoBD]
            );

            if (existe.length === 0) {
                // NO EXISTE: Lo creamos vacío (NULL en los números)
                await conn.execute(
                    "INSERT INTO comisiones_spp (regimen, periodo, estado, comision, comision_mixta, seguroprima, aporte) VALUES (?, ?, 'activo', NULL, NULL, NULL, NULL)",
                    [nombreRegimen, periodoBD]
                );
                contados++;
            }
        }

        res.json({ message: `Se generaron ${contados} registros vacíos basándose en los Sistemas de Pensiones.`, total: contados });

    } catch (err) {
        console.error('Error al inicializar:', err);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// ==================== SISTEMAS DE PENSIONES ====================

// Listar
app.get('/sistemas-pensiones', verifyToken, async (req, res) => {
    try {
        const conn = await obtenerConexion();
        const [rows] = await conn.execute('SELECT * FROM sistemas_pensiones');
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error al obtener sistemas de pensiones' });
    }
});

// Obtener uno por ID
app.get('/sistemas-pensiones/:id', verifyToken, async (req, res) => {
    try {
        const conn = await obtenerConexion();
        const [rows] = await conn.execute('SELECT * FROM sistemas_pensiones WHERE id = ?', [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ message: 'Sistema no encontrado' });
        res.json(rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error al obtener el sistema' });
    }
});

// Crear
app.post('/sistemas-pensiones', verifyToken, async (req, res) => {
    const { descripcion, estado } = req.body;
    if (!descripcion) return res.status(400).json({ message: 'La descripción es obligatoria' });
    try {
        const conn = await obtenerConexion();
        const [result] = await conn.execute(
            'INSERT INTO sistemas_pensiones (descripcion, estado) VALUES (?, ?)',
            [descripcion, estado || 'activo']
        );
        res.status(201).json({ message: 'Sistema de pensión creado', id: result.insertId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error al crear' });
    }
});

// Editar
app.put('/sistemas-pensiones/:id', verifyToken, async (req, res) => {
    const { descripcion, estado } = req.body;
    try {
        const conn = await obtenerConexion();
        const [result] = await conn.execute(
            'UPDATE sistemas_pensiones SET descripcion = ?, estado = ? WHERE id = ?',
            [descripcion, estado, req.params.id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ message: 'No encontrado' });
        res.json({ message: 'Actualizado correctamente' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error al actualizar' });
    }
});

// Eliminar
app.delete('/sistemas-pensiones/:id', verifyToken, async (req, res) => {
    try {
        const conn = await obtenerConexion();
        const [result] = await conn.execute('DELETE FROM sistemas_pensiones WHERE id = ?', [req.params.id]);
        if (result.affectedRows === 0) return res.status(404).json({ message: 'No encontrado' });
        res.json({ message: 'Eliminado correctamente' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error al eliminar' });
    }
});

// --- ÁREAS (GLOBAL) ---
app.get('/api/areas', verifyToken, async (req, res) => {
    // Ya no recibe 'periodo'
    try {
        const conn = await obtenerConexion();
        const [rows] = await conn.execute('SELECT id, descripcion, abreviatura, anio, estado FROM areas');
        res.json(rows);
    } catch (err) {
        console.error('Error al obtener la lista de áreas:', err);
        res.status(500).json({ message: 'Error interno del servidor al obtener las áreas.' });
    }
});
app.post('/api/areas', verifyToken, async (req, res) => {
    // Ya no recibe 'periodo'
    const { descripcion, abreviatura, anio, estado } = req.body;
    if (!descripcion) {
        return res.status(400).json({ message: 'La descripción es obligatoria.' });
    }
    const anioValue = anio ? parseInt(anio) : null; 
    try {
        const conn = await obtenerConexion();
        const [result] = await conn.execute(
            'INSERT INTO areas (descripcion, abreviatura, anio, estado) VALUES (?, ?, ?, ?)',
            [descripcion, abreviatura || null, anioValue, estado || 'activo']
        );
        res.status(201).json({ message: 'Área creada con éxito', id: result.insertId });
    } catch (err) {
        console.error('Error al crear área:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ message: 'Ya existe un área con esa descripción o abreviatura.' });
        }
        res.status(500).json({ message: 'Error interno del servidor al crear el área.' });
    }
});
app.get('/api/areas/:id', verifyToken, async (req, res) => {
    // Ya no recibe 'periodo'
    const { id } = req.params;
    try {
        const conn = await obtenerConexion();
        const [rows] = await conn.execute('SELECT id, descripcion, abreviatura, anio, estado FROM areas WHERE id = ?', [id]);
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Área no encontrada.' });
        }
        res.json(rows[0]);
    } catch (err) {
        console.error('Error al obtener área por ID:', err);
        res.status(500).json({ message: 'Error interno del servidor al obtener el área.' });
    }
});
app.put('/api/areas/:id', verifyToken, async (req, res) => { 
    // Ya no recibe 'periodo'
    const { id } = req.params;
    const { descripcion, abreviatura, anio, estado } = req.body;
    const anioValue = anio ? parseInt(anio) : null; 
    try {
        const conn = await obtenerConexion();
        const [result] = await conn.execute(
            'UPDATE areas SET descripcion = ?, abreviatura = ?, anio = ?, estado = ? WHERE id = ?',
            [descripcion, abreviatura || null, anioValue, estado, id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Área no encontrada.' });
        }
        res.status(200).json({ message: 'Área actualizada con éxito.' });
    } catch (err) {
        console.error('Error al actualizar el área:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ message: 'Ya existe un área con esa descripción o abreviatura.' });
        }
        res.status(500).json({ message: 'Error interno del servidor al actualizar el área.' });
    }
});
app.delete('/api/areas/:id', verifyToken, async (req, res) => { 
    // Ya no recibe 'periodo'
    const { id } = req.params;
    try {
        const conn = await obtenerConexion();
        const [result] = await conn.execute('DELETE FROM areas WHERE id = ?', [id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Área no encontrada.' });
        }
        res.status(200).json({ message: 'Área eliminada con éxito.' });
    } catch (err) {
        console.error('Error al eliminar el área:', err);
        res.status(500).json({ message: 'Error interno del servidor al eliminar el área.' });
    }
});

// --- GRUPOS OCUPACIONALES (GLOBAL) ---
app.get('/grupos-ocupacionales', verifyToken, async (req, res) => {
    // Ya no recibe 'periodo'
    try {
        const conn = await obtenerConexion();
        const [rows] = await conn.execute('SELECT id, grupo_ocasional, nivel_remunerativo, ds_320_2022_ef, estado FROM grupos_ocupacionales ORDER BY grupo_ocasional');
        res.status(200).json(rows);
    } catch (err) {
        console.error('Error en GET /grupos-ocupacionales:', err);
        res.status(500).json({ message: 'Error interno del servidor al obtener grupos ocupacionales.' });
    }
});
app.get('/grupos-ocupacionales/:id', verifyToken, async (req, res) => {
    // Ya no recibe 'periodo'
    const { id } = req.params;
    try {
        const conn = await obtenerConexion();
        const [rows] = await conn.execute('SELECT id, grupo_ocasional, nivel_remunerativo, ds_320_2022_ef, estado FROM grupos_ocupacionales WHERE id = ?', [id]);
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Grupo Ocupacional no encontrado.' });
        }
        res.status(200).json(rows[0]);
    } catch (err) {
        console.error(`Error en GET /grupos-ocupacionales/${id}:`, err);
        res.status(500).json({ message: 'Error interno del servidor al obtener el grupo ocupacional.' });
    }
});
// ==================== CORRECCIÓN: CREAR GRUPO OCUPACIONAL (MANEJO DE DUPLICADOS) ====================
app.post('/grupos-ocupacionales', verifyToken, async (req, res) => {
    const { grupo_ocasional, nivel_remunerativo, ds_320_2022_ef, estado } = req.body;

    if (!grupo_ocasional) {
        return res.status(400).json({ message: 'El campo "grupo_ocasional" es obligatorio.' });
    }

    const dsNumero = ds_320_2022_ef ? parseFloat(ds_320_2022_ef) : null;
    if (ds_320_2022_ef && isNaN(dsNumero)) {
        return res.status(400).json({ message: 'El campo "ds_320_2022_ef" debe ser un número válido.' });
    }

    try {
        const conn = await obtenerConexion();
        const sql = 'INSERT INTO grupos_ocupacionales (grupo_ocasional, nivel_remunerativo, ds_320_2022_ef, estado) VALUES (?, ?, ?, ?)';
        
        const [result] = await conn.execute(sql, [
            grupo_ocasional,
            nivel_remunerativo || null,
            dsNumero,
            estado || 'activo'
        ]);

        res.status(201).json({ message: 'Grupo Ocupacional creado con éxito.', id: result.insertId });

    } catch (err) {
        console.error('Error en POST /grupos-ocupacionales:', err);

        // --- AQUÍ ESTÁ LA SOLUCIÓN ---
        // Si el error es código 1062 (Duplicate entry), avisamos al usuario amablemente
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ message: `El grupo ocupacional '${grupo_ocasional}' ya existe. Intenta con otro nombre.` });
        }

        res.status(500).json({ message: 'Error interno del servidor al crear el grupo ocupacional.' });
    }
});
app.put('/grupos-ocupacionales/:id', verifyToken, async (req, res) => {
    // Ya no recibe 'periodo'
    const { id } = req.params;
    const { grupo_ocasional, nivel_remunerativo, ds_320_2022_ef, estado } = req.body;
    if (!grupo_ocasional) { 
        return res.status(400).json({ message: 'El campo "grupo_ocasional" no puede estar vacío.' });
    }
    const dsNumero = ds_320_2022_ef ? parseFloat(ds_320_2022_ef) : null;
    if (ds_320_2022_ef && isNaN(dsNumero)) {
        return res.status(400).json({ message: 'El campo "ds_320_2022_ef" debe ser un número válido.' });
    }
    try {
        const conn = await obtenerConexion();
        const sql = 'UPDATE grupos_ocupacionales SET grupo_ocasional = ?, nivel_remunerativo = ?, ds_320_2022_ef = ?, estado = ? WHERE id = ?';
        const [result] = await conn.execute(sql, [
            grupo_ocasional,
            nivel_remunerativo || null,
            dsNumero,
            estado || 'activo',
            id
        ]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Grupo Ocupacional no encontrado.' });
        }
        res.status(200).json({ message: 'Grupo Ocupacional actualizado con éxito.' });
    } catch (err) {
        console.error(`Error en PUT /grupos-ocupacionales/${id}:`, err);
        res.status(500).json({ message: 'Error interno del servidor al actualizar el grupo ocupacional.' });
    }
});
app.delete('/grupos-ocupacionales/:id', verifyToken, async (req, res) => {
    // Ya no recibe 'periodo'
    const { id } = req.params;
    try {
        const conn = await obtenerConexion();
        const [result] = await conn.execute('DELETE FROM grupos_ocupacionales WHERE id = ?', [id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Grupo Ocupacional no encontrado.' });
        }
        res.status(200).json({ message: 'Grupo Ocupacional eliminado con éxito.' });
    } catch (err) {
        console.error(`Error en DELETE /grupos-ocupacionales/${id}:`, err);
        if (err.code === 'ER_ROW_IS_REFERENCED_2') {
            return res.status(409).json({ message: 'No se puede eliminar el grupo ocupacional porque está asignado a uno o más empleados.' });
        }
        res.status(500).json({ message: 'Error interno del servidor al eliminar el grupo ocupacional.' });
    }
});


// =======================================================
// ========= RUTAS DE EMPLEADOS (LÓGICA MAESTRA) =========
// =======================================================

// --- RUTA 1: Buscar persona (para crear empleado) ---
app.post('/buscar-persona-para-crear-empleado', verifyToken, async (req, res) => {
    // Ya no recibe 'periodo'
    const { tipo: tipoRecibido, valor: valorDNI, valorNombre, valorApellido } = req.body;
    try {
        const conn = await obtenerConexion();
        let queryPersona = 'SELECT * FROM personas';
        let condiciones = [];
        let paramsPersona = [];
        
        if (tipoRecibido === 'dni') {
            if (!valorDNI || !/^\d{8}$/.test(valorDNI)) { return res.status(400).json({ message: 'Se requiere DNI válido (8 dígitos).' }); }
            condiciones.push('dni = ?');
            paramsPersona.push(valorDNI);
        } else if (tipoRecibido === 'nombre_apellido') {
            if (!valorNombre || !valorApellido) { return res.status(400).json({ message: 'Nombre y Apellido requeridos.' }); }
            condiciones.push('nombre LIKE ?');
            paramsPersona.push(`%${valorNombre}%`);
            const apellidosSeparados = valorApellido.split(/\s+/).filter(ap => ap.length > 0);
            if (apellidosSeparados.length === 1) {
                condiciones.push('(apellido_paterno LIKE ? OR apellido_materno LIKE ?)');
                paramsPersona.push(`%${apellidosSeparados[0]}%`);
                paramsPersona.push(`%${apellidosSeparados[0]}%`);
            } else if (apellidosSeparados.length >= 2) {
                condiciones.push('apellido_paterno LIKE ?');
                paramsPersona.push(`%${apellidosSeparados[0]}%`);
                condiciones.push('apellido_materno LIKE ?');
                paramsPersona.push(`%${apellidosSeparados[1]}%`);
            }
        } else if (tipoRecibido === 'nombre') {
            if (!valorNombre) { return res.status(400).json({ message: 'Nombre requerido.' }); }
            condiciones.push('nombre LIKE ?');
            paramsPersona.push(`%${valorNombre}%`);
        } else if (tipoRecibido === 'apellido') {
            if (!valorApellido) { return res.status(400).json({ message: 'Apellido requerido.' }); }
            const apellidosSeparados = valorApellido.split(/\s+/).filter(ap => ap.length > 0);
            if (apellidosSeparados.length === 1) {
                condiciones.push('(apellido_paterno LIKE ? OR apellido_materno LIKE ?)');
                paramsPersona.push(`%${apellidosSeparados[0]}%`);
                paramsPersona.push(`%${apellidosSeparados[0]}%`);
            } else if (apellidosSeparados.length >= 2) {
                condiciones.push('apellido_paterno LIKE ?');
                paramsPersona.push(`%${apellidosSeparados[0]}%`);
                condiciones.push('apellido_materno LIKE ?');
                paramsPersona.push(`%${apellidosSeparados[1]}%`);
            }
        } else {
            return res.status(400).json({ message: 'Tipo de búsqueda inválido.' });
        }

        queryPersona += ` WHERE ${condiciones.join(' AND ')}`;
        const [personas] = await conn.query(queryPersona, paramsPersona);
        
        if (personas.length === 0) return res.status(404).json({ message: 'No se encontró ninguna persona con ese criterio.' });
        if (personas.length > 1) return res.status(400).json({ message: 'La búsqueda arrojó varios resultados. Use DNI.' });
        
        const persona = personas[0];
        
        // Validación: ¿Ya es un empleado en la tabla MAESTRA?
        const [empleadoExiste] = await conn.execute('SELECT id FROM empleados WHERE persona_id = ?', [persona.id]);
        if (empleadoExiste.length > 0) return res.status(409).json({ message: 'Esta persona ya es un empleado.' });
        
        if (persona.foto && persona.foto instanceof Buffer) persona.foto = persona.foto.toString('base64');
        res.status(200).json(persona);
    } catch (err) { console.error('Error en /buscar-persona-para-crear-empleado:', err); res.status(500).json({ message: 'Error interno del servidor.' }); }
});

// --- RUTA 2: Buscar empleado (para editar) ---
app.post('/buscar-empleado-para-editar', verifyToken, async (req, res) => {
    // Ya no recibe 'periodo'
    const { tipo, valor } = req.body;
    if (!valor) return res.status(400).json({ message: 'Se requiere un DNI o nombre.' });
    try {
        const conn = await obtenerConexion();
        let queryBase = `SELECT p.id AS persona_id, p.dni, p.nombre, p.apellido_paterno, p.apellido_materno, p.foto, e.* FROM personas p JOIN empleados e ON p.id = e.persona_id`;
        let queryCompleta, params;
        if (tipo === 'dni') {
            queryCompleta = `${queryBase} WHERE p.dni = ?`; 
            params = [valor];
        } else {
            queryCompleta = `${queryBase} WHERE (p.nombre LIKE ? OR p.apellido_paterno LIKE ? OR p.apellido_materno LIKE ?)`; 
            params = [`%${valor}%`, `%${valor}%`, `%${valor}%`];
        }
        const [empleados] = await conn.query(queryCompleta, params);
        if (empleados.length === 0) return res.status(404).json({ message: 'No se encontró empleado con ese criterio.' });
        if (empleados.length > 1) return res.status(400).json({ message: 'La búsqueda arrojó varios resultados.' });
        
        const empleado = empleados[0];
        if (empleado.foto && empleado.foto instanceof Buffer) empleado.foto = empleado.foto.toString('base64');
        res.status(200).json(empleado);
    } catch (err) { console.error('Error en /buscar-empleado-para-editar:', err); res.status(500).json({ message: 'Error interno del servidor.' }); }
});

// ==================== AUDITORÍA DE LA FICHA DEL TRABAJADOR ====================
// Lee la ficha con descripciones legibles (no IDs) para poder comparar antes/después de una edición.
async function leerFichaEmpleado(conn, empleadoId) {
    const [rows] = await conn.execute(`
        SELECT CONCAT(COALESCE(p.apellido_paterno,''), ' ', COALESCE(p.apellido_materno,''), ', ', COALESCE(p.nombre,'')) AS nombre_completo,
               p.dni,
               ar.descripcion AS area, c.descripcion AS cargo, CAST(e.fecha_ingreso AS CHAR) AS fecha_ingreso,
               e.tipo_contrato, e.subtipo, e.motivos, e.referencia, e.es_funcionario, e.funcionario_detalle,
               e.regimen_sin_efecto, e.regimen_detalle, CONCAT_WS(' - ', m.meta, m.descripcion) AS meta,
               sp.descripcion AS sistema_pension, CONCAT_WS(' ', go.grupo_ocasional, go.nivel_remunerativo) AS nivel,
               e.cuspp, e.tipo_comision, e.rem_basica, e.asig_familiar_monto, e.sin_regimen
        FROM empleados e
        JOIN personas p ON p.id = e.persona_id
        LEFT JOIN areas ar ON ar.id = e.area_id
        LEFT JOIN cargos c ON c.id = e.cargo_id
        LEFT JOIN metas m ON m.id = e.meta_id
        LEFT JOIN sistemas_pensiones sp ON sp.id = e.sistema_pension_id
        LEFT JOIN grupos_ocupacionales go ON go.id = e.grupo_ocupacional_id
        WHERE e.id = ?`, [empleadoId]);
    return rows[0] || null;
}

const CAMPOS_FICHA_AUDITADOS = [
    ['area', 'Área'], ['cargo', 'Cargo'], ['fecha_ingreso', 'F. ingreso'], ['tipo_contrato', 'Tipo'], ['subtipo', 'Subtipo'],
    ['es_funcionario', 'Funcionario'], ['funcionario_detalle', 'Detalle funcionario'], ['regimen_sin_efecto', 'Reincorporado'],
    ['regimen_detalle', 'Detalle reincorporado'], ['sin_regimen', 'Sin régimen'], ['meta', 'Meta'], ['sistema_pension', 'Sist. pensiones'],
    ['tipo_comision', 'Comisión AFP'], ['cuspp', 'CUSPP'], ['nivel', 'Nivel ocupacional'], ['rem_basica', 'Rem. básica'],
    ['asig_familiar_monto', 'Asig. familiar'], ['motivos', 'Motivos'], ['referencia', 'Referencia']
];

// campos: [[campo, etiqueta, formato?]] -> ['Cargo: A → B', ...] solo con los que cambiaron
function resumirCambios(antes, despues, campos) {
    const normalizar = (v) => {
        if (v === null || v === undefined) return '';
        const t = String(v).trim();
        if (/^-?\d+(\.\d+)?$/.test(t)) return String(Number(t));   // 0.00 == 0, 50.00 == 50
        return t;
    };
    const mostrar = (v, formato) => {
        const t = normalizar(v);
        if (!t) return '(vacío)';
        if (formato) return formato(t);
        return t.length > 40 ? t.slice(0, 37) + '...' : t;
    };
    return campos
        .filter(([campo]) => normalizar(antes[campo]) !== normalizar(despues[campo]))
        .map(([campo, etiqueta, formato]) => `${etiqueta}: ${mostrar(antes[campo], formato)} → ${mostrar(despues[campo], formato)}`);
}

const resumirCambiosFicha = (antes, despues) => resumirCambios(antes, despues, CAMPOS_FICHA_AUDITADOS);

// ==================== CREAR EMPLEADO (GUARDANDO EL PERIODO) ====================
app.post('/empleados', verifyToken, async (req, res) => {
    const body = req.body;
    const periodo = body.periodo; // IMPORTANTE: Recibimos el periodo
    const usuario = req.authData?.user?.username || 'sistema';

    // empleado + su primer tramo laboral + historial: todo o nada
    const pool = await obtenerConexion();
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();
        
        // Agregamos 'periodo' al INSERT
        const sql = `
            INSERT INTO empleados (
                persona_id, area_id, cargo_id, fecha_ingreso, tipo_contrato, subtipo, 
                motivos, referencia, es_funcionario, funcionario_detalle, 
                regimen_sin_efecto, regimen_detalle, meta_id, sistema_pension_id, 
                grupo_ocupacional_id, cuspp, tipo_comision, rem_basica, 
                asig_familiar_monto, sin_regimen, periodo
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        
        const [r] = await conn.execute(sql, [
            body.persona_id, 
            body.area_id || null, 
            body.cargo_id || null, 
            body.fecha_ingreso || null, 
            body.tipo_contrato || null, 
            body.subtipo || null, 
            body.motivos || null, 
            body.referencia || null, 
            body.es_funcionario || 'No', 
            body.funcionario_detalle || null, 
            body.regimen_sin_efecto || 'No', 
            body.regimen_detalle || null, 
            body.meta_id || null, 
            body.sistema_pension_id || null, 
            body.grupo_ocupacional_id || null,
            body.cuspp || null,
            body.tipo_comision || null,
            body.rem_basica || 0,
            body.asignacion_familiar || 0,
            body.sin_regimen ? 1 : 0,
            periodo // <--- AQUÍ SE GUARDA EL DATO CLAVE
        ]);

        // Primer tramo laboral (la planilla lee de empleado_tramos)
        await abrirTramo(conn, r.insertId, body.fecha_ingreso || null, 'ALTA', usuario);

        const fichaNueva = await leerFichaEmpleado(conn, r.insertId);

        // Lógica de Historial de Estado (si aplica)
        if (periodo) {
            const fechaEfectiva = convertirPeriodoAFecha(periodo);
            if(fechaEfectiva) {
                await conn.execute("INSERT INTO persona_historial_estado (persona_id, nuevo_estado, fecha_efectiva, registrado_por, fecha_registro) VALUES (?, 'activo', ?, 'sistema', NOW()) ON DUPLICATE KEY UPDATE nuevo_estado = 'activo', fecha_registro = NOW()", [body.persona_id, fechaEfectiva]);
            }
        }
        
        await conn.commit();

        await registrarAuditoria(usuario, 'CREACIÓN', r.insertId, req.ip,
            `Se registró nuevo trabajador: ${fichaNueva.nombre_completo} (DNI ${fichaNueva.dni}) - periodo ${periodo}`,
            req.headers['user-agent']);
        res.status(201).json({ message: 'Empleado creado.', id: r.insertId });

    } catch (e) { 
        if (conn) await conn.rollback().catch(() => {});
        if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Ya existe.' });
        console.error(e);
        res.status(500).json({ message: 'Error crear empleado: ' + e.message }); 
    } finally {
        if (conn) conn.release();
    }
});

// ==================== LISTAR EMPLEADOS (LÓGICA FINAL: INGRESO DENTRO DEL MES) ====================
app.get('/empleados', verifyToken, async (req, res) => {
    try {
        const { periodo } = req.query; 
        const conn = await obtenerConexion();
        
        console.log(`\n--- 🔍 DIAGNÓSTICO FINAL PARA: ${periodo} ---`);

        // 1. TRAEMOS TODO DE LA BD (Para filtrar con precisión en JS)
        let sql = `
            SELECT 
                e.id, 
                p.dni, 
                CONCAT(COALESCE(p.apellido_paterno,''), ' ', COALESCE(p.apellido_materno,''), ', ', COALESCE(p.nombre,'SIN NOMBRE')) as nombre_completo,
                c.descripcion as cargo, 
                a.descripcion as area, 
                sp.descripcion as sistema_pension, 
                e.tipo_contrato, 
                e.cuspp,
                e.sin_regimen,
                CAST(e.fecha_ingreso AS CHAR) as f_ingreso, 
                CAST(e.fecha_baja AS CHAR) as f_baja,       
                p.estado as estado_persona
            FROM empleados e
            LEFT JOIN personas p ON e.persona_id = p.id
            LEFT JOIN cargos c ON e.cargo_id = c.id
            LEFT JOIN areas a ON e.area_id = a.id
            LEFT JOIN sistemas_pensiones sp ON e.sistema_pension_id = sp.id
            ORDER BY p.apellido_paterno ASC
        `;
        
        const [allRows] = await conn.execute(sql);
        console.log(`📊 TOTAL REGISTROS EN BD: ${allRows.length}`);

        // 2. PREPARAR FECHAS DE CORTE
        // Inicio del mes (ej: 2025-01-01 00:00:00)
        const fechaInicioStr = periodo ? convertirPeriodoAFecha(periodo) : null;
        let fechaInicioMes = null;
        let fechaFinMes = null;

        if (fechaInicioStr) {
            // Creamos fechas usando UTC o string para evitar problemas de zona horaria (-5 horas)
            const parts = fechaInicioStr.split('-');
            // Mes en JS es 0-11
            fechaInicioMes = new Date(parts[0], parts[1] - 1, 1);
            
            // Fin de mes: Día 0 del siguiente mes
            fechaFinMes = new Date(parts[0], parts[1], 0);
            fechaFinMes.setHours(23, 59, 59, 999); // Final del último día
        }

        const empleadosFiltrados = [];

        allRows.forEach(emp => {
            let pasaFiltro = true;
            let motivoRechazo = "";

            if (fechaInicioMes && fechaFinMes) {
                
                // --- A) VALIDACIÓN DE INGRESO ---
                // Debe haber entrado ANTES de que se acabe el mes.
                if (emp.f_ingreso && emp.f_ingreso !== '0000-00-00' && emp.f_ingreso !== '') {
                    const pIng = emp.f_ingreso.split('-');
                    const dIngreso = new Date(pIng[0], pIng[1] - 1, pIng[2]);

                    // CORRECCIÓN: Comparamos contra el FIN del mes, no el inicio.
                    if (dIngreso > fechaFinMes) {
                        pasaFiltro = false;
                        motivoRechazo = `Ingreso Futuro (${emp.f_ingreso})`;
                    }
                }
                // (Si no tiene fecha, pasa como antiguo)

                // --- B) VALIDACIÓN DE BAJA ---
                // Debe irse DESPUÉS de que empiece el mes (o no irse nunca).
                if (emp.f_baja && emp.f_baja !== '0000-00-00' && emp.f_baja !== '') {
                    const pBaja = emp.f_baja.split('-');
                    const dBaja = new Date(pBaja[0], pBaja[1] - 1, pBaja[2]);
                    // Truco: Le damos hasta el final del día de la baja
                    dBaja.setHours(23, 59, 59, 999); 

                    // Si se fue antes de que empezara este mes (ej: baja en Dic, estamos en Ene) -> FUERA
                    if (dBaja < fechaInicioMes) {
                        pasaFiltro = false;
                        motivoRechazo = `Baja Pasada (${emp.f_baja})`;
                    }
                }
            }

            if (pasaFiltro) {
                // Estado visual (Rojo/Verde)
                let estadoVisual = 'activo';
                if (fechaFinMes && emp.f_baja && emp.f_baja !== '0000-00-00') {
                    const pBaja = emp.f_baja.split('-');
                    const dBaja = new Date(pBaja[0], pBaja[1] - 1, pBaja[2]);
                    
                    // Si la fecha de baja es menor al fin de mes actual -> Inactivo visualmente
                    if (dBaja < fechaFinMes) estadoVisual = 'inactivo';
                }

                empleadosFiltrados.push({
                    ...emp,
                    fecha_ingreso: emp.f_ingreso,
                    fecha_baja: emp.f_baja,
                    sin_regimen: emp.sin_regimen === 1,
                    estado: estadoVisual
                });
            } else {
                console.log(`❌ OCULTO: ${emp.nombre_completo} -> Razón: ${motivoRechazo}`);
            }
        });

        console.log(`✅ MOSTRANDO FINALMENTE: ${empleadosFiltrados.length} empleados.`);
        res.json(empleadosFiltrados);

    } catch (error) { 
        console.error("Error al listar empleados:", error);
        res.status(500).json({ message: "Error al listar empleados" }); 
    }
});

// ==================== 3. EDITAR EMPLEADO (VERSIÓN FINAL SEGURA) ====================
app.put('/empleados/:id', verifyToken, async (req, res) => {
    const id = req.params.id;
    const body = req.body;

    console.log(`[PUT] Actualizando Empleado ID: ${id} | Periodo: ${body.periodo}`);

    const pool = await obtenerConexion();
    const conn = pool;   // pasos 2 y 3 (tasas AFP, auditoría) como antes
    let tx;
    try {
        // 1. ACTUALIZAR DATOS + fecha de ingreso del tramo vigente, en una transacción
        tx = await pool.getConnection();
        await tx.beginTransaction();

        // Ficha ANTES de editar (para el resumen de cambios del historial)
        const fichaAntes = await leerFichaEmpleado(tx, id);
        if (!fichaAntes) {
            await tx.rollback();
            tx.release(); tx = null;
            return res.status(404).json({ message: 'Empleado no encontrado.' });
        }

        const nuevaFechaIngreso = body.fecha_ingreso || null;
        // Tramo actual = el de ingreso más reciente; su anterior define hasta dónde se puede mover el ingreso
        const [tramosEmp] = await tx.execute(
            `SELECT id, CAST(fecha_ingreso AS CHAR) AS ingreso, CAST(fecha_baja AS CHAR) AS baja
             FROM empleado_tramos WHERE empleado_id = ?
             ORDER BY fecha_ingreso IS NULL DESC, fecha_ingreso ASC, id ASC FOR UPDATE`, [id]);
        const tramoActual = tramosEmp[tramosEmp.length - 1];
        const tramoPrevio = tramosEmp[tramosEmp.length - 2];
        if (tramoActual && (tramoActual.ingreso || null) !== nuevaFechaIngreso) {
            let error = null;
            if (tramoPrevio && tramoPrevio.baja && (!nuevaFechaIngreso || nuevaFechaIngreso <= tramoPrevio.baja))
                error = `La fecha de ingreso debe ser posterior a la baja del tramo anterior (${tramoPrevio.baja}).`;
            else if (tramoActual.baja && nuevaFechaIngreso && nuevaFechaIngreso > tramoActual.baja)
                error = `La fecha de ingreso no puede ser posterior a su fecha de baja (${tramoActual.baja}).`;
            if (error) {
                await tx.rollback();
                tx.release(); tx = null;
                return res.status(400).json({ message: error });
            }
            await tx.execute('UPDATE empleado_tramos SET fecha_ingreso = ? WHERE id = ?', [nuevaFechaIngreso, tramoActual.id]);
        }

        const sql = `
            UPDATE empleados SET 
                area_id=?, cargo_id=?, fecha_ingreso=?, tipo_contrato=?, subtipo=?, 
                motivos=?, referencia=?, es_funcionario=?, funcionario_detalle=?, 
                regimen_sin_efecto=?, regimen_detalle=?, 
                meta_id=?, sistema_pension_id=?, grupo_ocupacional_id=?, 
                cuspp=?, tipo_comision=?, 
                rem_basica=?, 
                asig_familiar_monto=?, 
                sin_regimen=? 
            WHERE id=?
        `;

        await tx.execute(sql, [
            body.area_id || null, 
            body.cargo_id || null, 
            body.fecha_ingreso || null, 
            body.tipo_contrato || null, 
            body.subtipo || null, 
            body.motivos || null, 
            body.referencia || null, 
            body.es_funcionario || 'No', 
            body.funcionario_detalle || null, 
            body.regimen_sin_efecto || 'No', 
            body.regimen_detalle || null, 
            body.meta_id || null, 
            body.sistema_pension_id || null, 
            body.grupo_ocupacional_id || null, 
            body.cuspp || null, 
            body.tipo_comision || null, 
            body.rem_basica || 0, 
            body.asignacion_familiar || 0, 
            body.sin_regimen ? 1 : 0, 
            id
        ]);

        // Cambio de régimen: préstamos, judiciales y cuota sindical pasan al concepto del nuevo régimen
        if ((fichaAntes.tipo_contrato || null) !== (body.tipo_contrato || null)) await sincronizarDescuentosEmpleado(tx, id);

        // Ficha DESPUÉS (misma transacción) -> qué cambió exactamente
        const fichaDespues = await leerFichaEmpleado(tx, id);
        const cambios = resumirCambiosFicha(fichaAntes, fichaDespues);

        await tx.commit();
        tx.release(); tx = null;

        // 2. LÓGICA DE ACTUALIZACIÓN DE TASAS AFP
        if (body.sistema_pension_id) {
            // AQUI ESTABA EL ERROR: USAMOS EL PERIODO DIRECTO DEL BODY
            const periodoVisual = body.periodo; 

            if (periodoVisual) {
                const formatearPeriodoLocal = (p) => { 
                    if(!p) return null; 
                    const partes = p.split('-'); 
                    if(partes.length < 2) return p;
                    const mes = { 'Enero':'01', 'Febrero':'02', 'Marzo':'03', 'Abril':'04', 'Mayo':'05', 'Junio':'06', 'Julio':'07', 'Agosto':'08', 'Septiembre':'09', 'Octubre':'10', 'Noviembre':'11', 'Diciembre':'12' }[partes[1]];
                    return `${partes[0]}-${mes}`; 
                };
                const periodoBD = formatearPeriodoLocal(periodoVisual); 
                
                const [rowsSis] = await conn.execute("SELECT descripcion FROM sistemas_pensiones WHERE id = ?", [body.sistema_pension_id]);
                
                if (rowsSis.length > 0 && periodoBD) {
                    const nombreSistema = rowsSis[0].descripcion.toUpperCase();
                    const [rowsTasa] = await conn.execute(
                        "SELECT comision, comision_mixta FROM comisiones_spp WHERE regimen LIKE CONCAT('%', ?, '%') AND periodo = ? LIMIT 1", 
                        [nombreSistema, periodoBD]
                    );

                    if (rowsTasa.length > 0) {
                        const t = rowsTasa[0];
                        let tasaReal = 0;
                        
                        if (!nombreSistema.includes('ONP') && !nombreSistema.includes('NACIONAL')) {
                            if (body.tipo_comision === 'Flujo') tasaReal = parseFloat(t.comision) || 0;
                            else if (body.tipo_comision === 'Mixta') tasaReal = parseFloat(t.comision_mixta) || 0;
                        }

                        const sqlRestore = `
                            UPDATE empleado_conceptos ec
                            INNER JOIN conceptos c ON ec.concepto_id = c.id
                            SET ec.monto = ?
                            WHERE ec.empleado_id = ? 
                            AND (c.nombre LIKE '%COMISION%' OR c.nombre LIKE '%COMISIÓN%')
                        `;
                        await conn.execute(sqlRestore, [tasaReal, id]);
                    }
                }
            }
        }

        // 3. AUDITORÍA
        const usuario = req.authData?.user?.username || 'sistema';
        await registrarAuditoria(usuario, 'EDICIÓN', id, req.ip,
            cambios.length
                ? `Se actualizaron los datos del trabajador ${fichaAntes.nombre_completo}: ${cambios.join('; ')}`
                : `Se actualizaron los datos del trabajador ${fichaAntes.nombre_completo} (sin cambios en la ficha)`,
            req.headers['user-agent']);
        
        res.json({ message: 'Empleado actualizado correctamente.' });

    } catch (e) { 
        if (tx) { await tx.rollback().catch(() => {}); tx.release(); }
        console.error('Error en PUT /empleados:', e);
        res.status(500).json({ message: 'Error al actualizar: ' + e.message }); 
    }
});

// ==================== CORRECCIÓN: BUSCAR EMPLEADO POR ID (SQL LIMPIO) ====================
app.get('/buscar-empleado-por-id/:id', verifyToken, async (req, res) => {
    const { id } = req.params;
    try {
        const conn = await obtenerConexion();
        
        // SQL Limpio en una sola línea
        const query = "SELECT p.id AS persona_id, p.dni, p.nombre, p.apellido_paterno, p.apellido_materno, p.foto, e.* FROM personas p JOIN empleados e ON p.id = e.persona_id WHERE e.id = ?";
        
        const [empleados] = await conn.query(query, [id]);
        
        if (empleados.length === 0) {
            return res.status(404).json({ message: 'Empleado no encontrado.' });
        }
        
        const empleado = empleados[0];
        
        // Convertir foto a Base64 si existe
        if (empleado.foto && empleado.foto instanceof Buffer) {
            empleado.foto = empleado.foto.toString('base64');
        } else if (typeof empleado.foto === 'string') {
             // Si ya es string, lo dejamos tal cual
        } else {
            empleado.foto = null;
        }
        
        res.status(200).json(empleado);
    } catch (err) {
        console.error('Error en /buscar-empleado-por-id/:id:', err);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// --- RUTAS DE AUDITORÍA (No cambian) ---
app.get('/empleados/historial/:id', verifyToken, async (req, res) => {
    const { id } = req.params; 
    if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({ message: 'Se requiere un ID de empleado numérico válido.' });
    }
    const empleadoId = parseInt(id);
    try {
        const conn = await obtenerConexion();
        const sql = `SELECT id, DATE_FORMAT(fecha_hora, '%Y-%m-%d %H:%i:%s') as fecha_hora_formato, usuario, accion, ip_address, user_agent, detalles
            FROM auditoria_empleados
            WHERE empleado_id = ?
            ORDER BY fecha_hora DESC, id DESC`;
        const [historial] = await conn.execute(sql, [empleadoId]);
        if (historial.length === 0) {
            return res.status(200).json([]);
        }
        res.status(200).json(historial);
    } catch (err) {
        console.error(`Error al obtener historial para empleado ID ${id}:`, err);
        res.status(500).json({ message: 'Error interno del servidor al obtener el historial.' });
    }
});

// El modal "Historial Completo" de Trabajadores muestra solo operaciones sobre trabajadores
// (creación, edición, eliminación, bajas, reincorporaciones, préstamos, judiciales).
// Estas acciones se siguen guardando en auditoria_empleados, pero no se muestran ahí:
const ACCIONES_FUERA_DE_HISTORIAL_TRABAJADORES = [
    'CAMBIO_PERIODO', 'CIERRE_PLANILLA', 'REAPERTURA_PLANILLA',
    'EDICIÓN CONFIGURACIÓN', 'CREACIÓN SINDICATO', 'EDICIÓN SINDICATO', 'ELIMINACIÓN SINDICATO',
    'CREACIÓN CONCEPTO CATÁLOGO', 'EDICIÓN CONCEPTO CATÁLOGO', 'DESACTIVACIÓN CONCEPTO CATÁLOGO'
];

app.get('/empleados/historial-completo', verifyToken, async (req, res) => {
    console.log("Solicitud recibida para /empleados/historial-completo");
    try {
        const conn = await obtenerConexion();
        
        // HE LIMPIADO ESTA LÍNEA PARA ELIMINAR CARACTERES OCULTOS:
        const sql = "SELECT a.id, DATE_FORMAT(a.fecha_hora, '%Y-%m-%d %H:%i:%s') as fecha_hora_formato, a.usuario, a.accion, a.empleado_id, p.dni as empleado_dni, IF(p.id IS NULL, NULL, CONCAT(COALESCE(p.apellido_paterno,''), ' ', COALESCE(p.apellido_materno,''), ', ', COALESCE(p.nombre,''))) as empleado_nombre, a.ip_address, a.user_agent, a.detalles FROM auditoria_empleados a LEFT JOIN empleados e ON a.empleado_id = e.id LEFT JOIN personas p ON e.persona_id = p.id " +
            `WHERE a.accion NOT IN (${ACCIONES_FUERA_DE_HISTORIAL_TRABAJADORES.map(() => '?').join(', ')}) ` +
            // Registros antiguos de configuración y sindicatos: se guardaban como CREACIÓN/EDICIÓN sin empleado
            "AND NOT (a.empleado_id IS NULL AND (COALESCE(a.detalles, '') LIKE 'Configuración:%' " +
            "OR COALESCE(a.detalles, '') LIKE 'Creó sindicato%' OR COALESCE(a.detalles, '') LIKE 'Editó sindicato%' " +
            "OR COALESCE(a.detalles, '') LIKE 'Eliminó sindicato%')) " +
            "ORDER BY a.fecha_hora DESC, a.id DESC";

        const [historialCompleto] = await conn.execute(sql, ACCIONES_FUERA_DE_HISTORIAL_TRABAJADORES);
        
        if (historialCompleto.length === 0) {
            return res.status(200).json([]);
        }
        res.status(200).json(historialCompleto);
    } catch (err) {
        console.error(`Error al obtener historial completo:`, err);
        res.status(500).json({ message: 'Error interno del servidor al obtener el historial completo.' });
    }
});

// ==================== (PEGAR ESTA FUNCIÓN CERCA DEL INICIO) ====================
function convertirPeriodoAFecha(periodo) {
    if (!periodo) return null;
    
    // Limpiamos el string
    const partes = periodo.split('-');
    const anio = partes[0];
    // Convertimos a minúsculas y quitamos espacios extra
    const mesTexto = partes.slice(1).join('-').toLowerCase().trim();

    const meses = {
        // Meses Estándar
        'enero': '01', 
        'febrero': '02',
        'marzo': '03',
        'abril': '04',
        'mayo': '05',
        'junio': '06', 
        'julio': '07', 
        'agosto': '08',
        'septiembre': '09',
        'octubre': '10',
        'noviembre': '11',
        'diciembre': '12',
        
        // Meses Especiales (Perú)
        'enero-utiles': '01',   // Se procesa como Enero
        'junio-grati': '06',    // Algunos lo pagan en Junio
        'julio-grati': '07',    // <--- FALTABA ESTE (Lo procesamos como Julio)
        'diciembre-grati': '12' // Se procesa como Diciembre
    };

    const mesNumero = meses[mesTexto];
    
    if (!mesNumero) {
        // ERROR CRÍTICO: Si no reconoce el mes, NO devuelvas Enero.
        // Devolvemos NULL para que la consulta falle o no traiga nada, 
        // en lugar de traer datos falsos de Enero.
        console.error(`ERROR: Mes no reconocido '${mesTexto}' en el periodo '${periodo}'`);
        return null; 
    }

    // Retorna formato DATE de MySQL: YYYY-MM-01
    // Usamos el día 28 para evitar problemas con cambios de hora o bisiestos al comparar,
    // o el 01 para estandarizar inicio de mes. El 01 es más seguro para "<=".
    return `${anio}-${mesNumero}-01`;
}

// ==================== FUNCIÓN AUXILIAR MAESTRA PARA SPP (FINAL) ====================
function formatearPeriodoParaSPP(periodoGlobal) {
    // Entrada: "2025-Enero", "2025-Enero-utiles", "2025-Julio-grati"
    // Salida BD: "2025-01", "2025-07"
    if (!periodoGlobal) return null;

    const partes = periodoGlobal.split('-');
    if (partes.length < 2) return null;

    const anio = partes[0];
    const mesTexto = partes.slice(1).join('-').toLowerCase().trim();

    const meses = {
        'enero': '01', 'enero-utiles': '01',
        'febrero': '02',
        'marzo': '03',
        'abril': '04',
        'mayo': '05',
        'junio': '06', 'junio-grati': '06',
        'julio': '07', 'julio-grati': '07', // <--- CLAVE: Mapea la grati al mes 07
        'agosto': '08',
        'septiembre': '09',
        'octubre': '10',
        'noviembre': '11',
        'diciembre': '12', 'diciembre-grati': '12'
    };

    const mesNum = meses[mesTexto];
    if (!mesNum) return null;

    return `${anio}-${mesNum}`;
}

// ==================== LISTAR COMISIONES (FILTRADO POR PERIODO) ====================
app.get('/comisiones-spp', verifyToken, async (req, res) => {
    const { periodo } = req.query; // El frontend envía "2025-Enero"
    console.log("Solicitud GET /comisiones-spp para:", periodo);

    try {
        const conn = await obtenerConexion();
        
        let sql = 'SELECT * FROM comisiones_spp';
        let params = [];

        if (periodo) {
            // Usamos la función maestra para convertir a "2025-01"
            const periodoBD = formatearPeriodoParaSPP(periodo); 
            if (periodoBD) {
                sql += ' WHERE periodo = ?';
                params.push(periodoBD);
            }
        }

        sql += ' ORDER BY regimen ASC'; 
        const [rows] = await conn.execute(sql, params);
        res.status(200).json(rows);

    } catch (err) {
        console.error('Error en GET /comisiones-spp:', err);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

app.get('/comisiones-spp/ultimo-periodo', verifyToken, async (req, res) => {
    try {
        const conn = await obtenerConexion();
        const [rows] = await conn.execute(
            `SELECT valor FROM configuracion_sistema WHERE clave = 'ultimo_periodo_consultado'`
        );
        if (rows.length > 0 && rows[0].valor) {
            res.status(200).json({ success: true, periodo: rows[0].valor });
        } else {
            const now = new Date();
            const anio = now.getFullYear();
            const mes = String(now.getMonth() + 1).padStart(2, '0');
            const periodoActual = `${anio}-${mes}`;
            res.status(200).json({ success: true, periodo: periodoActual });
        }
    } catch (err) {
        console.error('[GET PERIODO] Error:', err);
        res.status(500).json({ success: false, message: 'Error al obtener el último periodo consultado' });
    }
});

app.get('/comisiones-spp/:id', verifyToken, async (req, res) => {
    const { id } = req.params;
    try {
        const conn = await obtenerConexion();
        const [rows] = await conn.execute('SELECT * FROM comisiones_spp WHERE id = ?', [id]);
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Comisión SPP no encontrada.' });
        }
        res.status(200).json(rows[0]);
    } catch (err) {
        console.error(`Error en GET /comisiones-spp/${id}:`, err);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

app.post('/comisiones-spp', verifyToken, async (req, res) => {
    // CAMBIO: Ahora recibimos también el 'periodo'
    const { regimen, estado, periodo } = req.body;
    
    if (!regimen) {
        return res.status(400).json({ message: 'El campo "regimen" es obligatorio.' });
    }

    // CAMBIO: Formateamos el periodo para guardarlo bien (Ej: '2025-Enero' -> '2025-01')
    // Nota: formatearPeriodoParaSPP es la función que ya tienes en tu backend
    const periodoBD = formatearPeriodoParaSPP(periodo); 

    try {
        const conn = await obtenerConexion();
        
        // CAMBIO: Agregamos la columna 'periodo' al INSERT
        const sql = 'INSERT INTO comisiones_spp (regimen, estado, periodo) VALUES (?, ?, ?)';
        
        const [result] = await conn.execute(sql, [ 
            regimen, 
            estado || 'activo',
            periodoBD // Guardamos la fecha correcta
        ]);

        res.status(201).json({ message: 'Régimen SPP creado con éxito.', id: result.insertId });
    } catch (err) {
        console.error('Error en POST /comisiones-spp:', err);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// ==================== CORRECCIÓN: EDITAR COMISIÓN (LÓGICA BLINDADA) ====================
app.put('/comisiones-spp/:id', verifyToken, async (req, res) => {
    const { id } = req.params;
    // 1. Recibimos todos los datos que vienen del formulario
    const { regimen, estado, comision, comision_mixta, seguroprima, aporte, periodo } = req.body;

    console.log(`[EDITAR] Intentando actualizar ID ${id}. Datos recibidos:`, req.body);

    if (!regimen) {
        return res.status(400).json({ message: 'El campo "regimen" no puede estar vacío.' });
    }

    // 2. Función auxiliar para limpiar números (acepta comas y puntos, y vacíos)
    const limpiarNumero = (val) => {
        if (val === null || val === undefined || String(val).trim() === '') {
            return null;
        }
        // Reemplazamos coma por punto por si el usuario usó coma decimal (ej: 1,55 -> 1.55)
        const str = String(val).replace(',', '.');
        const num = parseFloat(str);
        return isNaN(num) ? null : num;
    };

    try {
        const conn = await obtenerConexion();

        // 3. SQL directo y limpio
        const sql = `UPDATE comisiones_spp SET 
                        regimen = ?, 
                        estado = ?, 
                        comision = ?, 
                        comision_mixta = ?, 
                        seguroprima = ?, 
                        aporte = ?, 
                        periodo = ? 
                     WHERE id = ?`;

        const [result] = await conn.execute(sql, [
            regimen,
            estado || 'activo',
            limpiarNumero(comision),      // Limpiamos el número
            limpiarNumero(comision_mixta),// Limpiamos el número
            limpiarNumero(seguroprima),   // Limpiamos el número
            limpiarNumero(aporte),        // Limpiamos el número
            periodo,
            id
        ]);

        // Verificamos si realmente encontró la fila
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'El registro no existe o no se pudo actualizar.' });
        }

        console.log(`[EDITAR] Éxito. ID ${id} actualizado.`);
        res.status(200).json({ message: 'Comisión actualizada correctamente.' });

    } catch (err) {
        console.error('Error crítico al editar comisión:', err);
        res.status(500).json({ message: 'Error interno del servidor al guardar.' });
    }
});

app.delete('/comisiones-spp/:id', verifyToken, async (req, res) => {
    const { id } = req.params;
    try {
        const conn = await obtenerConexion();
        const [result] = await conn.execute('DELETE FROM comisiones_spp WHERE id = ?', [id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Comisión SPP no encontrada.' });
        }
        res.status(200).json({ message: 'Comisión SPP eliminada con éxito.' });
    } catch (err) {
        console.error(`Error en DELETE /comisiones-spp/${id}:`, err);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// ==================== ACTUALIZAR DESDE SBS (CON LÓGICA ONP 13%) ====================
app.post('/comisiones-spp/actualizar-sbs', verifyToken, async (req, res) => {
    const { periodo } = req.body; 

    if (!periodo) return res.status(400).json({ message: 'Falta el periodo.' });

    console.log(`[BOT] 1. Iniciando actualización para: ${periodo}`);
    
    const urlSBS = 'https://www.sbs.gob.pe/app/spp/empleadores/comisiones_spp/paginas/comision_prima.aspx';
    
    let browser = null; 
    try {
        // --- INICIO PUPPETEER ---
        browser = await puppeteer.launch({ 
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
        });
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        console.log(`[BOT] 2. Navegando a SBS...`);
        await page.goto(urlSBS, { waitUntil: 'networkidle2', timeout: 60000 });

        // ... (Lógica de buscar el iframe y el periodo - IGUAL QUE ANTES) ...
        const frames = page.frames();
        let frameConFormulario = null;
        for (const frame of frames) {
            const html = await frame.content();
            if (html.includes('cboPeriodo')) { frameConFormulario = frame; break; }
        }
        
        if (!frameConFormulario) throw new Error('No se encontró el formulario de SBS (iframe).');

        // Seleccionar periodo
        const periodoEncontrado = await frameConFormulario.evaluate((p) => {
            const select = document.querySelector('#cboPeriodo');
            if(!select) return false;
            const options = Array.from(select.options);
            const opt = options.find(o => o.value.includes(p) || o.text.includes(p));
            if (opt) { select.value = opt.value; return true; }
            return false;
        }, periodo);

        if (!periodoEncontrado) throw new Error(`El periodo ${periodo} no está disponible en la SBS.`);

        await new Promise(r => setTimeout(r, 1000));
        
        const btnBuscar = await frameConFormulario.$('input[type="submit"]');
        if (btnBuscar) {
            await Promise.all([ new Promise(r => setTimeout(r, 4000)), btnBuscar.click() ]);
        } else {
            throw new Error('No se encontró el botón de búsqueda.');
        }

        // Extraer datos AFPs
        const scrapedData = await frameConFormulario.evaluate(() => {
            const rows = document.querySelectorAll('table tr');
            const res = [];
            const regs = ['HABITAT', 'INTEGRA', 'PRIMA', 'PROFUTURO'];
            const clean = (s) => {
                if (!s) return 0;
                let v = s.replace('%','').replace(',','.').trim();
                return parseFloat(v) || 0;
            };
            
            rows.forEach(tr => {
                const cols = tr.querySelectorAll('td');
                if (cols.length > 4) {
                    const name = cols[0].innerText.toUpperCase();
                    const r = regs.find(x => name.includes(x));
                    const txtVal = cols[1].innerText.trim();
                    if (r && /\d/.test(txtVal)) { 
                        res.push({ 
                            regimen_clave: r, 
                            comision: clean(cols[1].innerText), 
                            comision_mixta: clean(cols[2].innerText), 
                            seguroprima: clean(cols[3].innerText), 
                            aporte: clean(cols[4].innerText) 
                        });
                    }
                }
            });
            return res;
        });

        await browser.close();
        
        // --- 2. ACTUALIZACIÓN EN BASE DE DATOS ---
        const conn = await obtenerConexion();
        let actualizados = 0;

        console.log(`[DB] 5. Actualizando AFPs privadas...`);

        // 2.1. Actualizamos las AFPs (Habitat, Integra, etc.)
        for (const afp of scrapedData) {
            const sql = `UPDATE comisiones_spp SET 
                            comision = ?, comision_mixta = ?, seguroprima = ?, aporte = ? 
                         WHERE regimen LIKE CONCAT('%', ?, '%') AND periodo = ?`;

            const [result] = await conn.execute(sql, [
                afp.comision, afp.comision_mixta, afp.seguroprima, afp.aporte,
                afp.regimen_clave, periodo
            ]);

            if (result.affectedRows > 0) actualizados++;
        }

        // ==================================================================
        // 2.2. ¡AQUÍ ESTÁ EL TRUCO! Actualizamos la ONP manualmente (13%)
        // ==================================================================
        console.log(`[DB] 6. Aplicando regla de ONP (13%)...`);
        
        const sqlONP = `UPDATE comisiones_spp SET 
                            aporte = 13.00, 
                            comision = NULL, 
                            comision_mixta = NULL, 
                            seguroprima = NULL 
                        WHERE (regimen LIKE '%ONP%' OR regimen LIKE '%O.N.P.%' OR regimen LIKE '%NACIONAL%') 
                        AND periodo = ?`;

        const [resONP] = await conn.execute(sqlONP, [periodo]);
        
        if (resONP.affectedRows > 0) {
            console.log(`[DB] ✅ ONP actualizada correctamente.`);
            actualizados++; // La contamos como actualizada
        } else {
            console.log(`[DB] ⚠️ No se encontró registro de ONP para actualizar (¿Usaste el botón Generar?).`);
        }
        // ==================================================================

        // Registrar actualización
        await conn.execute("INSERT INTO configuracion_sistema (clave, valor, fecha_actualizacion) VALUES ('ultimo_periodo_consultado', ?, NOW()) ON DUPLICATE KEY UPDATE valor = ?, fecha_actualizacion = NOW()", [periodo, periodo]);

        if (actualizados === 0) {
            res.json({ success: true, message: 'El bot obtuvo datos, pero no encontró registros vacíos (ni AFPs ni ONP). Recuerda usar "GENERAR" primero.', datos: scrapedData });
        } else {
            res.json({ success: true, message: `Proceso completado. Se actualizaron ${actualizados} registros (Incluyendo ONP).`, datos: scrapedData });
        }

    } catch (err) {
        console.error('[BOT ERROR]:', err.message);
        if (browser) await browser.close();
        res.status(500).json({ success: false, message: `Error del Bot: ${err.message}` });
    }
});

// ==================== 1. PERIODOS MOVIDOS (CORREGIDO) ====================
app.get('/api/periodos-movidos', verifyToken, async (req, res) => {
    try {
        const conn = await obtenerConexion();
        const [rows] = await conn.execute("SELECT valor FROM configuracion_sistema WHERE clave = 'periodosMovidos'");
        res.json(rows.length > 0 ? JSON.parse(rows[0].valor) : {});
    } catch (err) {
        console.error(err);
        res.json({});
    }
});

app.post('/api/periodos-movidos', verifyToken, async (req, res) => {
    const { historial } = req.body;
    if (historial === undefined) return res.status(400).json({ message: 'Falta historial' });

    try {
        const conn = await obtenerConexion();
        const valorString = JSON.stringify(historial);
        
        // SQL LIMPIO EN UNA SOLA LÍNEA (Sin espacios raros)
        const sql = "INSERT INTO configuracion_sistema (clave, valor, fecha_actualizacion) VALUES ('periodosMovidos', ?, NOW()) ON DUPLICATE KEY UPDATE valor = ?, fecha_actualizacion = NOW()";
        
        await conn.execute(sql, [valorString, valorString]);
        res.status(200).json({ message: 'Guardado correctamente' });
    } catch (err) {
        console.error('Error al guardar periodos movidos:', err);
        res.status(500).json({ message: 'Error interno' });
    }
});

// ==================== GESTIÓN DEL PERIODO (MODO DIAGNÓSTICO) ====================

// 1. LEER (GET)
app.get('/api/periodo-actual', verifyToken, async (req, res) => {
    console.log("--> [GET] El frontend está preguntando por el periodo...");
    try {
        const conn = await obtenerConexion();
        // Consultamos directamente
        const [rows] = await conn.execute("SELECT valor FROM configuracion_sistema WHERE clave = 'periodo_global_activo'");
        
        console.log("--> [BD DICE]:", rows); // ¡AQUI VEREMOS SI LA BD DEVUELVE ALGO!

        if (rows.length > 0 && rows[0].valor) {
            console.log("--> [SERVER] Enviando al cliente:", rows[0].valor);
            res.json({ periodo: rows[0].valor });
        } else {
            console.log("--> [SERVER] La BD dice que no hay periodo (NULL o vacío).");
            res.json({ periodo: null });
        }
    } catch (e) { 
        console.error("--> [ERROR GET]:", e);
        res.status(500).json({ message: 'Error lectura' }); 
    }
});

// ==================== GESTIÓN DEL PERIODO (VERSIÓN CORREGIDA) ====================
app.post('/api/periodo-actual', verifyToken, async (req, res) => {
    const { periodo } = req.body;
    
    // ✅ LOGS DE DIAGNÓSTICO
    console.log("=== POST /api/periodo-actual ===");
    console.log("Body completo:", JSON.stringify(req.body));
    console.log("Valor 'periodo':", periodo);
    console.log("Tipo:", typeof periodo);

    try {
        const conn = await obtenerConexion();

        // Caso 1: Cerrar período (borrar de BD)
        if (periodo === 'CERRAR') {
            console.log("--> ✅ Orden CERRAR recibida. Borrando...");
            await conn.execute(
                "DELETE FROM configuracion_sistema WHERE clave = 'periodo_global_activo'"
            );
            return res.json({ success: true, message: 'Periodo cerrado' });
        } 
        
        // Caso 2: Guardar período válido
        // ⚠️ CORRECCIÓN: Validación simplificada y clara
        if (periodo && typeof periodo === 'string' && periodo.trim() !== '' && periodo !== 'null') {
            const periodoLimpio = periodo.trim();
            console.log(`--> ✅ Guardando: '${periodoLimpio}'`);
            
            // IMPORTANTE: Usar REPLACE en lugar de INSERT para evitar duplicados
            await conn.execute(
                `REPLACE INTO configuracion_sistema (clave, valor, fecha_actualizacion) 
                 VALUES ('periodo_global_activo', ?, NOW())`,
                [periodoLimpio]
            );
            
            // ✅ VERIFICACIÓN: Leer inmediatamente lo que se guardó
            const [verificar] = await conn.execute(
                "SELECT * FROM configuracion_sistema WHERE clave = 'periodo_global_activo'"
            );
            console.log("--> ✅ Verificación post-guardado:", verificar);
            
            if (verificar.length === 0) {
                throw new Error('ERROR CRÍTICO: No se pudo guardar en la BD');
            }
            
            return res.json({ 
                success: true, 
                message: 'Periodo guardado correctamente', 
                periodo: periodoLimpio 
            });
        } 
        
        // Caso 3: Valor inválido
        console.log("--> ❌ Valor inválido:", periodo);
        return res.status(400).json({ 
            success: false,
            message: 'Periodo inválido', 
            recibido: periodo,
            tipo: typeof periodo 
        });
        
    } catch (e) { 
        console.error("--> ❌ ERROR EN BD:", e);
        return res.status(500).json({ 
            success: false,
            message: 'Error de base de datos', 
            error: e.message 
        }); 
    }
});

// ====================================================================
// === MÓDULO: GESTIÓN DE PERIODO (TABLA INDEPENDIENTE 'sistema_periodo') ===
// ====================================================================

// =======================================================
// === GESTIÓN DE PERIODO (UNIFICADO CON CONFIGURACION_SISTEMA) ===
// =======================================================

// 1. LEER EL PERIODO GLOBAL
app.get('/api/periodo-global', verifyToken, async (req, res) => {
    try {
        const conn = await obtenerConexion();
        const [rows] = await conn.execute(
            "SELECT valor FROM configuracion_sistema WHERE clave = 'periodo_global_activo'"
        );
        
        if (rows.length > 0 && rows[0].valor) {
            res.json({ periodo: rows[0].valor });
        } else {
            res.json({ periodo: null });
        }
    } catch (err) {
        console.error("Error leyendo periodo global:", err);
        res.status(500).json({ message: 'Error de servidor' });
    }
});

// 2. CAMBIAR EL PERIODO GLOBAL
app.post('/api/periodo-global', verifyToken, async (req, res) => {
    const { periodo } = req.body;

    if (periodo === 'CERRAR') {
        return res.json({ success: true, message: 'Bye' });
    }

    if (!periodo) return res.status(400).json({ message: 'Falta periodo' });

    try {
        const conn = await obtenerConexion();
        
        // Guardamos usando la tabla estándar configuracion_sistema
        await conn.execute(
            `INSERT INTO configuracion_sistema (clave, valor, fecha_actualizacion) 
             VALUES ('periodo_global_activo', ?, NOW()) 
             ON DUPLICATE KEY UPDATE valor = ?, fecha_actualizacion = NOW()`,
            [periodo, periodo]
        );

        // Auditoría limpia y segura
        const usuario = req.authData?.user?.username || 'sistema';
        await registrarAuditoria(usuario, 'CAMBIO_PERIODO', 0, req.ip, `Cambió periodo global a: ${periodo}`);

        res.json({ success: true, message: `Periodo actualizado a ${periodo}` });

    } catch (err) {
        console.error("Error guardando periodo:", err);
        res.status(500).json({ message: 'Error al guardar' });
    }
});

// ==================== PERSISTENCIA DEL AÑO UI (EN BASE DE DATOS) ====================

// 1. LEER el año guardado
app.get('/api/configuracion/anio-ui', verifyToken, async (req, res) => {
    try {
        const conn = await obtenerConexion();
        const [rows] = await conn.execute(
            "SELECT valor FROM configuracion_sistema WHERE clave = 'anio_ui_seleccionado'"
        );
        // Si existe, lo devolvemos. Si no, devolvemos null
        res.json({ anio: rows.length > 0 ? rows[0].valor : null });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error al obtener año UI' });
    }
});

// 2. GUARDAR el año seleccionado
app.post('/api/configuracion/anio-ui', verifyToken, async (req, res) => {
    const { anio } = req.body;
    if (!anio) return res.status(400).json({ message: 'Falta el año' });

    try {
        const conn = await obtenerConexion();
        // Usamos REPLACE o INSERT ON DUPLICATE para guardar/actualizar
        await conn.execute(
            "INSERT INTO configuracion_sistema (clave, valor, fecha_actualizacion) VALUES ('anio_ui_seleccionado', ?, NOW()) ON DUPLICATE KEY UPDATE valor = ?, fecha_actualizacion = NOW()",
            [anio.toString(), anio.toString()]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error al guardar año UI' });
    }
});

// =======================================================
// ========= RUTAS DE ASISTENCIAS (ACTUALIZADO CON ESTADO) =========
// =======================================================

// 1. OBTENER ASISTENCIAS
app.get('/asistencias', verifyToken, async (req, res) => {
    const { periodo, tipo } = req.query; 
    if (!periodo) return res.status(400).json({ message: 'Falta el periodo.' });

    try {
        const conn = await obtenerConexion();
        let sql = `
            SELECT 
                e.id AS empleado_id,
                p.dni,
                p.nombre,
                p.apellido_paterno,
                p.apellido_materno,
                e.tipo_contrato,
                COALESCE(a.dias_trabajados, 30) as dias_trabajados,
                COALESCE(a.dias_falta, 0) as dias_falta,
                COALESCE(a.dias_vacaciones, 0) as dias_vacaciones,
                COALESCE(a.dias_licencia, 0) as dias_licencia,
                COALESCE(a.minutos_tardanza, 0) as minutos_tardanza,
                COALESCE(a.estado, 'ACTIVO') as estado,
                COALESCE(a.estado_detalle, '') as estado_detalle,
                COALESCE(a.nota, '') as nota,  -- NUEVO CAMPO NOTA
                IF(a.id IS NOT NULL, true, false) as tiene_registro
            FROM empleados e
            INNER JOIN personas p ON e.persona_id = p.id
            LEFT JOIN asistencias a ON e.id = a.empleado_id AND a.periodo = ?
            WHERE p.estado = 'activo'
        `;

        const params = [periodo];
        if (tipo) { sql += " AND e.tipo_contrato = ?"; params.push(tipo); }
        sql += " ORDER BY p.apellido_paterno ASC";

        const [rows] = await conn.execute(sql, params);
        res.json(rows);
    } catch (err) { res.status(500).json({ message: 'Error al obtener lista.' }); }
});

// 2. GUARDAR ASISTENCIA
app.post('/asistencias', verifyToken, async (req, res) => {
    const { periodo, datos } = req.body;
    if (!periodo || !datos || !Array.isArray(datos)) return res.status(400).json({ message: 'Datos inválidos.' });

    // Las transacciones (beginTransaction/commit/rollback) necesitan una conexión
    // dedicada del pool, no el pool en sí (el pool no tiene esos métodos).
    const pool = await obtenerConexion();
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        const sql = `
            INSERT INTO asistencias (empleado_id, periodo, dias_trabajados, dias_falta, dias_vacaciones, dias_licencia, minutos_tardanza, estado, estado_detalle, nota)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
            dias_trabajados = VALUES(dias_trabajados),
            dias_falta = VALUES(dias_falta),
            dias_vacaciones = VALUES(dias_vacaciones),
            dias_licencia = VALUES(dias_licencia),
            minutos_tardanza = VALUES(minutos_tardanza),
            estado = VALUES(estado),
            estado_detalle = VALUES(estado_detalle),
            nota = VALUES(nota) -- NUEVO
        `;

        for (const item of datos) {
            await conn.execute(sql, [
                item.empleado_id, periodo,
                item.dias_trabajados || 0, item.dias_falta || 0, item.dias_vacaciones || 0, item.dias_licencia || 0, item.minutos_tardanza || 0,
                item.estado || 'ACTIVO', item.estado_detalle || '',
                item.nota || '' // NUEVO
            ]);
        }

        await conn.commit();
        res.json({ message: 'Guardado correctamente.' });
    } catch (err) {
        if (conn) await conn.rollback();
        console.error(err);
        res.status(500).json({ message: 'Error al guardar.' });
    } finally {
        if (conn) conn.release();
    }
});

// --- METAS (Para el combo) ---
app.get('/metas', verifyToken, async (req, res) => {
    try {
        const conn = await obtenerConexion();
        const [rows] = await conn.execute("SELECT * FROM metas WHERE estado = 'activo'");
        res.json(rows);
    } catch (err) { res.status(500).json([]); }
});

// ==================== MANTENIMIENTO DE METAS (ACTUALIZADO) ====================

// Listar
app.get('/metas', verifyToken, async (req, res) => {
    try {
        const conn = await obtenerConexion();
        // Ordenamos por año y luego por el código de la meta
        const [rows] = await conn.execute('SELECT * FROM metas ORDER BY anio DESC, meta ASC');
        res.json(rows);
    } catch (err) { res.status(500).json({ message: 'Error al obtener metas' }); }
});

// Crear (Ahora recibe 'meta' que es el código)
app.post('/metas', verifyToken, async (req, res) => {
    const { meta, descripcion, anio, estado } = req.body;
    if (!meta || !descripcion || !anio) return res.status(400).json({ message: 'Código, Descripción y Año son obligatorios' });
    
    try {
        const conn = await obtenerConexion();
        await conn.execute(
            'INSERT INTO metas (meta, descripcion, anio, estado) VALUES (?, ?, ?, ?)',
            [meta, descripcion.toUpperCase(), anio, estado || 'activo']
        );
        res.status(201).json({ message: 'Meta creada correctamente' });
    } catch (err) { res.status(500).json({ message: 'Error al crear meta' }); }
});

// Editar
app.put('/metas/:id', verifyToken, async (req, res) => {
    const { id } = req.params;
    const { meta, descripcion, anio, estado } = req.body;
    
    try {
        const conn = await obtenerConexion();
        await conn.execute(
            'UPDATE metas SET meta = ?, descripcion = ?, anio = ?, estado = ? WHERE id = ?',
            [meta, descripcion.toUpperCase(), anio, estado, id]
        );
        res.json({ message: 'Meta actualizada correctamente' });
    } catch (err) { res.status(500).json({ message: 'Error al actualizar meta' }); }
});

// Eliminar (Igual que antes)
app.delete('/metas/:id', verifyToken, async (req, res) => {
    const { id } = req.params;
    try {
        const conn = await obtenerConexion();
        await conn.execute('DELETE FROM metas WHERE id = ?', [id]);
        res.json({ message: 'Meta eliminada correctamente' });
    } catch (err) {
        if (err.code === 'ER_ROW_IS_REFERENCED_2') return res.status(409).json({ message: 'Meta en uso por empleados.' });
        res.status(500).json({ message: 'Error al eliminar meta' });
    }
});

// ==========================================
// === ENTIDADES FINANCIERAS (MANTENIMIENTO) ===
// ==========================================

// 1. LISTAR ENTIDADES
app.get('/entidades-financieras', verifyToken, async (req, res) => {
    try {
        const conn = await obtenerConexion();
        const [rows] = await conn.execute("SELECT * FROM entidades_financieras WHERE estado = 'activo' ORDER BY nombre ASC");
        res.json(rows);
    } catch (err) { res.status(500).json({ message: 'Error al listar entidades' }); }
});

// 2. CREAR ENTIDAD
app.post('/entidades-financieras', verifyToken, async (req, res) => {
    const { nombre } = req.body;
    try {
        const conn = await obtenerConexion();
        await conn.execute("INSERT INTO entidades_financieras (nombre) VALUES (?)", [nombre.toUpperCase()]);
        res.status(201).json({ message: 'Entidad registrada' });
    } catch (err) { res.status(500).json({ message: 'Error al guardar' }); }
});

// 3. ELIMINAR ENTIDAD
app.delete('/entidades-financieras/:id', verifyToken, async (req, res) => {
    try {
        const conn = await obtenerConexion();
        await conn.execute("UPDATE entidades_financieras SET estado = 'inactivo' WHERE id = ?", [req.params.id]);
        res.json({ message: 'Entidad eliminada' });
    } catch (err) { res.status(500).json({ message: 'Error al eliminar' }); }
});

// ==================== COLUMNAS DINÁMICAS DE LA PLANILLA ====================
// Un concepto existe en un periodo si no tiene vigencia (catálogo original) o si empezó a regir
// en ese mes o antes. Evita que un concepto nuevo aparezca en planillas de meses anteriores.
// Recibe el alias de la tabla conceptos; el parámetro es el inicio del periodo ('YYYY-MM-01').
const SQL_CONCEPTO_VIGENTE = (alias) => `(${alias}.vigente_desde IS NULL OR ${alias}.vigente_desde <= ?)`;
// Columnas generadas desde los conceptos ACTIVOS: ingresos, descuentos fijos y aportes fijos.
// El orden define también el orden de suma de los ingresos.
// ?periodo=2026-Septiembre: solo los conceptos vigentes en ese periodo (ver SQL_CONCEPTO_VIGENTE).
// Error con código HTTP: las funciones de planilla lo lanzan y la ruta responde con ese código
const errorHttp = (status, message) => Object.assign(new Error(message), { status });

// Columnas de conceptos vigentes en el periodo (sin periodo: todas las activas)
async function construirColumnasPlanilla(conn, periodo) {
    const inicioPeriodo = periodo ? convertirPeriodoAFecha(periodo) : null;
    if (periodo && !inicioPeriodo) throw errorHttp(400, 'Periodo inválido');
    const [rows] = await conn.execute(`
        SELECT columna_planilla AS columna,
               CASE WHEN rol_calculo IN ('INGRESO','INGRESO_AFP') THEN 'INGRESO'
                    WHEN rol_calculo = 'DESCUENTO_FIJO' THEN 'DESCUENTO'
                    ELSE 'APORTE' END AS grupo,
               MIN(orden) AS orden
        FROM conceptos
        WHERE estado = 'activo' AND rol_calculo IN ('INGRESO','INGRESO_AFP','DESCUENTO_FIJO','APORTE_FIJO')
          ${inicioPeriodo ? `AND ${SQL_CONCEPTO_VIGENTE('conceptos')}` : ''}
        GROUP BY columna_planilla, grupo
        ORDER BY orden, columna_planilla`, inicioPeriodo ? [inicioPeriodo] : []);
    return rows;
}

app.get('/planilla/columnas', verifyToken, async (req, res) => {
    try {
        const conn = await obtenerConexion();
        const copia = await copiaPlanillaSolicitada(conn, req, 'normal');
        if (copia) return res.json(copia.columnas);
        res.json(await construirColumnasPlanilla(conn, req.query.periodo));
    } catch (err) {
        if (err.status) return res.status(err.status).json({ message: err.message });
        console.error('Error GET /planilla/columnas:', err);
        res.status(500).json({ message: 'Error al obtener las columnas de la planilla' });
    }
});

// ==================== PLANILLA (MAQUETA: LÓGICA DE TASAS + FILTRO DE FECHAS) ====================
// Datos de la planilla del periodo en vivo (desde las tablas actuales).
// tipo_planilla: 'normal' | 'reincorporada'. La usan la pantalla de planilla y la copia del cierre.
async function construirDatosPlanilla(conn, periodo, tipo_planilla) {
    // Mes del periodo ('YYYY-MM-01'): lo usan el filtro de reincorporados y el filtro de días (calcularDiasMes)
    const fechaInicioStr = periodo ? convertirPeriodoAFecha(periodo) : null;

    // 1. Filtro Normal vs Reincorporada: las dos planillas son DISJUNTAS (nadie sale en ambas,
    //    así los totales de cada pantalla no se duplican). Es REINCORPORADO del periodo quien:
    //    - tiene la marca "Reincorporado" del mantenimiento de empleados (sin_regimen = 1), o
    //    - tiene un tramo que empieza dentro del mes y NO es su primer tramo (baja + reingreso:
    //      cubre el caso de varios tramos en el mes, ej. baja 24/09 y reincorporación 25/09).
    //    COALESCE: con sin_regimen NULL el NOT(...) daría NULL y lo sacaría de ambas planillas.
    const condicionReincorporado = `(
            COALESCE(e.sin_regimen, 0) = 1
            OR EXISTS (
                SELECT 1 FROM empleado_tramos tr
                WHERE tr.empleado_id = e.id
                  AND tr.fecha_ingreso BETWEEN ? AND LAST_DAY(?)
                  AND EXISTS (SELECT 1 FROM empleado_tramos tp
                              WHERE tp.empleado_id = e.id AND tp.id <> tr.id
                                AND (tp.fecha_ingreso IS NULL OR tp.fecha_ingreso < tr.fecha_ingreso))
            )
        )`;
    const filtroRegimen = tipo_planilla === 'reincorporada'
        ? `AND ${condicionReincorporado}`
        : `AND NOT ${condicionReincorporado}`;

    // 2. Consulta Maestra (SIN FILTRO DE ESTADO 'ACTIVO')
    // Quitamos "WHERE p.estado = 'activo'" para que el filtro de fechas decida quién sale.
    const sql = `
        SELECT 
            e.id, 
            CONCAT(COALESCE(p.apellido_paterno,''), ' ', COALESCE(p.apellido_materno,''), ', ', COALESCE(p.nombre,'')) as nombre,
            c.descripcion as cargo,
            ar.descripcion as area_nombre, 
            go.nivel_remunerativo as nivel,
            p.dni,
            p.fecha_nacimiento,
            CAST(e.fecha_ingreso AS CHAR) as fecha_raw, -- Cast para evitar errores de fecha
            CAST(e.fecha_baja AS CHAR) as fecha_baja,   -- Cast para evitar errores de fecha
            e.tipo_comision,
            e.subtipo, 
            COALESCE(e.tipo_contrato, 'EMPLEADO') as tipo_contrato,
            sp.descripcion as regimen_nombre,
            '' as regimen_tipo, 
            e.cuspp, 
            m.meta as meta_codigo,
            COALESCE(a.dias_trabajados, 30) as dias_asistencia,
            COALESCE(a.dias_falta, 0) as dias_falta,
            COALESCE(a.minutos_tardanza, 0) as tardanzas, 
            COALESCE(a.estado, 'ACTIVO') as estado_asistencia, 
            (SELECT COALESCE(SUM(porcentual), 0) FROM judiciales j WHERE j.empleado_id = e.id AND j.estado = 'activo') as judicial_porcentaje_total,
            e.grupo_ocupacional_id,
            e.sistema_pension_id, 
            
COALESCE((
                SELECT CONCAT('[', GROUP_CONCAT(JSON_OBJECT('nombre', COALESCE(co.nombre, ''), 'monto', COALESCE(ec.monto, 0), 'tipo', COALESCE(co.tipo_concepto, 'Fijo'))), ']') 
                FROM empleado_conceptos ec JOIN conceptos co ON ec.concepto_id = co.id
                WHERE ec.empleado_id = e.id AND ${SQL_CONCEPTO_VIGENTE('co')}
            ), '[]') as conceptos_json

        FROM empleados e
        INNER JOIN personas p ON e.persona_id = p.id
        LEFT JOIN cargos c ON e.cargo_id = c.id
        LEFT JOIN areas ar ON e.area_id = ar.id
        LEFT JOIN grupos_ocupacionales go ON e.grupo_ocupacional_id = go.id
        LEFT JOIN sistemas_pensiones sp ON e.sistema_pension_id = sp.id
        LEFT JOIN metas m ON e.meta_id = m.id 
        LEFT JOIN asistencias a ON e.id = a.empleado_id AND a.periodo = ?
        WHERE 1=1 
        ${filtroRegimen} 
    `;
    
    // Sin mes reconocible no se puede saber qué conceptos existían: mejor fallar que mezclar periodos
    if (!fechaInicioStr) throw errorHttp(400, `Periodo no reconocido: ${periodo}`);

    // Parámetros: vigencia de conceptos + asistencias (periodo) + rango del mes del filtro de reincorporados
    const [empleados] = await conn.execute(sql, [fechaInicioStr, periodo, fechaInicioStr, fechaInicioStr]);

    // 3. FECHAS: fechaInicioStr (arriba) filtra quién trabaja en este mes (ver calcularDiasMes)

    // 4. PREPARACIÓN DE TASAS SPP
    const periodoBD = formatearPeriodoParaSPP(periodo);
    const [todasTasas] = await conn.execute("SELECT * FROM comisiones_spp WHERE periodo = ?", [periodoBD]);
    // Conceptos asignados con su ROL de cálculo y su COLUMNA (tabla conceptos). Solo conceptos activos
    // (desactivar un concepto en el mantenedor deja de procesarlo en la planilla) y vigentes en el
    // periodo (un concepto creado después no existe en planillas de meses anteriores).
    const sqlConceptos = `SELECT ec.empleado_id, co.nombre, ec.monto, co.rol_calculo, co.columna_planilla
                          FROM empleado_conceptos ec JOIN conceptos co ON ec.concepto_id = co.id
                          WHERE co.estado = 'activo' AND ${SQL_CONCEPTO_VIGENTE('co')}`;
    const [todosConceptos] = await conn.execute(sqlConceptos, [fechaInicioStr]);

    // Tramos laborados (actual + anteriores): la planilla lee EXCLUSIVAMENTE de empleado_tramos.
    const [filasTramos] = await conn.execute(
        'SELECT empleado_id, CAST(fecha_ingreso AS CHAR) AS ingreso, CAST(fecha_baja AS CHAR) AS baja FROM empleado_tramos');
    const tramosPorEmpleado = new Map();
    for (const t of filasTramos) {
        if (!tramosPorEmpleado.has(t.empleado_id)) tramosPorEmpleado.set(t.empleado_id, []);
        tramosPorEmpleado.get(t.empleado_id).push({ ingreso: t.ingreso, baja: t.baja });
    }

    // --- 5. FILTRADO Y MAPEO ---
    const planillaLista = [];

    empleados.forEach(emp => {
        // === FILTRO DE TIEMPO ===
        // Días del mes que realmente le corresponden, sumando TODOS sus tramos (actual + anteriores).
        // Entra a la planilla si cualquier tramo toca el mes: así, quien cesó en este mes y se
        // reincorporó en uno posterior no desaparece al recalcular este mes.
        const tramos = tramosPorEmpleado.get(emp.id) || [];
        if (!tramos.length) {
            // No debería pasar: toda alta/reincorporación abre un tramo en la misma transacción.
            console.warn(`[PLANILLA] Empleado ${emp.id} (${emp.nombre}) no tiene tramos en empleado_tramos: queda fuera de la planilla.`);
            return;
        }
        const diasMes = calcularDiasMes(tramos, fechaInicioStr);
        const pasaFiltro = !fechaInicioStr || diasMes.intervalos.length > 0;

        if (pasaFiltro) {
            // === CONCEPTOS POR ROL (conceptos.rol_calculo) ===
            const misConceptos = todosConceptos.filter(c => c.empleado_id === emp.id);
            const deRol = (rol) => misConceptos.filter(c => c.rol_calculo === rol);
            // Tasas: el primer valor distinto de 0 (como la búsqueda anterior)
            const tasaDeRol = (rol) => { const f = deRol(rol).find(c => parseFloat(c.monto)); return f ? parseFloat(f.monto) : 0; };
            const sumaDeRol = (rol) => deRol(rol).reduce((s, c) => s + (parseFloat(c.monto) || 0), 0);
            // Montos agrupados por columna de la planilla: { 'DS 320-2022': 220.32, ... }
            const agruparPorColumna = (filas) => filas.reduce((acc, c) => {
                acc[c.columna_planilla] = (acc[c.columna_planilla] || 0) + (parseFloat(c.monto) || 0);
                return acc;
            }, {});

            // Regla heredada del motor anterior: el ingreso 'AFP (CON)' solo se paga si el trabajador
            // NO tiene tasa de aporte AFP asignada. Para pagarlo siempre, cambiar su rol a INGRESO.
            const tieneAporteAfp = tasaDeRol('AFP_APORTE') !== 0;
            const ingresos = agruparPorColumna(misConceptos.filter(c =>
                c.rol_calculo === 'INGRESO' || (c.rol_calculo === 'INGRESO_AFP' && !tieneAporteAfp)));
            const descuentosFijos = agruparPorColumna(deRol('DESCUENTO_FIJO'));
            const aportesFijos = agruparPorColumna(deRol('APORTE_FIJO'));

            // Lógica de Tasas al Vuelo
            let val_aporte = tasaDeRol('AFP_APORTE');
            let val_seguro = tasaDeRol('AFP_SEGURO');
            let val_comision = tasaDeRol('AFP_COMISION');
            let val_onp = tasaDeRol('ONP');

            if (emp.regimen_nombre && todasTasas.length > 0) {
                const nombreAFP = emp.regimen_nombre.toUpperCase();
                const tasaMes = todasTasas.find(t => nombreAFP.includes(t.regimen.toUpperCase()) || t.regimen.toUpperCase().includes(nombreAFP));
                if (tasaMes) {
                    if (nombreAFP.includes('ONP') || nombreAFP.includes('NACIONAL')) {
                        val_onp = tasaMes.aporte; 
                    } else {
                        val_aporte = tasaMes.aporte;      
                        val_seguro = tasaMes.seguroprima; 
                        if (emp.tipo_comision === 'Flujo') val_comision = tasaMes.comision;
                        else if (emp.tipo_comision === 'Mixta') val_comision = tasaMes.comision_mixta;
                        else val_comision = 0;
                    }
                }
            }

            let metaLimpia = ""; if (emp.meta_codigo) metaLimpia = parseInt(emp.meta_codigo, 10).toString();

            planillaLista.push({
                id: emp.id, nombre: emp.nombre, dni: emp.dni, cargo: emp.cargo || '', area: emp.area_nombre || '',
                nivel: emp.nivel || '', fecha_nacimiento: emp.fecha_nacimiento, fecha_raw: diasMes.fecha_ingreso_actual,
                tipo_contrato: emp.tipo_contrato, subtipo: emp.subtipo || '', regimen_nombre: emp.regimen_nombre || '',
                cuspp: emp.cuspp, tipo_comision: emp.tipo_comision, faltas: emp.dias_falta, tardanzas: emp.tardanzas,
                estado_asistencia: emp.estado_asistencia, meta: metaLimpia, judicial_porcentaje: parseFloat(emp.judicial_porcentaje_total || 0),
                fecha_baja: diasMes.fecha_baja_actual,   // fechas del tramo actual (empleado_tramos)
                dias_computables: diasMes.dias,
                cese_en_mes: diasMes.cese_en_mes,
                ingreso_en_mes: diasMes.ingreso_en_mes,
                // Su ingreso de este mes es un reingreso (no una contratación nueva)
                reincorporado_en_mes: diasMes.reincorporado_en_mes,
                // Bajas de tramos anteriores dentro de este mes (ej. baja 24/09 antes del reingreso 25/09)
                bajas_previas_en_mes: diasMes.bajas_previas_en_mes,
                // El frontend prorratea todos los conceptos con dias_computables / 30.
                
                onp_valor: val_onp,
                afp_apo_valor: val_aporte,
                afp_pri_valor: val_seguro,
                afp_com_valor: val_comision,

                // Montos mensuales (mes completo) por columna; el frontend los prorratea y arma las columnas
                // con GET /planilla/columnas. Un concepto nuevo aparece aquí sin tocar código.
                ingresos,
                descuentos_fijos: descuentosFijos,
                aportes_fijos: aportesFijos,

                prestamos: sumaDeRol('PRESTAMO'), sindicato: sumaDeRol('SINDICATO'), renta_5ta: sumaDeRol('RENTA_5TA')
            });
        }
    });

    return planillaLista;
}

app.get('/planilla/datos-maqueta', verifyToken, async (req, res) => {
    const { periodo, tipo_planilla } = req.query;
    if (!periodo) return res.status(400).json({ message: 'Falta periodo' });

    try {
        const conn = await obtenerConexion();
        const tipo = tipo_planilla === 'reincorporada' ? 'reincorporada' : 'normal';
        const copia = await copiaPlanillaSolicitada(conn, req, tipo);
        if (copia) return res.json(copia.datos);
        res.json(await construirDatosPlanilla(conn, periodo, tipo));
    } catch (err) {
        if (err.status) return res.status(err.status).json({ message: err.message });
        console.error("Error SQL Planilla:", err);
        res.status(500).json({ message: 'Error SQL: ' + err.message });
    }
});

// ==================== COPIA ESTÁTICA DE LA PLANILLA (SNAPSHOT AL CERRAR) ====================
// Al cerrar un periodo se guarda en planilla_snapshots lo que la pantalla necesita para dibujarlo:
// columnas, datos de cada trabajador (normal y reincorporada) y parámetros (UIT, RMV...).
// Desde entonces ese periodo se muestra desde la copia, aunque el sistema se reactive y cambien
// conceptos, montos o trabajadores. Cerrar otra vez guarda una versión nueva (se muestra la última).
// ?en_vivo=1 permite ver los datos actuales sin tocar la copia.
const TIPOS_PLANILLA = ['normal', 'reincorporada'];

async function leerCopiaPlanilla(conn, periodo, tipo) {
    const [rows] = await conn.execute(
        `SELECT version, columnas_json, datos_json, config_json, creado_por,
                DATE_FORMAT(fecha_creacion, '%Y-%m-%d %H:%i') AS fecha
         FROM planilla_snapshots WHERE periodo = ? AND tipo_planilla = ?
         ORDER BY version DESC LIMIT 1`, [periodo, tipo]);
    if (!rows.length) return null;
    const r = rows[0];
    return { version: r.version, fecha: r.fecha, creado_por: r.creado_por,
             columnas: JSON.parse(r.columnas_json), datos: JSON.parse(r.datos_json), config: JSON.parse(r.config_json) };
}

// La copia del periodo pedido, salvo que se pida ver en vivo
async function copiaPlanillaSolicitada(conn, req, tipo) {
    const { periodo, en_vivo } = req.query;
    if (!periodo || en_vivo === '1') return null;
    return leerCopiaPlanilla(conn, periodo, tipo);
}

// Parámetros del periodo (misma herencia que GET /configuracion, pero sin insertar nada)
async function parametrosDelPeriodo(conn, periodo) {
    const [rows] = await conn.execute(
        "SELECT clave, valor, descripcion FROM parametros_sistema WHERE periodo = ? AND estado = 'activo'", [periodo]);
    if (rows.length) return rows;
    const [herencia] = await conn.execute(`
        SELECT p1.clave, p1.valor, p1.descripcion FROM parametros_sistema p1
        INNER JOIN (SELECT clave, MAX(id) AS max_id FROM parametros_sistema WHERE estado = 'activo' GROUP BY clave) p2
            ON p1.id = p2.max_id`);
    return herencia;
}

// Guarda la copia de ambas planillas del periodo. Debe llamarse DENTRO de una transacción.
// Devuelve { version, trabajadores }.
async function guardarCopiaPlanilla(conn, periodo, usuario) {
    const [[{ ultima }]] = await conn.execute(
        'SELECT COALESCE(MAX(version), 0) AS ultima FROM planilla_snapshots WHERE periodo = ? FOR UPDATE', [periodo]);
    const version = ultima + 1;
    const columnas = await construirColumnasPlanilla(conn, periodo);
    const config = await parametrosDelPeriodo(conn, periodo);
    let trabajadores = 0;
    for (const tipo of TIPOS_PLANILLA) {
        const datos = await construirDatosPlanilla(conn, periodo, tipo);
        trabajadores += datos.length;
        await conn.execute(
            `INSERT INTO planilla_snapshots (periodo, tipo_planilla, version, columnas_json, datos_json, config_json, trabajadores, creado_por)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [periodo, tipo, version, JSON.stringify(columnas), JSON.stringify(datos), JSON.stringify(config), datos.length, usuario]);
    }
    return { version, trabajadores };
}
// =======================================================
// === MANTENIMIENTO DE CONCEPTOS (CORREGIDO Y COMPLETO) ===
// =======================================================

// 1. LISTAR TODOS
// =======================================================
// === CATÁLOGO DE CONCEPTOS (mantenedor) ===
// =======================================================
// rol_calculo: qué hace el motor de planilla con el concepto (ver migraciones/003_conceptos_dinamicos.js)
const ROLES_CONCEPTO = {
    INGRESO: 'Ingreso', INGRESO_AFP: 'Ingreso',
    DESCUENTO_FIJO: 'Descuento', AFP_APORTE: 'Descuento', AFP_SEGURO: 'Descuento', AFP_COMISION: 'Descuento',
    ONP: 'Descuento', RENTA_5TA: 'Descuento', JUDICIAL: 'Descuento', PRESTAMO: 'Descuento', SINDICATO: 'Descuento',
    TARDANZAS_FALTAS: 'Descuento',
    APORTE_FIJO: 'Aporte', ESSALUD: 'Aporte'
};
const ROL_POR_DEFECTO = { Ingreso: 'INGRESO', Descuento: 'DESCUENTO_FIJO', Aporte: 'APORTE_FIJO' };
const GRUPO_COLUMNA = (rol) => ['INGRESO', 'INGRESO_AFP'].includes(rol) ? 'INGRESO' : rol === 'DESCUENTO_FIJO' ? 'DESCUENTO' : rol === 'APORTE_FIJO' ? 'APORTE' : 'ESPECIAL';

// Valida y completa los datos de un concepto. Devuelve { datos } o { error }.
// anterior: el concepto tal como está en la BD (solo al editar).
async function validarConcepto(conn, body, idActual = null, anterior = null) {
    const nombre = String(body.nombre || '').trim().toUpperCase();
    const aplicacion = body.aplicacion;
    const tipo_concepto = body.tipo_concepto;
    const operacion = body.operacion;
    if (!nombre) return { error: 'El nombre es obligatorio.' };
    if (!['Empleado', 'Obrero', 'CAS'].includes(aplicacion)) return { error: 'Régimen (aplicación) inválido.' };
    if (!['Fijo', 'Variable', 'Porcentual'].includes(tipo_concepto)) return { error: 'Tipo de concepto inválido.' };
    if (!['Ingreso', 'Descuento', 'Aporte'].includes(operacion)) return { error: 'Operación inválida (Ingreso, Descuento o Aporte).' };

    const rol_calculo = body.rol_calculo || ROL_POR_DEFECTO[operacion];
    if (!ROLES_CONCEPTO[rol_calculo]) return { error: 'Rol de cálculo inválido.' };
    if (ROLES_CONCEPTO[rol_calculo] !== operacion)
        return { error: `El rol ${rol_calculo} corresponde a la operación ${ROLES_CONCEPTO[rol_calculo]}, no a ${operacion}.` };

    let columna_planilla = String(body.columna_planilla || nombre).trim().toUpperCase().slice(0, 60);
    // Al crear, la columna toma el nombre. Si al editar solo se cambia el nombre, la columna lo sigue
    // (si no, la planilla seguía mostrando el nombre viejo y parecía que la edición no se guardó).
    // Una columna personalizada (distinta del nombre, ej. 'DS 320-2022') no se toca.
    if (anterior && anterior.columna_planilla === anterior.nombre && columna_planilla === anterior.columna_planilla && nombre !== anterior.nombre)
        columna_planilla = nombre.slice(0, 60);
    const grupo = GRUPO_COLUMNA(rol_calculo);
    // Una columna no puede ser de ingreso en un régimen y de descuento en otro
    const [choque] = await conn.execute(
        `SELECT id, nombre, rol_calculo FROM conceptos WHERE columna_planilla = ? AND estado = 'activo' AND id <> ?`,
        [columna_planilla, idActual || 0]);
    const distinto = choque.find(c => GRUPO_COLUMNA(c.rol_calculo) !== grupo);
    if (distinto) return { error: `La columna "${columna_planilla}" ya la usa el concepto #${distinto.id} ${distinto.nombre} con otro tipo de operación.` };

    let orden = parseInt(body.orden, 10);
    if (!Number.isFinite(orden)) {
        // Nuevo concepto sin orden: después de las columnas existentes de su grupo (ej. un DS nuevo queda al final)
        const [[{ maximo }]] = await conn.execute(
            `SELECT COALESCE(MAX(orden), 0) AS maximo FROM conceptos WHERE rol_calculo IN (${grupo === 'INGRESO' ? "'INGRESO','INGRESO_AFP'" : '?'})`,
            grupo === 'INGRESO' ? [] : [rol_calculo]);
        orden = maximo + 10;
    }
    const monto_defecto = parseFloat(body.monto_defecto) || 0;
    const estado = body.estado === 'inactivo' ? 'inactivo' : 'activo';

    // Vigente desde (mes 'YYYY-MM' o fecha 'YYYY-MM-DD'): se guarda como primer día del mes.
    // Vacío = siempre vigente. Al editar sin enviarlo se conserva el valor actual.
    let vigente_desde = body.vigente_desde === undefined ? (anterior ? anterior.vigente_desde : null) : body.vigente_desde;
    if (vigente_desde) {
        const m = /^(\d{4})-(\d{2})/.exec(String(vigente_desde));
        if (!m || +m[2] < 1 || +m[2] > 12) return { error: 'Vigente desde inválido (use AAAA-MM).' };
        vigente_desde = `${m[1]}-${m[2]}-01`;
    } else {
        vigente_desde = null;
    }
    return { datos: { nombre, aplicacion, tipo_concepto, operacion, rol_calculo, columna_planilla, orden, vigente_desde, monto_defecto, estado } };
}

async function leerConceptoCatalogo(conn, id) {
    const [[c]] = await conn.execute(
        `SELECT id, nombre, aplicacion, tipo_concepto, operacion, rol_calculo, columna_planilla, orden,
                DATE_FORMAT(vigente_desde, '%Y-%m-%d') AS vigente_desde, monto_defecto, estado,
                (SELECT COUNT(*) FROM empleado_conceptos ec WHERE ec.concepto_id = conceptos.id AND ec.monto <> 0) AS asignados
         FROM conceptos WHERE id = ?`, [id]);
    return c || null;
}

const CAMPOS_CONCEPTO_CATALOGO = [
    ['nombre', 'Nombre'], ['aplicacion', 'Régimen'], ['tipo_concepto', 'Tipo'], ['operacion', 'Operación'],
    ['rol_calculo', 'Rol'], ['columna_planilla', 'Columna'], ['orden', 'Orden'], ['vigente_desde', 'Vigente desde'], ['monto_defecto', 'Monto por defecto'], ['estado', 'Estado']
];

// Recalcula la cuota sindical de todo trabajador que tenga afiliación o una fila de CUOTA SINDICAL
// (usar dentro de la transacción del cambio de catálogo)
async function resincronizarAfiliados(conn) {
    const [rows] = await conn.execute(`
        SELECT empleado_id FROM asignacion_sindicatos
        UNION
        SELECT ec.empleado_id FROM empleado_conceptos ec JOIN conceptos co ON co.id = ec.concepto_id
        WHERE co.rol_calculo = ?`, [DESCUENTOS_PLANILLA.sindicato.rol]);
    for (const r of rows) await sincronizarConceptoSindicato(conn, r.empleado_id);
}

// 1. LISTAR (por defecto solo activos; ?todos=1 para el mantenedor, con cuántos trabajadores lo tienen asignado)
app.get('/conceptos', verifyToken, async (req, res) => {
    try {
        const conn = await obtenerConexion();
        const todos = req.query.todos === '1';
        const [rows] = await conn.execute(`
            SELECT c.*, DATE_FORMAT(c.vigente_desde, '%Y-%m-%d') AS vigente_desde,
                   (SELECT COUNT(*) FROM empleado_conceptos ec WHERE ec.concepto_id = c.id AND ec.monto <> 0) AS asignados
            FROM conceptos c ${todos ? '' : "WHERE c.estado = 'activo'"}
            ORDER BY ${todos ? "c.estado = 'activo' DESC, c.operacion DESC, c.orden, c.aplicacion" : 'c.id DESC'}`);
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error al listar conceptos' });
    }
});

// 2. BUSCAR UNO SOLO (Para evitar error al cargar datos si el JS lo pide)
app.get('/conceptos/:id', verifyToken, async (req, res) => {
    try {
        const conn = await obtenerConexion();
        const [rows] = await conn.execute("SELECT * FROM conceptos WHERE id = ?", [req.params.id]);
        if (rows.length > 0) res.json(rows[0]);
        else res.status(404).json({ message: 'No encontrado' });
    } catch (err) { 
        res.status(500).json({ message: 'Error en servidor' }); 
    }
});

// 3. CREAR (POST)
app.post('/conceptos', verifyToken, async (req, res) => {
    const pool = await obtenerConexion();
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        const { datos, error } = await validarConcepto(conn, req.body);
        if (error) { await conn.rollback(); return res.status(400).json({ message: error }); }

        const [ins] = await conn.execute(
            `INSERT INTO conceptos (nombre, aplicacion, tipo_concepto, operacion, rol_calculo, columna_planilla, orden, vigente_desde, monto_defecto, estado)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [datos.nombre, datos.aplicacion, datos.tipo_concepto, datos.operacion, datos.rol_calculo, datos.columna_planilla, datos.orden, datos.vigente_desde, datos.monto_defecto, datos.estado]);

        await auditarEnTransaccion(conn, req, 'CREACIÓN CONCEPTO CATÁLOGO', null,
            `Concepto #${ins.insertId} ${datos.nombre} (${datos.aplicacion}, ${datos.operacion}, rol ${datos.rol_calculo}, columna "${datos.columna_planilla}", vigente desde ${datos.vigente_desde ? datos.vigente_desde.slice(0, 7) : 'siempre'})`);

        await conn.commit();
        res.json({ message: 'Concepto creado correctamente.', id: ins.insertId });
    } catch (err) {
        if (conn) await conn.rollback().catch(() => {});
        console.error(err);
        res.status(500).json({ message: 'Error al crear concepto' });
    } finally {
        if (conn) conn.release();
    }
});

// 4. EDITAR (PUT) - ¡ESTA ES LA RUTA QUE TE FALTABA!
app.put('/conceptos/:id', verifyToken, async (req, res) => {
    const { id } = req.params;
    const pool = await obtenerConexion();
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        const antes = await leerConceptoCatalogo(conn, id);
        if (!antes) { await conn.rollback(); return res.status(404).json({ message: 'Concepto no encontrado.' }); }

        const { datos, error } = await validarConcepto(conn, { ...req.body, estado: req.body.estado || antes.estado }, id, antes);
        if (error) { await conn.rollback(); return res.status(400).json({ message: error }); }

        await conn.execute(
            `UPDATE conceptos SET nombre=?, aplicacion=?, tipo_concepto=?, operacion=?, rol_calculo=?, columna_planilla=?, orden=?, vigente_desde=?, monto_defecto=?, estado=? WHERE id=?`,
            [datos.nombre, datos.aplicacion, datos.tipo_concepto, datos.operacion, datos.rol_calculo, datos.columna_planilla, datos.orden, datos.vigente_desde, datos.monto_defecto, datos.estado, id]);

        if ([antes.rol_calculo, datos.rol_calculo].includes(DESCUENTOS_PLANILLA.sindicato.rol)) await resincronizarAfiliados(conn);

        const despues = await leerConceptoCatalogo(conn, id);
        const cambios = resumirCambios(antes, despues, CAMPOS_CONCEPTO_CATALOGO);
        await auditarEnTransaccion(conn, req, 'EDICIÓN CONCEPTO CATÁLOGO', null,
            `Concepto #${id} ${despues.nombre}: ${cambios.length ? cambios.join('; ') : 'sin cambios'}`);

        await conn.commit();
        res.json({ message: 'Concepto actualizado correctamente.' });
    } catch (err) {
        if (conn) await conn.rollback().catch(() => {});
        console.error(err);
        res.status(500).json({ message: 'Error al actualizar concepto' });
    } finally {
        if (conn) conn.release();
    }
});

// 5. ELIMINAR (DELETE)
app.delete('/conceptos/:id', verifyToken, async (req, res) => {
    // Desactivar (no se borra): deja de procesarse en la planilla y de ofrecerse para asignar
    const pool = await obtenerConexion();
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        const c = await leerConceptoCatalogo(conn, req.params.id);
        if (!c) { await conn.rollback(); return res.status(404).json({ message: 'Concepto no encontrado.' }); }

        await conn.execute("UPDATE conceptos SET estado = 'inactivo' WHERE id = ?", [req.params.id]);
        if (c.rol_calculo === DESCUENTOS_PLANILLA.sindicato.rol) await resincronizarAfiliados(conn);
        await auditarEnTransaccion(conn, req, 'DESACTIVACIÓN CONCEPTO CATÁLOGO', null,
            `Concepto #${c.id} ${c.nombre} (${c.aplicacion}) desactivado` +
            (Number(c.asignados) ? ` - tenía monto asignado a ${c.asignados} trabajador(es), que dejan de recibirlo en la planilla` : ''));

        await conn.commit();
        res.json({ message: 'Concepto desactivado.', asignados: Number(c.asignados) });
    } catch (err) {
        if (conn) await conn.rollback().catch(() => {});
        console.error(err);
        res.status(500).json({ message: 'Error al desactivar' });
    } finally {
        if (conn) conn.release();
    }
});

// =======================================================
// === GESTIÓN DE CONCEPTOS POR EMPLEADO (AUTO-SINC JUDICIAL) ===
// =======================================================

// ==================== LISTAR CONCEPTOS (FINAL: LIMPIEZA INTELIGENTE PROTEGIENDO INGRESOS) ====================
app.get('/empleados/:id/conceptos', verifyToken, async (req, res) => {
    const empleadoId = req.params.id; 
    const periodoVisual = req.query.periodo; // <--- CAPTURAMOS EL PERIODO DE LA URL

    try {
        const conn = await obtenerConexion();

        // ---------------------------------------------------------
        // 1. SINCRONIZACIÓN JUDICIALES
        // ---------------------------------------------------------
        // Usa el concepto 'DSCTO JUDIC.' del régimen del empleado (ver sincronizarConceptoDescuento)
        await sincronizarConceptoJudicial(conn, empleadoId);

        // ---------------------------------------------------------
        // 2. SINCRONIZACIÓN PRÉSTAMOS
        // ---------------------------------------------------------
        // Usa el concepto 'DSCTO PRESTAMO' del régimen del empleado (ver sincronizarConceptoPrestamo)
        await sincronizarConceptoPrestamo(conn, empleadoId);

        // Usa el concepto 'CUOTA SINDICAL' del régimen del empleado (ver sincronizarConceptoSindicato)
        await sincronizarConceptoSindicato(conn, empleadoId);

        // ---------------------------------------------------------
        // 3. SINCRONIZACIÓN GRUPO OCUPACIONAL (DS 320-2022)
        // ---------------------------------------------------------
        const [empData] = await conn.execute("SELECT grupo_ocupacional_id, sistema_pension_id, tipo_comision FROM empleados WHERE id = ?", [empleadoId]);
        
        if (empData.length > 0 && empData[0].grupo_ocupacional_id) {
            const grupoId = empData[0].grupo_ocupacional_id;
            const [grupoRows] = await conn.execute("SELECT ds_320_2022_ef FROM grupos_ocupacionales WHERE id = ?", [grupoId]);
            const montoDS = grupoRows.length > 0 ? (parseFloat(grupoRows[0].ds_320_2022_ef) || 0) : 0;
            const [conceptosDS] = await conn.execute("SELECT id FROM conceptos WHERE nombre LIKE '%320-2022%' AND estado = 'activo' LIMIT 1");

            if (conceptosDS.length > 0) {
                const idC = conceptosDS[0].id;
                const [ex] = await conn.execute("SELECT id FROM empleado_conceptos WHERE empleado_id=? AND concepto_id=?", [empleadoId, idC]);
                if (montoDS > 0) {
                    if (ex.length > 0) await conn.execute("UPDATE empleado_conceptos SET monto=? WHERE id=?", [montoDS, ex[0].id]);
                    else await conn.execute("INSERT INTO empleado_conceptos (empleado_id, concepto_id, monto) VALUES (?,?,?)", [empleadoId, idC, montoDS]);
                } else if (ex.length > 0) await conn.execute("UPDATE empleado_conceptos SET monto=0 WHERE id=?", [ex[0].id]);
            }
        }

        // ---------------------------------------------------------
        // 4. SINCRONIZACIÓN Y LIMPIEZA DE PENSIONES (CORREGIDO)
        // ---------------------------------------------------------
        if (empData.length > 0 && empData[0].sistema_pension_id) {
            const [sisRows] = await conn.execute("SELECT descripcion FROM sistemas_pensiones WHERE id = ?", [empData[0].sistema_pension_id]);
            
            if (sisRows.length > 0) {
                const nombreSistema = sisRows[0].descripcion.toUpperCase();
                
                // === [A] FASE DE LIMPIEZA INTELIGENTE ===
                let borrarQuery = "";
                
                if (nombreSistema.includes('ONP') || nombreSistema.includes('NACIONAL') || nombreSistema.includes('SNP')) {
                    console.log(`[LIMPIEZA] Empleado ${empleadoId} es ONP. Borrando DESCUENTOS AFP...`);
                    borrarQuery = `
                        DELETE ec FROM empleado_conceptos ec 
                        INNER JOIN conceptos c ON ec.concepto_id = c.id 
                        WHERE ec.empleado_id = ? 
                        AND c.operacion = 'Descuento' 
                        AND (c.nombre LIKE '%AFP%' OR c.nombre LIKE '%PRIMA%' OR c.nombre LIKE '%COMISION%')
                    `;
                } else {
                    console.log(`[LIMPIEZA] Empleado ${empleadoId} es AFP. Borrando conceptos ONP...`);
                    borrarQuery = `
                        DELETE ec FROM empleado_conceptos ec 
                        INNER JOIN conceptos c ON ec.concepto_id = c.id 
                        WHERE ec.empleado_id = ? 
                        AND c.operacion = 'Descuento'
                        AND (c.nombre LIKE '%ONP%' OR c.nombre LIKE '%SNP%' OR c.nombre LIKE '%NACIONAL%')
                    `;
                }
                
                if(borrarQuery) {
                    await conn.execute(borrarQuery, [empleadoId]);
                }

                // === [B] FASE DE ACTUALIZACIÓN DE TASAS ===
                // AQUI ESTABA EL OTRO ERROR: AHORA USAMOS DIRECTAMENTE "periodoVisual" QUE VIENE DE LA URL
                if (periodoVisual) {
                    const formatearPeriodo = (p) => { if(!p) return null; const partes = p.split('-'); if(partes.length < 2) return p; const mes = { 'Enero':'01', 'Febrero':'02', 'Marzo':'03', 'Abril':'04', 'Mayo':'05', 'Junio':'06', 'Julio':'07', 'Agosto':'08', 'Septiembre':'09', 'Octubre':'10', 'Noviembre':'11', 'Diciembre':'12' }[partes[1]]; return `${partes[0]}-${mes}`; };
                    const periodoBD = formatearPeriodo(periodoVisual);
                    const [tasas] = await conn.execute(`SELECT * FROM comisiones_spp WHERE regimen LIKE CONCAT('%', ?, '%') AND periodo = ? LIMIT 1`, [nombreSistema, periodoBD]);

                    if (tasas.length > 0) {
                        const t = tasas[0];
                        let mapeo = [];

                        if (nombreSistema.includes('ONP') || nombreSistema.includes('NACIONAL') || nombreSistema.includes('SNP')) {
                            mapeo.push({ keywords: ['ONP', 'SISTEMA NACIONAL', 'SNP'], monto: parseFloat(t.aporte) || 0 });
                        } else {
                            const tipoCom = empData[0].tipo_comision;
                            let montoComision = 0;
                            
                            if (tipoCom === 'Mixta') montoComision = parseFloat(t.comision_mixta) || 0;
                            else if (tipoCom === 'Flujo') montoComision = parseFloat(t.comision) || 0;

                            mapeo.push({ keywords: ['AFP - APORTE', 'APORTE OBLIGATORIO'], monto: parseFloat(t.aporte) || 0 });
                            mapeo.push({ keywords: ['AFP - SEGURO', 'PRIMA DE SEGURO'], monto: parseFloat(t.seguroprima) || 0 });
                            mapeo.push({ keywords: ['AFP - COMISION', 'COMISION VARIABLE'], monto: montoComision });
                        }

                        for (const item of mapeo) {
                            if (item.monto > 0) {
                                const likeQuery = item.keywords.map(() => "nombre LIKE ?").join(" OR ");
                                const paramsLike = item.keywords.map(k => `%${k}%`);
                                const [conFound] = await conn.execute(`SELECT id FROM conceptos WHERE (${likeQuery}) AND estado = 'activo' LIMIT 1`, paramsLike);
                                
                                if (conFound.length > 0) {
                                    const idC = conFound[0].id;
                                    const [ex] = await conn.execute("SELECT id FROM empleado_conceptos WHERE empleado_id=? AND concepto_id=?", [empleadoId, idC]);
                                    if (ex.length > 0) await conn.execute("UPDATE empleado_conceptos SET monto=? WHERE id=?", [item.monto, ex[0].id]);
                                    else await conn.execute("INSERT INTO empleado_conceptos (empleado_id, concepto_id, monto) VALUES (?,?,?)", [empleadoId, idC, item.monto]);
                                }
                            }
                        }
                    }
                }
            }
        }

        // ---------------------------------------------------------
        // 5. LISTAR RESULTADO FINAL
        // ---------------------------------------------------------
        // Todo texto sale de la tabla maestra (empleado_conceptos no guarda nombres).
        // nombre_concepto_maestro = lo que la planilla muestra como cabecera (columna_planilla),
        // así el modal y la planilla siempre coinciden; 'concepto' es el nombre interno.
        const sqlFinal = `
            SELECT ec.id,
                   COALESCE(NULLIF(TRIM(c.columna_planilla), ''), c.nombre) AS nombre_concepto_maestro,
                   c.nombre AS concepto, c.columna_planilla, c.rol_calculo, ec.monto, c.tipo_concepto, c.operacion
            FROM empleado_conceptos ec
            INNER JOIN conceptos c ON ec.concepto_id = c.id
            WHERE ec.empleado_id = ?
        `;
        const [rows] = await conn.execute(sqlFinal, [empleadoId]);
        res.json(rows);

    } catch (err) { 
        console.error("Error al sincronizar conceptos:", err);
        res.status(500).json({ message: 'Error al listar conceptos' }); 
    }
});

// 2. AGREGAR CONCEPTO A EMPLEADO
// ==================== AUDITORÍA DE CONCEPTOS DEL TRABAJADOR ====================
// (modal "Conceptos del Trabajador": agregar, editar monto, quitar)
async function leerConceptoEmpleado(conn, empleadoConceptoId, bloquear = false) {
    const [[fila]] = await conn.execute(`
        SELECT ec.id, ec.empleado_id, ec.monto, co.nombre, co.tipo_concepto
        FROM empleado_conceptos ec JOIN conceptos co ON co.id = ec.concepto_id
        WHERE ec.id = ?${bloquear ? ' FOR UPDATE' : ''}`, [empleadoConceptoId]);
    return fila || null;
}
// Porcentuales (AFP, ONP...) en %, el resto en soles
const montoConcepto = (fila, monto) => fila.tipo_concepto === 'Porcentual' ? porcentaje(monto) : soles(monto);

app.post('/empleados/conceptos', verifyToken, async (req, res) => {
    const { empleado_id, concepto_id, monto } = req.body;
    // Alta + auditoría en la misma transacción
    const pool = await obtenerConexion();
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        // Validar si ya existe
        const [existe] = await conn.execute("SELECT id FROM empleado_conceptos WHERE empleado_id = ? AND concepto_id = ?", [empleado_id, concepto_id]);
        if(existe.length > 0) {
            await conn.rollback();
            return res.status(400).json({ message: 'El empleado ya tiene este concepto. Use editar.' });
        }

        const [ins] = await conn.execute("INSERT INTO empleado_conceptos (empleado_id, concepto_id, monto) VALUES (?, ?, ?)", [empleado_id, concepto_id, monto]);

        const nuevo = await leerConceptoEmpleado(conn, ins.insertId);
        await auditarEnTransaccion(conn, req, 'CREACIÓN CONCEPTO', empleado_id,
            `Se asignó concepto ${nuevo.nombre}: ${montoConcepto(nuevo, nuevo.monto)}`);

        await conn.commit();
        res.json({ message: 'Concepto agregado.' });
    } catch (err) {
        if (conn) await conn.rollback().catch(() => {});
        console.error(err);
        res.status(500).json({ message: 'Error al agregar' });
    } finally {
        if (conn) conn.release();
    }
});

// 3. ELIMINAR CONCEPTO DE EMPLEADO
app.delete('/empleados/conceptos/:id', verifyToken, async (req, res) => {
    const pool = await obtenerConexion();
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        const anterior = await leerConceptoEmpleado(conn, req.params.id, true);
        await conn.execute("DELETE FROM empleado_conceptos WHERE id = ?", [req.params.id]);

        if (anterior) {
            await auditarEnTransaccion(conn, req, 'ELIMINACIÓN CONCEPTO', anterior.empleado_id,
                `Se quitó concepto ${anterior.nombre} (tenía ${montoConcepto(anterior, anterior.monto)})`);
        }

        await conn.commit();
        res.json({ message: 'Concepto quitado.' });
    } catch (err) {
        if (conn) await conn.rollback().catch(() => {});
        console.error(err);
        res.status(500).json({ message: 'Error al eliminar' });
    } finally {
        if (conn) conn.release();
    }
});

// ==================== RUTA: ACTUALIZAR EL CONCEPTO DESDE EL VERDE ====================
app.put('/empleados/conceptos/actualizar-principal', verifyToken, async (req, res) => {
    const { empleado_id, nuevo_monto } = req.body;
    const pool = await obtenerConexion();
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        // Buscamos el ÚLTIMO concepto que tenga este empleado
        const [conceptos] = await conn.execute(
            `SELECT id FROM empleado_conceptos WHERE empleado_id = ? ORDER BY id DESC LIMIT 1 FOR UPDATE`,
            [empleado_id]
        );

        if (conceptos.length > 0) {
            const anterior = await leerConceptoEmpleado(conn, conceptos[0].id);
            await conn.execute(
                'UPDATE empleado_conceptos SET monto = ? WHERE id = ?',
                [nuevo_monto, conceptos[0].id]
            );
            const actual = await leerConceptoEmpleado(conn, conceptos[0].id);
            await auditarEnTransaccion(conn, req, 'EDICIÓN CONCEPTO', empleado_id,
                `${actual.nombre}: ${montoConcepto(anterior, anterior.monto)} → ${montoConcepto(actual, actual.monto)}`);
            await conn.commit();
            res.json({ message: 'Sincronizado correctamente.' });
        } else {
            await conn.rollback();
            res.json({ message: 'No hay concepto para actualizar.' });
        }
    } catch (err) {
        if (conn) await conn.rollback().catch(() => {});
        console.error(err);
        res.status(500).json({ message: 'Error al sincronizar.' });
    } finally {
        if (conn) conn.release();
    }
});

// ==================== EDITAR UN CONCEPTO INDIVIDUAL ====================
app.put('/empleados/conceptos-individual/:id', verifyToken, async (req, res) => {
    const id = req.params.id;
    const { monto } = req.body;

    if (monto === undefined) {
        return res.status(400).json({ message: 'Falta el monto.' });
    }

    // Cambio + auditoría (con el monto anterior) en la misma transacción
    const pool = await obtenerConexion();
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        const anterior = await leerConceptoEmpleado(conn, id, true);
        if (!anterior) {
            await conn.rollback();
            return res.status(404).json({ message: 'Concepto no encontrado.' });
        }

        await conn.execute(
            'UPDATE empleado_conceptos SET monto = ? WHERE id = ?',
            [monto, id]
        );

        // Ej: "REMUN. BASICA: S/ 2,000.00 → S/ 2,020.00"
        const actual = await leerConceptoEmpleado(conn, id);
        const cambio = Number(anterior.monto) === Number(actual.monto)
            ? `${actual.nombre}: ${montoConcepto(actual, actual.monto)} (sin cambios)`
            : `${actual.nombre}: ${montoConcepto(anterior, anterior.monto)} → ${montoConcepto(actual, actual.monto)}`;
        await auditarEnTransaccion(conn, req, 'EDICIÓN CONCEPTO', anterior.empleado_id, cambio);

        await conn.commit();
        res.json({ message: 'Concepto actualizado correctamente.' });
    } catch (err) {
        if (conn) await conn.rollback().catch(() => {});
        console.error(err);
        res.status(500).json({ message: 'Error al actualizar concepto.' });
    } finally {
        if (conn) conn.release();
    }
});

// =======================================================
// === RUTAS JUDICIALES (PEGAR AL FINAL DE SERVER.JS) ===
// =======================================================

// =======================================================
// === SINCRONIZACIÓN DE DESCUENTOS CON LA PLANILLA (empleado_conceptos) ===
// =======================================================
// conceptos.aplicacion coincide con empleados.tipo_contrato, así que cada régimen tiene su propio concepto:
//   DSCTO PRESTAMO -> Empleado 39, CAS 73, Obrero 78  (monto = suma de préstamos activos)
//   DSCTO JUDIC.   -> Empleado 16, CAS 72, Obrero 79  (monto = suma de % judiciales activos)
// En judiciales se prefiere el concepto 'Porcentual' porque Obrero también tiene uno 'Variable' (63).
const DESCUENTOS_PLANILLA = {
    prestamo: {
        concepto: 'DSCTO PRESTAMO', rol: 'PRESTAMO',
        sqlTotal: "SELECT SUM(monto_total) as total FROM prestamos WHERE empleado_id = ? AND estado = 'activo'"
    },
    judicial: {
        concepto: 'DSCTO JUDIC.', rol: 'JUDICIAL',
        sqlTotal: "SELECT SUM(porcentual) as total FROM judiciales WHERE empleado_id = ? AND estado = 'activo'"
    },
    sindicato: {
        concepto: 'CUOTA SINDICAL', rol: 'SINDICATO',
        // Solo afiliaciones activas de sindicatos activos
        sqlTotal: `SELECT SUM(a.monto) as total FROM asignacion_sindicatos a JOIN sindicatos s ON s.id = a.sindicato_id
                   WHERE a.empleado_id = ? AND a.estado = 'activo' AND s.estado = 'activo'`
    }
};

// Devuelve el id del concepto de descuento que corresponde al régimen del empleado.
async function obtenerConceptoDescuento(conn, empleadoId, tipo) {
    const [rows] = await conn.execute(`
        SELECT co.id FROM empleados e
        JOIN conceptos co ON co.aplicacion = e.tipo_contrato
        WHERE e.id = ? AND co.rol_calculo = ? AND co.estado = 'activo'
        ORDER BY co.tipo_concepto = 'Porcentual' DESC, co.id LIMIT 1`, [empleadoId, DESCUENTOS_PLANILLA[tipo].rol]);
    return rows.length > 0 ? rows[0].id : null;
}

// Deja en empleado_conceptos el total vigente del empleado (UPDATE si ya existe, si no INSERT).
// Recibe la conexión para poder usarse dentro de una transacción. Devuelve null si su régimen no tiene concepto.
async function sincronizarConceptoDescuento(conn, empleadoId, tipo) {
    const conceptoId = await obtenerConceptoDescuento(conn, empleadoId, tipo);
    if (!conceptoId) return null;

    const [totRows] = await conn.execute(DESCUENTOS_PLANILLA[tipo].sqlTotal, [empleadoId]);
    const total = parseFloat(totRows[0].total) || 0;

    const [ex] = await conn.execute("SELECT id FROM empleado_conceptos WHERE empleado_id=? AND concepto_id=?", [empleadoId, conceptoId]);
    if (ex.length > 0) await conn.execute("UPDATE empleado_conceptos SET monto=? WHERE id=?", [total, ex[0].id]);
    else if (total > 0) await conn.execute("INSERT INTO empleado_conceptos (empleado_id, concepto_id, monto) VALUES (?,?,?)", [empleadoId, conceptoId, total]);

    // Filas del mismo descuento de OTRO régimen (quedan tras cambiar tipo_contrato): en 0, si no se
    // descontaría dos veces. No se borran; el modal del trabajador oculta los montos en 0.
    await conn.execute(`
        UPDATE empleado_conceptos ec
        JOIN conceptos co ON co.id = ec.concepto_id
        JOIN empleados e ON e.id = ec.empleado_id
        SET ec.monto = 0
        WHERE ec.empleado_id = ? AND co.rol_calculo = ? AND co.aplicacion <> e.tipo_contrato AND ec.monto <> 0`,
        [empleadoId, DESCUENTOS_PLANILLA[tipo].rol]);
    return conceptoId;
}

const sincronizarConceptoPrestamo = (conn, empleadoId) => sincronizarConceptoDescuento(conn, empleadoId, 'prestamo');
const sincronizarConceptoJudicial = (conn, empleadoId) => sincronizarConceptoDescuento(conn, empleadoId, 'judicial');

// Cuota sindical: 'CUOTA SINDICAL' del régimen del trabajador (34 Empleado, 50 CAS, 62 Obrero) con la suma
// de sus afiliaciones activas (asignacion_sindicatos) a sindicatos activos. Cualquier otra fila de rol
// SINDICATO (otro régimen, concepto antiguo o desactivado) queda en 0: la planilla suma todas las de ese rol.
// Si su régimen no tiene 'CUOTA SINDICAL' activa, todas quedan en 0 y devuelve null.
// Llamar dentro de la transacción de la operación que cambió la afiliación, el sindicato o el régimen.
async function sincronizarConceptoSindicato(conn, empleadoId) {
    const conceptoId = await sincronizarConceptoDescuento(conn, empleadoId, 'sindicato');
    await conn.execute(`
        UPDATE empleado_conceptos ec JOIN conceptos co ON co.id = ec.concepto_id
        SET ec.monto = 0
        WHERE ec.empleado_id = ? AND co.rol_calculo = ? AND ec.concepto_id <> ? AND ec.monto <> 0`,
        [empleadoId, DESCUENTOS_PLANILLA.sindicato.rol, conceptoId || 0]);
    return conceptoId;
}

// Tras cambiar el régimen de un trabajador: sus descuentos pasan al concepto de su nuevo régimen
async function sincronizarDescuentosEmpleado(conn, empleadoId) {
    await sincronizarConceptoPrestamo(conn, empleadoId);
    await sincronizarConceptoJudicial(conn, empleadoId);
    await sincronizarConceptoSindicato(conn, empleadoId);
}

// ==================== AUDITORÍA DE PRÉSTAMOS Y JUDICIALES ====================
// Se inserta con la MISMA conexión de la transacción: si la operación se revierte, el registro también.
async function auditarEnTransaccion(conn, req, accion, empleadoId, detalles) {
    await conn.execute(
        'INSERT INTO auditoria_empleados (usuario, accion, empleado_id, ip_address, user_agent, detalles) VALUES (?, ?, ?, ?, ?, ?)',
        [req.authData?.user?.username || 'sistema', accion, empleadoId || null, req.ip || null, req.headers['user-agent'] || null, detalles]);
}

const soles = (monto) => `S/ ${(parseFloat(monto) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const porcentaje = (valor) => `${Number(valor) || 0}%`;

async function nombreDeEmpleado(conn, empleadoId) {
    const [[fila]] = await conn.execute(`
        SELECT CONCAT(COALESCE(p.apellido_paterno,''), ' ', COALESCE(p.apellido_materno,''), ', ', COALESCE(p.nombre,'')) AS nombre
        FROM empleados e JOIN personas p ON p.id = e.persona_id WHERE e.id = ?`, [empleadoId]);
    return fila ? fila.nombre : `empleado ${empleadoId}`;
}

async function leerPrestamo(conn, id) {
    const [[fila]] = await conn.execute(
        `SELECT id, empleado_id, entidad_financiera, monto_total, CAST(fecha_inicio AS CHAR) AS fecha_inicio, observacion
         FROM prestamos WHERE id = ?`, [id]);
    return fila || null;
}

async function leerJudicial(conn, id) {
    const [[fila]] = await conn.execute(`
        SELECT j.id, j.empleado_id, j.beneficiario_id, j.tipo_judicial, j.porcentual, j.referencia,
               CONCAT(COALESCE(p.apellido_paterno,''), ' ', COALESCE(p.apellido_materno,''), ', ', COALESCE(p.nombre,'')) AS beneficiario
        FROM judiciales j LEFT JOIN personas p ON p.id = j.beneficiario_id WHERE j.id = ?`, [id]);
    return fila || null;
}

const CAMPOS_PRESTAMO_AUDITADOS = [
    ['entidad_financiera', 'Entidad'], ['monto_total', 'Monto', soles], ['fecha_inicio', 'Inicio'], ['observacion', 'Observación']
];
const CAMPOS_JUDICIAL_AUDITADOS = [
    ['tipo_judicial', 'Tipo'], ['porcentual', 'Porcentaje', porcentaje], ['beneficiario', 'Beneficiario'], ['referencia', 'Referencia']
];

// 1. LISTAR JUDICIALES ACTIVOS (CON TIPO DE TRABAJADOR)
app.get('/judiciales', verifyToken, async (req, res) => {
    try {
        const conn = await obtenerConexion();
        const sql = `
            SELECT 
                j.id, j.tipo_judicial, j.porcentual, j.referencia,
                e.tipo_contrato, -- <--- NUEVO CAMPO AGREGADO
                p1.dni as dni_trabajador,
                CONCAT(p1.apellido_paterno, ' ', p1.apellido_materno, ', ', p1.nombre) as nombre_trabajador,
                CONCAT(p2.apellido_paterno, ' ', p2.apellido_materno, ', ', p2.nombre) as nombre_beneficiario
            FROM judiciales j
            INNER JOIN empleados e ON j.empleado_id = e.id
            INNER JOIN personas p1 ON e.persona_id = p1.id
            INNER JOIN personas p2 ON j.beneficiario_id = p2.id
            WHERE j.estado = 'activo'
            ORDER BY p1.apellido_paterno ASC
        `;
        const [rows] = await conn.execute(sql);
        res.json(rows);
    } catch (err) { res.status(500).json({ message: 'Error al listar' }); }
});

// 2. CREAR + vincula el descuento a la planilla (empleado_conceptos)
app.post('/judiciales', verifyToken, async (req, res) => {
    const { empleado_id, beneficiario_id, tipo_judicial, porcentual, referencia } = req.body;

    if (!empleado_id || !beneficiario_id) return res.status(400).json({ message: 'Faltan datos' });

    // Las transacciones necesitan una conexión dedicada del pool.
    const pool = await obtenerConexion();
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        const [ins] = await conn.execute(
            'INSERT INTO judiciales (empleado_id, beneficiario_id, tipo_judicial, porcentual, referencia, estado) VALUES (?, ?, ?, ?, ?, ?)',
            [empleado_id, beneficiario_id, tipo_judicial, porcentual, referencia, 'activo']
        );

        const conceptoId = await sincronizarConceptoJudicial(conn, empleado_id);
        if (!conceptoId) {
            await conn.rollback();
            return res.status(400).json({ message: "No existe un concepto 'DSCTO JUDIC.' activo para el régimen del empleado." });
        }

        const nuevo = await leerJudicial(conn, ins.insertId);
        await auditarEnTransaccion(conn, req, 'CREACIÓN JUDICIAL', empleado_id,
            `Se registró retención judicial #${nuevo.id} de ${porcentaje(nuevo.porcentual)}` +
            `${nuevo.tipo_judicial ? ' (' + nuevo.tipo_judicial + ')' : ''} a favor de ${nuevo.beneficiario}` +
            `${nuevo.referencia ? ' - Ref: ' + nuevo.referencia : ''}`);

        await conn.commit();
        res.status(201).json({ message: 'Guardado correctamente' });
    } catch (err) {
        if (conn) await conn.rollback().catch(() => {});
        console.error(err);
        res.status(500).json({ message: 'Error al guardar' });
    } finally {
        if (conn) conn.release();
    }
});

// 3. ELIMINAR (Soft Delete) + recalcula el descuento en planilla
app.delete('/judiciales/:id', verifyToken, async (req, res) => {
    const pool = await obtenerConexion();
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        const [actual] = await conn.execute('SELECT empleado_id FROM judiciales WHERE id = ? FOR UPDATE', [req.params.id]);
        if (actual.length === 0) {
            await conn.rollback();
            return res.status(404).json({ message: 'No encontrado' });
        }

        const judicial = await leerJudicial(conn, req.params.id);
        await conn.execute("UPDATE judiciales SET estado = 'inactivo' WHERE id = ?", [req.params.id]);
        // Queda en 0 si al empleado no le quedan judiciales activos
        await sincronizarConceptoJudicial(conn, actual[0].empleado_id);

        await auditarEnTransaccion(conn, req, 'ELIMINACIÓN JUDICIAL', judicial.empleado_id,
            `Se eliminó retención judicial #${judicial.id} de ${porcentaje(judicial.porcentual)} a favor de ${judicial.beneficiario}`);

        await conn.commit();
        res.json({ message: 'Eliminado' });
    } catch (err) {
        if (conn) await conn.rollback().catch(() => {});
        console.error(err);
        res.status(500).json({ message: 'Error al eliminar' });
    } finally {
        if (conn) conn.release();
    }
});

// ... (Tus rutas anteriores de judiciales)

// 4. OBTENER UN JUDICIAL POR ID (PARA EDITAR)
app.get('/judiciales/:id', verifyToken, async (req, res) => {
    const { id } = req.params;
    try {
        const conn = await obtenerConexion();
        const sql = `
            SELECT 
                j.*,
                -- Datos Trabajador
                e.id as id_empleado,
                p1.dni as dni_trabajador,
                p1.nombre as nom_trabajador,
                p1.apellido_paterno as ape_pat_trabajador,
                p1.apellido_materno as ape_mat_trabajador,
                p1.foto as foto_trabajador,
                -- Datos Beneficiario
                p2.id as id_beneficiario_persona,
                p2.dni as dni_beneficiario,
                p2.nombre as nom_beneficiario,
                p2.apellido_paterno as ape_pat_beneficiario,
                p2.apellido_materno as ape_mat_beneficiario,
                p2.foto as foto_beneficiario
            FROM judiciales j
            INNER JOIN empleados e ON j.empleado_id = e.id
            INNER JOIN personas p1 ON e.persona_id = p1.id
            INNER JOIN personas p2 ON j.beneficiario_id = p2.id
            WHERE j.id = ?
        `;
        const [rows] = await conn.execute(sql, [id]);
        
        if (rows.length === 0) return res.status(404).json({ message: 'No encontrado' });

        // Procesar fotos a Base64 si vienen en Buffer
        const item = rows[0];
        const procesarFoto = (f) => f && f instanceof Buffer ? f.toString('base64') : (f || null);
        
        item.foto_trabajador = procesarFoto(item.foto_trabajador);
        item.foto_beneficiario = procesarFoto(item.foto_beneficiario);

        res.json(item);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error al obtener datos' });
    }
});

// 5. ACTUALIZAR (PUT)
app.put('/judiciales/:id', verifyToken, async (req, res) => {
    const { id } = req.params;
    const { empleado_id, beneficiario_id, tipo_judicial, porcentual, referencia } = req.body;

    const pool = await obtenerConexion();
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        // Guardamos el empleado anterior: si el judicial cambia de empleado, hay que recalcular a ambos
        const [actual] = await conn.execute('SELECT empleado_id FROM judiciales WHERE id = ? FOR UPDATE', [id]);
        if (actual.length === 0) {
            await conn.rollback();
            return res.status(404).json({ message: 'No encontrado' });
        }
        const empleadoAnterior = actual[0].empleado_id;
        const judicialAntes = await leerJudicial(conn, id);

        await conn.execute(
            'UPDATE judiciales SET empleado_id=?, beneficiario_id=?, tipo_judicial=?, porcentual=?, referencia=? WHERE id=?',
            [empleado_id, beneficiario_id, tipo_judicial, porcentual, referencia, id]
        );

        const conceptoId = await sincronizarConceptoJudicial(conn, empleado_id);
        if (!conceptoId) {
            await conn.rollback();
            return res.status(400).json({ message: "No existe un concepto 'DSCTO JUDIC.' activo para el régimen del empleado." });
        }
        if (String(empleadoAnterior) !== String(empleado_id)) {
            await sincronizarConceptoJudicial(conn, empleadoAnterior);
        }

        const judicialDespues = await leerJudicial(conn, id);
        const cambiosJ = resumirCambios(judicialAntes, judicialDespues, CAMPOS_JUDICIAL_AUDITADOS);
        if (String(empleadoAnterior) !== String(empleado_id)) {
            // Reasignado: queda en el historial de ambos trabajadores
            const nombreNuevo = await nombreDeEmpleado(conn, empleado_id);
            const nombreAnterior = await nombreDeEmpleado(conn, empleadoAnterior);
            cambiosJ.unshift(`Trabajador: ${nombreAnterior} → ${nombreNuevo}`);
            await auditarEnTransaccion(conn, req, 'EDICIÓN JUDICIAL', empleadoAnterior,
                `Retención judicial #${id} (${porcentaje(judicialDespues.porcentual)}) reasignada a ${nombreNuevo}`);
        }
        await auditarEnTransaccion(conn, req, 'EDICIÓN JUDICIAL', empleado_id,
            cambiosJ.length
                ? `Se editó retención judicial #${id}: ${cambiosJ.join('; ')}`
                : `Se editó retención judicial #${id} (sin cambios)`);

        await conn.commit();
        res.json({ message: 'Actualizado correctamente' });
    } catch (err) {
        if (conn) await conn.rollback().catch(() => {});
        console.error(err);
        res.status(500).json({ message: 'Error al actualizar' });
    } finally {
        if (conn) conn.release();
    }
});

// =======================================================
// === RUTAS DE PRÉSTAMOS (NUEVO MÓDULO) ===
// =======================================================

// ==========================================
// === RUTAS DE PRÉSTAMOS (LIMPIAS) ===
// ==========================================

// 1. LISTAR (Sin cuotas ni mensual)
app.get('/prestamos', verifyToken, async (req, res) => {
    try {
        const conn = await obtenerConexion();
        const sql = `
            SELECT 
                pr.id, pr.entidad_financiera, pr.monto_total, pr.fecha_inicio,
                e.tipo_contrato,
                p.dni,
                CONCAT(p.apellido_paterno, ' ', p.apellido_materno, ', ', p.nombre) as nombre_completo
            FROM prestamos pr
            INNER JOIN empleados e ON pr.empleado_id = e.id
            INNER JOIN personas p ON e.persona_id = p.id
            WHERE pr.estado = 'activo'
            ORDER BY pr.id DESC
        `;
        const [rows] = await conn.execute(sql);
        res.json(rows);
    } catch (err) { res.status(500).json({ message: 'Error al listar préstamos' }); }
});

// 2. CREAR (Ya no pedimos cuotas) + vincula el descuento a la planilla (empleado_conceptos)
app.post('/prestamos', verifyToken, async (req, res) => {
    const { empleado_id, entidad_financiera, monto_total, fecha_inicio, observacion } = req.body;

    if (!empleado_id || !entidad_financiera || !monto_total) {
        return res.status(400).json({ message: 'Faltan datos obligatorios' });
    }

    // Las transacciones necesitan una conexión dedicada del pool.
    const pool = await obtenerConexion();
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        const [ins] = await conn.execute(
            'INSERT INTO prestamos (empleado_id, entidad_financiera, monto_total, fecha_inicio, observacion, estado) VALUES (?, ?, ?, ?, ?, ?)',
            [empleado_id, entidad_financiera, monto_total, fecha_inicio, observacion, 'activo']
        );

        const conceptoId = await sincronizarConceptoPrestamo(conn, empleado_id);
        if (!conceptoId) {
            await conn.rollback();
            return res.status(400).json({ message: "No existe un concepto 'DSCTO PRESTAMO' activo para el régimen del empleado." });
        }

        const nuevo = await leerPrestamo(conn, ins.insertId);
        await auditarEnTransaccion(conn, req, 'CREACIÓN PRÉSTAMO', empleado_id,
            `Se registró préstamo #${nuevo.id} por ${soles(nuevo.monto_total)} con ${nuevo.entidad_financiera}` +
            `${nuevo.fecha_inicio ? ' (inicio ' + nuevo.fecha_inicio + ')' : ''}`);

        await conn.commit();
        res.status(201).json({ message: 'Préstamo registrado' });
    } catch (err) {
        if (conn) await conn.rollback().catch(() => {});
        console.error(err);
        res.status(500).json({ message: 'Error al guardar' });
    } finally {
        if (conn) conn.release();
    }
});

// 3. EDITAR (Limpiamos el UPDATE)
app.put('/prestamos/:id', verifyToken, async (req, res) => {
    const { id } = req.params;
    const { empleado_id, entidad_financiera, monto_total, fecha_inicio, observacion } = req.body;

    const pool = await obtenerConexion();
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        // Guardamos el empleado anterior: si el préstamo cambia de empleado, hay que recalcular a ambos
        const [actual] = await conn.execute('SELECT empleado_id FROM prestamos WHERE id = ? FOR UPDATE', [id]);
        if (actual.length === 0) {
            await conn.rollback();
            return res.status(404).json({ message: 'No encontrado' });
        }
        const empleadoAnterior = actual[0].empleado_id;
        const prestamoAntes = await leerPrestamo(conn, id);

        await conn.execute(
            'UPDATE prestamos SET empleado_id=?, entidad_financiera=?, monto_total=?, fecha_inicio=?, observacion=? WHERE id=?',
            [empleado_id, entidad_financiera, monto_total, fecha_inicio, observacion, id]
        );

        const conceptoId = await sincronizarConceptoPrestamo(conn, empleado_id);
        if (!conceptoId) {
            await conn.rollback();
            return res.status(400).json({ message: "No existe un concepto 'DSCTO PRESTAMO' activo para el régimen del empleado." });
        }
        if (String(empleadoAnterior) !== String(empleado_id)) {
            await sincronizarConceptoPrestamo(conn, empleadoAnterior);
        }

        const prestamoDespues = await leerPrestamo(conn, id);
        const cambiosP = resumirCambios(prestamoAntes, prestamoDespues, CAMPOS_PRESTAMO_AUDITADOS);
        if (String(empleadoAnterior) !== String(empleado_id)) {
            // Reasignado: queda en el historial de ambos trabajadores
            const nombreNuevo = await nombreDeEmpleado(conn, empleado_id);
            const nombreAnterior = await nombreDeEmpleado(conn, empleadoAnterior);
            cambiosP.unshift(`Trabajador: ${nombreAnterior} → ${nombreNuevo}`);
            await auditarEnTransaccion(conn, req, 'EDICIÓN PRÉSTAMO', empleadoAnterior,
                `Préstamo #${id} (${soles(prestamoDespues.monto_total)}) reasignado a ${nombreNuevo}`);
        }
        await auditarEnTransaccion(conn, req, 'EDICIÓN PRÉSTAMO', empleado_id,
            cambiosP.length
                ? `Se editó préstamo #${id}: ${cambiosP.join('; ')}`
                : `Se editó préstamo #${id} (sin cambios)`);

        await conn.commit();
        res.json({ message: 'Préstamo actualizado' });
    } catch (err) {
        if (conn) await conn.rollback().catch(() => {});
        console.error(err);
        res.status(500).json({ message: 'Error al actualizar' });
    } finally {
        if (conn) conn.release();
    }
});

// 4. OBTENER POR ID (Limpiamos el SELECT)
app.get('/prestamos/:id', verifyToken, async (req, res) => {
    try {
        const conn = await obtenerConexion();
        // Ya no traemos cuotas ni monto_cuota
        const sql = `
            SELECT pr.id, pr.empleado_id, pr.entidad_financiera, pr.monto_total, pr.fecha_inicio, pr.observacion,
                   p.dni, p.nombre, p.apellido_paterno, p.apellido_materno, p.foto 
            FROM prestamos pr
            INNER JOIN empleados e ON pr.empleado_id = e.id
            INNER JOIN personas p ON e.persona_id = p.id
            WHERE pr.id = ?
        `;
        const [rows] = await conn.execute(sql, [req.params.id]);
        if(rows.length > 0) {
            const item = rows[0];
            item.foto = item.foto && item.foto instanceof Buffer ? item.foto.toString('base64') : (item.foto || null);
            res.json(item);
        } else {
            res.status(404).json({ message: 'No encontrado' });
        }
    } catch (err) { res.status(500).json({ message: 'Error al obtener' }); }
});

// 5. ELIMINAR (Soft Delete: Cambia estado a 'anulado')
app.delete('/prestamos/:id', verifyToken, async (req, res) => {
    const pool = await obtenerConexion();
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        const [actual] = await conn.execute('SELECT empleado_id FROM prestamos WHERE id = ? FOR UPDATE', [req.params.id]);
        if (actual.length === 0) {
            await conn.rollback();
            return res.status(404).json({ message: 'No encontrado' });
        }

        const prestamo = await leerPrestamo(conn, req.params.id);
        // No borramos el registro físicamente, solo cambiamos el estado para que no salga en la lista
        await conn.execute("UPDATE prestamos SET estado = 'anulado' WHERE id = ?", [req.params.id]);
        // Recalcula el descuento en planilla sin este préstamo (queda en 0 si no le quedan préstamos activos)
        await sincronizarConceptoPrestamo(conn, actual[0].empleado_id);

        await auditarEnTransaccion(conn, req, 'ELIMINACIÓN PRÉSTAMO', prestamo.empleado_id,
            `Se eliminó (anuló) préstamo #${prestamo.id} por ${soles(prestamo.monto_total)} con ${prestamo.entidad_financiera}`);

        await conn.commit();
        res.json({ message: 'Préstamo eliminado' });
    } catch (err) {
        if (conn) await conn.rollback().catch(() => {});
        console.error(err);
        res.status(500).json({ message: 'Error al eliminar' });
    } finally {
        if (conn) conn.release();
    }
});

// ==================== CONFIGURACIÓN DEL SISTEMA (LÓGICA BLINDADA - MAX ID) ====================

// 1. LISTAR O INICIALIZAR PARÁMETROS DEL PERIODO
app.get('/configuracion', verifyToken, async (req, res) => {
    const { periodo } = req.query;
    if (!periodo) return res.status(400).json({ message: "Falta el periodo" });

    try {
        const conn = await obtenerConexion();

        // La pantalla de planilla (?planilla=1) de un periodo cerrado usa los parámetros de su copia.
        // El mantenedor de configuración no manda planilla=1: siempre edita los valores reales.
        if (req.query.planilla === '1') {
            const copia = await copiaPlanillaSolicitada(conn, req, 'normal');
            if (copia) return res.json(copia.config);
        }
        
        // A. Intentamos buscar si YA existen datos para ESTE periodo
        const [rows] = await conn.execute(
            "SELECT * FROM parametros_sistema WHERE periodo = ? AND estado = 'activo'", 
            [periodo]
        );
        
        // B. LÓGICA DE HERENCIA INTELIGENTE: 
        // Si el mes está vacío (es nuevo), buscamos la ÚLTIMA configuración guardada en la historia.
        if (rows.length === 0) {
            console.log(`[CONFIG] Periodo ${periodo} vacío. Buscando herencia histórica...`);
            
            // === ESTA ES LA MAGIA "A PRUEBA DE BALAS" ===
            // No importa si el dato es de Enero, Febrero o del año pasado.
            // Esta consulta trae la versión más reciente (ID más alto) de cada variable.
            const sqlHerencia = `
                SELECT p1.clave, p1.valor, p1.descripcion 
                FROM parametros_sistema p1
                INNER JOIN (
                    SELECT clave, MAX(id) as max_id
                    FROM parametros_sistema
                    WHERE estado = 'activo'
                    GROUP BY clave
                ) p2 ON p1.id = p2.max_id
            `;
            
            const [baseRows] = await conn.execute(sqlHerencia);

            if (baseRows.length > 0) {
                // Insertamos los valores encontrados para el NUEVO periodo
                for (const item of baseRows) {
                    await conn.execute(
                        "INSERT INTO parametros_sistema (clave, valor, descripcion, estado, periodo) VALUES (?, ?, ?, 'activo', ?)",
                        [item.clave, item.valor, item.descripcion, periodo]
                    );
                }
                // Devolvemos los datos recién creados
                const [newRows] = await conn.execute("SELECT * FROM parametros_sistema WHERE periodo = ?", [periodo]);
                return res.json(newRows);
            }
        }
        
        res.json(rows); 
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error al obtener configuración" });
    }
});

// 2. ACTUALIZAR O CREAR CONFIGURACIÓN (POR PERIODO)
app.put('/configuracion', verifyToken, async (req, res) => {
    const { clave, valor, descripcion, periodo } = req.body;
    
    if (!periodo) return res.status(400).json({ message: "Falta el periodo" });

    // Cambio + auditoría (con el valor anterior) en la misma transacción
    const pool = await obtenerConexion();
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        // Valor ANTERIOR de este parámetro en este periodo (fila bloqueada hasta el commit)
        const [[anterior]] = await conn.execute(
            'SELECT valor, descripcion FROM parametros_sistema WHERE clave = ? AND periodo = ? FOR UPDATE', [clave, periodo]);

        // Guardamos o Actualizamos ESPECÍFICAMENTE para este mes
        const sql = `
            INSERT INTO parametros_sistema (clave, valor, descripcion, periodo, estado)
            VALUES (?, ?, ?, ?, 'activo')
            ON DUPLICATE KEY UPDATE valor = ?, descripcion = ?
        `;

        await conn.execute(sql, [clave, valor, descripcion, periodo, valor, descripcion]);

        // Ej: "Configuración UIT (2026-Septiembre): Valor: S/ 5,350.00 → S/ 5,400.00"
        const [[actual]] = await conn.execute(
            'SELECT valor, descripcion FROM parametros_sistema WHERE clave = ? AND periodo = ?', [clave, periodo]);
        const cambios = anterior
            ? resumirCambios(anterior, actual, [['valor', 'Valor', soles], ['descripcion', 'Descripción']])
            : [`Valor: (sin registro en el periodo) → ${soles(actual.valor)}`];
        await auditarEnTransaccion(conn, req, 'EDICIÓN CONFIGURACIÓN', null,
            `Configuración ${clave} (${periodo}): ${cambios.length ? cambios.join('; ') : 'sin cambios'}`);

        await conn.commit();
        res.json({ message: "Configuración guardada correctamente para este periodo." });
    } catch (error) {
        if (conn) await conn.rollback().catch(() => {});
        console.error(error);
        res.status(500).json({ message: "Error al guardar configuración" });
    } finally {
        if (conn) conn.release();
    }
});

// =======================================================
// === CIERRE / REAPERTURA DE PLANILLA (POR PERIODO) ===
// =======================================================

// 1. CONSULTAR ESTADO DE UN PERIODO
app.get('/api/planilla/estado', verifyToken, async (req, res) => {
    const { periodo } = req.query;
    if (!periodo) return res.status(400).json({ message: 'Falta el periodo.' });

    try {
        const conn = await obtenerConexion();
        const [rows] = await conn.execute('SELECT * FROM planilla_cierre WHERE periodo = ?', [periodo]);

        // Copia estática del último cierre (la pantalla se dibuja desde ella)
        const [copias] = await conn.execute(
            `SELECT version, creado_por, DATE_FORMAT(fecha_creacion, '%Y-%m-%d %H:%i') AS fecha
             FROM planilla_snapshots WHERE periodo = ? ORDER BY version DESC LIMIT 1`, [periodo]);
        const copia = copias[0] || null;

        if (rows.length === 0) {
            return res.json({ periodo, cerrado: false, copia });
        }

        const row = rows[0];
        const [sistemaRows] = await conn.execute("SELECT valor FROM configuracion_sistema WHERE clave = 'sistema_bloqueado'");
        const sistemaBloqueado = sistemaRows.length > 0 && sistemaRows[0].valor === '1';

        res.json({
            periodo,
            cerrado: row.estado === 'cerrado' || sistemaBloqueado,
            bloqueado: sistemaBloqueado,
            cerrado_por: row.cerrado_por,
            fecha_cierre: row.fecha_cierre,
            copia
        });
    } catch (err) {
        console.error('Error en GET /api/planilla/estado:', err);
        res.status(500).json({ message: 'Error al consultar el estado de la planilla.' });
    }
});

// 2. CERRAR PLANILLA (BLOQUEA TODO EL SISTEMA)
const CONTRASENA_ACTIVAR_PLANILLA = '123456';

app.post('/api/planilla/cerrar', verifyToken, async (req, res) => {
    const { periodo } = req.body;
    if (!periodo) return res.status(400).json({ message: 'Falta el periodo.' });
    if (!convertirPeriodoAFecha(periodo)) return res.status(400).json({ message: `Periodo no reconocido: ${periodo}` });

    // Todo o nada: cierre + copia estática + bloqueo + auditoría
    const pool = await obtenerConexion();
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();
        const usuario = req.authData?.user?.username || 'sistema';

        await conn.execute(
            `INSERT INTO planilla_cierre (periodo, estado, cerrado_por, fecha_cierre)
             VALUES (?, 'cerrado', ?, NOW())
             ON DUPLICATE KEY UPDATE estado = 'cerrado', cerrado_por = ?, fecha_cierre = NOW(),
                                     reabierto_por = NULL, fecha_reapertura = NULL`,
            [periodo, usuario, usuario]
        );

        const copia = await guardarCopiaPlanilla(conn, periodo, usuario);

        await conn.execute(
            `REPLACE INTO configuracion_sistema (clave, valor, fecha_actualizacion) VALUES ('sistema_bloqueado', '1', NOW())`
        );

        await auditarEnTransaccion(conn, req, 'CIERRE_PLANILLA', null,
            `Cerró la planilla del periodo ${periodo} y bloqueó todo el sistema. Copia estática v${copia.version} (${copia.trabajadores} trabajadores)`);

        await conn.commit();
        res.json({ message: `Planilla de ${periodo} cerrada y guardada (copia v${copia.version}). Todo el sistema quedó bloqueado hasta que se active con la contraseña.` });
    } catch (err) {
        if (conn) await conn.rollback().catch(() => {});
        console.error('Error en POST /api/planilla/cerrar:', err);
        res.status(500).json({ message: 'Error al cerrar la planilla. No se cerró ni se guardó la copia.' });
    } finally {
        if (conn) conn.release();
    }
});

// 3. ACTIVAR PLANILLA (REQUIERE CONTRASEÑA, DESBLOQUEA TODO EL SISTEMA)
app.post('/api/planilla/reabrir', verifyToken, async (req, res) => {
    const { periodo, password } = req.body;
    if (!periodo) return res.status(400).json({ message: 'Falta el periodo.' });

    if (password !== CONTRASENA_ACTIVAR_PLANILLA) {
        return res.status(401).json({ message: 'Contraseña incorrecta.' });
    }

    try {
        const conn = await obtenerConexion();
        const usuario = req.authData?.user?.username || 'sistema';

        await conn.execute(
            `UPDATE planilla_cierre SET estado = 'abierto', reabierto_por = ?, fecha_reapertura = NOW()
             WHERE periodo = ?`,
            [usuario, periodo]
        );

        await conn.execute(
            `REPLACE INTO configuracion_sistema (clave, valor, fecha_actualizacion) VALUES ('sistema_bloqueado', '0', NOW())`
        );

        await registrarAuditoria(usuario, 'REAPERTURA_PLANILLA', null, req.ip, `Activó la planilla del periodo ${periodo} y desbloqueó todo el sistema`);

        res.json({ message: `Planilla de ${periodo} activada. El sistema quedó desbloqueado.` });
    } catch (err) {
        console.error('Error en POST /api/planilla/reabrir:', err);
        res.status(500).json({ message: 'Error al activar la planilla.' });
    }
});

// =======================================================
// === MANTENIMIENTO DE SINDICATOS (CON MONTO) ===
// =======================================================

// 1. LISTAR
app.get('/sindicatos', verifyToken, async (req, res) => {
    try {
        const conn = await obtenerConexion();
        const [rows] = await conn.query("SELECT * FROM sindicatos WHERE estado = 'activo' ORDER BY descripcion ASC");
        res.json(rows);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// 2. CREAR
app.post('/sindicatos', verifyToken, async (req, res) => {
    const { descripcion, monto } = req.body; // <--- Recibimos el monto
    try {
        const conn = await obtenerConexion();
        await conn.query("INSERT INTO sindicatos (descripcion, monto) VALUES (?, ?)", [descripcion.toUpperCase(), monto || 0]);
        
        const usuario = req.authData?.user?.username || 'sistema';
        await registrarAuditoria(usuario, 'CREACIÓN SINDICATO', null, req.ip, `Creó sindicato: ${descripcion} (S/ ${monto})`);
        
        res.json({ message: 'Sindicato creado' });
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// Empleados con afiliación activa a un sindicato (bloqueados para la transacción en curso)
async function afiliadosActivosDeSindicato(conn, sindicatoId) {
    const [rows] = await conn.execute(
        "SELECT DISTINCT empleado_id FROM asignacion_sindicatos WHERE sindicato_id = ? AND estado = 'activo' FOR UPDATE", [sindicatoId]);
    return rows.map(r => r.empleado_id);
}

// 3. EDITAR + la nueva cuota pasa a los afiliados activos y a su planilla (empleado_conceptos)
app.put('/sindicatos/:id', verifyToken, async (req, res) => {
    const { id } = req.params;
    const { descripcion, monto } = req.body; // <--- Recibimos el monto

    const pool = await obtenerConexion();
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        const [result] = await conn.execute("UPDATE sindicatos SET descripcion = ?, monto = ? WHERE id = ?", [descripcion.toUpperCase(), monto || 0, id]);
        if (result.affectedRows === 0) {
            await conn.rollback();
            return res.status(404).json({ message: 'Sindicato no encontrado' });
        }

        const empleados = await afiliadosActivosDeSindicato(conn, id);
        await conn.execute(
            "UPDATE asignacion_sindicatos SET descripcion = ?, monto = ? WHERE sindicato_id = ? AND estado = 'activo'",
            [descripcion.toUpperCase(), monto || 0, id]);
        for (const empleadoId of empleados) await sincronizarConceptoSindicato(conn, empleadoId);

        await conn.commit();

        const usuario = req.authData?.user?.username || 'sistema';
        await registrarAuditoria(usuario, 'EDICIÓN SINDICATO', null, req.ip, `Editó sindicato ID ${id}: ${descripcion} - S/ ${monto} (${empleados.length} afiliados actualizados)`);

        res.json({ message: 'Sindicato actualizado' });
    } catch (err) {
        if (conn) await conn.rollback().catch(() => {});
        console.error(err);
        res.status(500).json({ message: err.message });
    } finally {
        if (conn) conn.release();
    }
});

// 4. ELIMINAR (Soft Delete) + desafilia a sus trabajadores y deja su cuota en planilla en 0
app.delete('/sindicatos/:id', verifyToken, async (req, res) => {
    const { id } = req.params;

    const pool = await obtenerConexion();
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        await conn.execute("UPDATE sindicatos SET estado = 'inactivo' WHERE id = ?", [id]);

        const empleados = await afiliadosActivosDeSindicato(conn, id);
        await conn.execute("UPDATE asignacion_sindicatos SET estado = 'inactivo' WHERE sindicato_id = ? AND estado = 'activo'", [id]);
        for (const empleadoId of empleados) await sincronizarConceptoSindicato(conn, empleadoId);

        await conn.commit();

        const usuario = req.authData?.user?.username || 'sistema';
        await registrarAuditoria(usuario, 'ELIMINACIÓN SINDICATO', null, req.ip, `Eliminó sindicato ID ${id} (${empleados.length} afiliados desafiliados)`);

        res.json({ message: 'Sindicato eliminado' });
    } catch (err) {
        if (conn) await conn.rollback().catch(() => {});
        console.error(err);
        res.status(500).json({ message: err.message });
    } finally {
        if (conn) conn.release();
    }
});

// ==================== GESTIÓN DE USUARIOS (ADMIN) ====================

// 1. Obtener todos los usuarios registrados
app.get('/api/usuarios', verifyToken, async (req, res) => {
    try {
        const conn = await obtenerConexion();
        const [rows] = await conn.execute('SELECT id, nombre_completo, correo, rol, estado FROM usuarios');
        res.json(rows);
    } catch (err) {
        console.error('Error al obtener usuarios:', err);
        res.status(500).json({ message: 'Error interno al cargar los usuarios.' });
    }
});

// 2. Crear un nuevo usuario
app.post('/api/usuarios', verifyToken, async (req, res) => {
    const { nombre_completo, correo, password, rol } = req.body;
    try {
        const conn = await obtenerConexion();
        
        // Verificar si el correo ya existe
        const [existente] = await conn.execute('SELECT id FROM usuarios WHERE correo = ?', [correo]);
        if (existente.length > 0) {
            return res.status(400).json({ message: 'Este correo electrónico ya está registrado.' });
        }

        // Encriptar la contraseña
        const hash = await bcrypt.hash(password, 10);
        
        // CORRECCIÓN: Toma la primera palabra del Nombre Completo (Ej: "Juan Pérez" -> "Juan")
        const username = nombre_completo.split(' ')[0];

        await conn.execute(
            'INSERT INTO usuarios (nombre_completo, correo, username, password, rol, estado) VALUES (?, ?, ?, ?, ?, ?)',
            [nombre_completo, correo, username, hash, rol, 'Activo']
        );
        res.json({ message: 'Usuario creado exitosamente.' });
    } catch (err) {
        console.error('Error al crear usuario:', err);
        res.status(500).json({ message: 'Error interno al registrar el usuario.' });
    }
});

// 3. Cambiar estado de usuario (Activo / Inactivo)
app.put('/api/usuarios/:id/estado', verifyToken, async (req, res) => {
    const { id } = req.params;
    const { estado } = req.body; // 'Activo' o 'Inactivo'
    try {
        const conn = await obtenerConexion();
        await conn.execute('UPDATE usuarios SET estado = ? WHERE id = ?', [estado, id]);
        res.json({ message: `El usuario ahora está ${estado}.` });
    } catch (err) {
        console.error('Error al cambiar estado:', err);
        res.status(500).json({ message: 'Error interno al actualizar el estado.' });
    }
});

// =======================================================
// === MÓDULO FINAL: ASIGNACIÓN SINDICAL (CORREGIDO) ===
// =======================================================

// 1. OBTENER EL MONTO DESDE LA TABLA 'SINDICATOS' (Lo que pediste)
app.get('/api/obtener-monto-sindicato', verifyToken, async (req, res) => {
    try {
        const conn = await obtenerConexion();
        // Vamos directo a tu tabla de mantenimiento sindical
        const sql = "SELECT monto FROM sindicatos WHERE estado = 'activo' ORDER BY id DESC LIMIT 1"; 
        
        const [rows] = await conn.execute(sql);
        
        if (rows.length > 0) {
            res.json({ monto: rows[0].monto });
        } else {
            res.json({ monto: 0.00 }); // Si no hay sindicatos creados
        }
    } catch (err) {
        console.error("Error obteniendo monto:", err);
        res.status(500).json({ message: 'Error al obtener monto' });
    }
});

// 2. BUSCADOR BLINDADO (Arreglado para Nombres/Apellidos nulos)
app.get('/api/buscar-trabajador-final', verifyToken, async (req, res) => {
    const { q } = req.query; 

    if (!q || q.trim().length === 0) return res.json([]);

    try {
        const conn = await obtenerConexion();
        const busqueda = `%${q}%`;

        // CORRECCIÓN CLAVE: 
        // 1. Usamos IFNULL en el SELECT para que 'nombre_completo' nunca llegue vacío.
        // 2. Usamos CONCAT en el WHERE manejando nulos para que encuentre por nombre completo.
        const sql = `
            SELECT 
                e.id, 
                p.dni, 
                CONCAT(p.apellido_paterno, ' ', IFNULL(p.apellido_materno, ''), ', ', p.nombre) as nombre_completo
            FROM empleados e
            INNER JOIN personas p ON e.persona_id = p.id
            WHERE p.estado = 'activo' 
            AND (
                p.dni LIKE ? OR 
                p.nombre LIKE ? OR 
                p.apellido_paterno LIKE ? OR 
                CONCAT(p.apellido_paterno, ' ', IFNULL(p.apellido_materno, ''), ' ', p.nombre) LIKE ?
            )
            LIMIT 5
        `;

        const [rows] = await conn.execute(sql, [busqueda, busqueda, busqueda, busqueda]);
        res.json(rows);
    } catch (err) {
        console.error("Error en búsqueda:", err);
        res.status(500).json({ message: 'Error buscando trabajador' });
    }
});

// 3. GUARDAR (Usa el monto que sacamos de Sindicatos y lo pone en la planilla)
app.post('/api/guardar-asignacion-final', verifyToken, async (req, res) => {
    const { trabajadores, monto, descripcion, sindicato_id } = req.body; 

    if (!trabajadores || trabajadores.length === 0) return res.status(400).json({ message: 'Falta trabajador.' });
    
    // Convertir monto a número para evitar errores
    const montoNum = parseFloat(monto);
    if (!sindicato_id || isNaN(montoNum) || montoNum < 0) return res.status(400).json({ message: 'Sindicato o monto inválido.' });

    // Todo o nada: si un trabajador falla, no queda ninguno a medio asignar
    const pool = await obtenerConexion();
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        for (const empleadoId of trabajadores) {

            // --- PARTE A: GUARDAR EN LA LISTA VISUAL (asignacion_sindicatos) ---
            const [existeVisual] = await conn.execute("SELECT id FROM asignacion_sindicatos WHERE empleado_id = ? AND estado = 'activo' FOR UPDATE", [empleadoId]);

            if (existeVisual.length > 0) {
                await conn.execute(
                    "UPDATE asignacion_sindicatos SET sindicato_id=?, descripcion=?, monto=?, estado='activo' WHERE id=?",
                    [sindicato_id, descripcion, montoNum, existeVisual[0].id]
                );
            } else {
                await conn.execute(
                    "INSERT INTO asignacion_sindicatos (empleado_id, sindicato_id, descripcion, monto, estado, created_at) VALUES (?, ?, ?, ?, 'activo', NOW())",
                    [empleadoId, sindicato_id, descripcion, montoNum]
                );
            }

            // --- PARTE B: 'CUOTA SINDICAL' del régimen del trabajador en empleado_conceptos (botón $) ---
            const conceptoId = await sincronizarConceptoSindicato(conn, empleadoId);
            if (!conceptoId) {
                await conn.rollback();
                return res.status(400).json({ message: `No existe un concepto 'CUOTA SINDICAL' activo para el régimen del trabajador (ID ${empleadoId}).` });
            }
        }

        await conn.commit();
        res.json({ message: 'Afiliación guardada y concepto asignado al trabajador.' });

    } catch (err) {
        if (conn) await conn.rollback().catch(() => {});
        console.error(err);
        res.status(500).json({ message: 'Error al guardar.' });
    } finally {
        if (conn) conn.release();
    }
});
// 4. LISTAR AFILIADOS (Para que aparezcan en la tabla principal)
app.get('/api/listar-afiliados-sindicato', verifyToken, async (req, res) => {
    try {
        const conn = await obtenerConexion();
        
        const sql = `
            SELECT 
                ads.id AS id_afiliacion,
                p.dni,
                CONCAT(p.apellido_paterno, ' ', p.apellido_materno, ', ', p.nombre) as nombre_completo,
                ads.descripcion,  -- Tu campo descripcion
                ads.monto
            FROM asignacion_sindicatos ads
            INNER JOIN empleados e ON ads.empleado_id = e.id
            INNER JOIN personas p ON e.persona_id = p.id
            WHERE ads.estado = 'activo'
            ORDER BY p.apellido_paterno ASC
        `;

        const [rows] = await conn.execute(sql);
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error al listar afiliados' });
    }
});

// 5. ELIMINAR AFILIACIÓN (Soft Delete) + la cuota sindical en planilla queda en 0
app.delete('/api/eliminar-afiliacion/:id', verifyToken, async (req, res) => {
    const { id } = req.params; // Este es el ID de la tabla 'asignacion_sindicatos'

    const pool = await obtenerConexion();
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        const [registro] = await conn.execute("SELECT empleado_id FROM asignacion_sindicatos WHERE id = ? FOR UPDATE", [id]);
        if (registro.length === 0) {
            await conn.rollback();
            return res.status(404).json({ message: 'Registro no encontrado.' });
        }

        await conn.execute("UPDATE asignacion_sindicatos SET estado = 'inactivo' WHERE id = ?", [id]);
        // Sin afiliación activa el total es 0: el concepto se conserva en el botón $ pero ya no descuenta
        await sincronizarConceptoSindicato(conn, registro[0].empleado_id);

        await conn.commit();
        res.json({ message: 'Trabajador desafiliado y cuota sindical en planilla puesta en 0.' });

    } catch (err) {
        if (conn) await conn.rollback().catch(() => {});
        console.error(err);
        res.status(500).json({ message: 'Error al eliminar.' });
    } finally {
        if (conn) conn.release();
    }
});
// ==================== INICIO DEL SERVIDOR ====================
app.listen(port, async () => {
    try {
        await obtenerConexion();
        console.log(`Servidor Node.js corriendo en http://localhost:${port}`);
    } catch (err) {
        console.error('El servidor no pudo arrancar debido a un error de base de datos.');
    }
});