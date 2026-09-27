// =======================================================
// === DÍAS COMPUTABLES DEL TRABAJADOR EN EL MES DE PLANILLA ===
// =======================================================
// Regla (mes comercial):
//  - Si el trabajador cubre el mes completo  -> DIVISOR (30) días, aunque el mes tenga 28 o 31.
//  - Si ingresa o cesa dentro del mes        -> días calendario realmente laborados, tope DIVISOR.
//    El día de la baja SÍ se cuenta como laborado (igual que el filtro de /empleados).
// Ej. septiembre 2026: baja 2026-09-15 -> 15 días; ingreso 2026-09-20 -> 11 días.
//
// Un trabajador puede tener VARIOS TRAMOS en el mismo mes (baja el 24 y reincorporación el 25).
// Los tramos vienen de la tabla empleado_tramos (ver migraciones/001_empleado_tramos.js).

const DIVISOR_DIAS = 30;

function parseFecha(str) {
    if (!str || str === '0000-00-00' || str === '-') return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(str));
    if (!m) return null;
    return { anio: +m[1], mes: +m[2], dia: +m[3], clave: +m[1] * 10000 + +m[2] * 100 + +m[3] };
}

// tramos: [{ ingreso: 'YYYY-MM-DD'|null, baja: 'YYYY-MM-DD'|null }]  (null = sin límite)
// fechaInicioPeriodo: 'YYYY-MM-01' (lo que devuelve convertirPeriodoAFecha)
function calcularDiasComputablesTramos(tramos, fechaInicioPeriodo, divisor = DIVISOR_DIAS) {
    const periodo = parseFecha(fechaInicioPeriodo);
    if (!periodo) return { dias: divisor, intervalos: [] };

    const ultimoDiaMes = new Date(periodo.anio, periodo.mes, 0).getDate();
    const claveInicioMes = periodo.anio * 10000 + periodo.mes * 100 + 1;
    const claveFinMes = periodo.anio * 10000 + periodo.mes * 100 + ultimoDiaMes;

    // 1. Recortar cada tramo al mes -> intervalos [diaInicio, diaFin]
    const intervalos = [];
    for (const t of tramos) {
        const ingreso = parseFecha(t.ingreso);
        const baja = parseFecha(t.baja);
        if (ingreso && ingreso.clave > claveFinMes) continue;   // empieza después del mes
        if (baja && baja.clave < claveInicioMes) continue;      // terminó antes del mes
        if (ingreso && baja && baja.clave < ingreso.clave) continue; // tramo inválido
        const ini = ingreso && ingreso.clave >= claveInicioMes ? ingreso.dia : 1;
        const fin = baja && baja.clave <= claveFinMes ? baja.dia : ultimoDiaMes;
        intervalos.push([ini, fin]);
    }
    if (!intervalos.length) return { dias: 0, intervalos: [] };

    // 2. Unir solapados/contiguos (un día no se paga dos veces; 1-24 + 25-30 = 1-30)
    intervalos.sort((a, b) => a[0] - b[0]);
    const unidos = [intervalos[0].slice()];
    for (const [ini, fin] of intervalos.slice(1)) {
        const ultimo = unidos[unidos.length - 1];
        if (ini <= ultimo[1] + 1) ultimo[1] = Math.max(ultimo[1], fin);
        else unidos.push([ini, fin]);
    }

    // 3. Mes cubierto de punta a punta -> 30; si no, suma de días calendario (tope 30)
    if (unidos.length === 1 && unidos[0][0] === 1 && unidos[0][1] === ultimoDiaMes) return { dias: divisor, intervalos: unidos };
    const suma = unidos.reduce((s, [ini, fin]) => s + (fin - ini + 1), 0);
    return { dias: Math.min(divisor, suma), intervalos: unidos };
}

// Compatibilidad / pruebas: un solo tramo
function calcularDiasComputables(fechaIngreso, fechaBaja, fechaInicioPeriodo, divisor = DIVISOR_DIAS) {
    return calcularDiasMes([{ ingreso: fechaIngreso, baja: fechaBaja }], fechaInicioPeriodo, divisor);
}

// tramos: TODOS los tramos del empleado (tabla empleado_tramos), en cualquier orden.
// El tramo "actual" es el de ingreso más reciente (un ingreso NULL es el más antiguo).
function ordenarTramos(tramos) {
    const clave = (t) => (parseFecha(t.ingreso) || { clave: 0 }).clave;
    return [...(tramos || [])].sort((a, b) => clave(a) - clave(b));
}

function calcularDiasMes(tramos, fechaInicioPeriodo, divisor = DIVISOR_DIAS) {
    const ordenados = ordenarTramos(tramos);
    const actual = ordenados[ordenados.length - 1] || { ingreso: null, baja: null };
    const anteriores = ordenados.slice(0, -1);

    const periodo = parseFecha(fechaInicioPeriodo);
    const { dias, intervalos } = calcularDiasComputablesTramos(ordenados, fechaInicioPeriodo, divisor);

    let ingresoEnMes = false, ceseEnMes = false, bajasPreviasEnMes = [];
    if (periodo) {
        const enMes = (f) => { const p = parseFecha(f); return !!p && p.anio === periodo.anio && p.mes === periodo.mes; };
        ingresoEnMes = enMes(actual.ingreso);
        ceseEnMes = enMes(actual.baja);
        // Bajas de tramos anteriores dentro de este mes (ej. la baja del 24 antes del reingreso del 25)
        bajasPreviasEnMes = anteriores.map(t => t.baja).filter(enMes).sort();
    }
    return {
        dias, intervalos,
        fecha_ingreso_actual: actual.ingreso || null,
        fecha_baja_actual: actual.baja || null,
        ingreso_en_mes: ingresoEnMes,
        cese_en_mes: ceseEnMes,
        // Su ingreso de este mes es un reingreso (tiene tramos anteriores), no una contratación nueva
        reincorporado_en_mes: ingresoEnMes && anteriores.length > 0,
        bajas_previas_en_mes: bajasPreviasEnMes
    };
}

module.exports = { calcularDiasComputables, calcularDiasComputablesTramos, calcularDiasMes, DIVISOR_DIAS };
