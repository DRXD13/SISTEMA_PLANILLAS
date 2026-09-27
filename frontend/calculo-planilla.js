// =======================================================
// === CÁLCULO DE PLANILLA - VERSIÓN "INTELIGENTE" ===
// =======================================================

const API_URL = ''; 
const tokenPlanilla = localStorage.getItem('token');
const periodoPlanilla = localStorage.getItem('periodo');

// DETECTAR PÁGINA
const esPaginaReincorporados = window.location.pathname.includes('reincorporados') || window.location.href.includes('reincorporados');
const TIPO_SOLICITUD = esPaginaReincorporados ? 'reincorporada' : 'normal';

// CONFIGURACIÓN INICIAL (VACÍA)
let CONFIG_GLOBAL = { uit: 0, divisor_dias: 30, tasa_essalud: 0.09, rmv: 0 };

let FILTRO_ACTUAL_TIPO = 'TODOS';
let FILTRO_ACTUAL_SUBTIPO = '';

let table, chart;
let EMPLEADOS_DB = [];
let PLANILLA_CALCULADA = [];
let PLANILLA_CERRADA = false;
// Columnas de conceptos (Mantenimiento -> Conceptos): [{ columna, grupo: INGRESO|DESCUENTO|APORTE, orden, clave }]
let COLUMNAS_PLANILLA = [];
let INFO_CIERRE = null;
// Un periodo cerrado se dibuja desde la COPIA guardada al cerrarlo (planilla_snapshots).
// ?en_vivo=1 muestra los datos actuales de las tablas, sin tocar la copia.
const VER_EN_VIVO = new URLSearchParams(window.location.search).get('en_vivo') === '1';
const PARAM_EN_VIVO = VER_EN_VIVO ? '&en_vivo=1' : '';

document.addEventListener('DOMContentLoaded', async () => {
    if (!tokenPlanilla || !periodoPlanilla) return;

    // Títulos
    if(esPaginaReincorporados) {
        const headerTitulo = document.getElementById('header-titulo');
        if(headerTitulo) headerTitulo.textContent = "PLANILLA REINCORPORADOS";
        const labelTipo = document.getElementById('label-tipo-planilla');
        if(labelTipo) labelTipo.textContent = "(RÉGIMEN REINCORPORADOS)";
    }

    // 0. Las columnas de conceptos salen de la BD, no del código: sin ellas no se calcula nada
    const hayColumnas = await cargarColumnasPlanilla();
    if (!hayColumnas) return;

    initTable();
    initChart();

    // 1. PRIMERO: Cargamos la configuración (UIT/RMV)
    await cargarConfiguracionDelPeriodo();

    // 1.5 Verificamos si el periodo está cerrado (y recién ahí dibujamos los botones)
    await verificarEstadoPlanilla();

    // 2. SEGUNDO: Cargamos datos y CALCULAMOS automáticamente
    await cargarDatosReales();
});

// === 0. COLUMNAS DINÁMICAS (conceptos activos y vigentes en el periodo) ===
// El orden de las columnas de INGRESO es también el orden en que se suman.
async function cargarColumnasPlanilla() {
    try {
        const res = await fetch(`${API_URL}/planilla/columnas?periodo=${encodeURIComponent(periodoPlanilla)}${PARAM_EN_VIVO}&t=${Date.now()}`, { headers: { 'Authorization': `Bearer ${tokenPlanilla}` } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const filas = await res.json();
        const prefijo = { INGRESO: 'ING', DESCUENTO: 'DSC', APORTE: 'APO' };
        const contador = { INGRESO: 0, DESCUENTO: 0, APORTE: 0 };
        COLUMNAS_PLANILLA = filas.map(f => ({ ...f, clave: `${prefijo[f.grupo]}_${contador[f.grupo]++}` }));
        return true;
    } catch (e) {
        console.error('Error cargando columnas de la planilla:', e);
        Swal.fire('Error', 'No se pudieron cargar los conceptos de la planilla. No se calculará nada hasta resolverlo.', 'error');
        return false;
    }
}
const columnasDe = (grupo) => COLUMNAS_PLANILLA.filter(c => c.grupo === grupo);

// === 1. CARGA DE CONFIGURACIÓN (CON TIMESTAMP ANTI-CACHÉ) ===
async function cargarConfiguracionDelPeriodo() {
    try {
        const timestamp = Date.now(); // Truco para evitar caché del navegador
        const res = await fetch(`${API_URL}/configuracion?periodo=${encodeURIComponent(periodoPlanilla)}&planilla=1${PARAM_EN_VIVO}&t=${timestamp}`, { 
            headers: {'Authorization':`Bearer ${tokenPlanilla}`} 
        });
        
        if(!res.ok) throw new Error("Error config");
        const data = await res.json();
        
        const uitItem = data.find(x => x.clave === 'UIT');
        const rmvItem = data.find(x => x.clave === 'RMV' || x.clave === 'SUELDO_MINIMO');
        
        if (uitItem) CONFIG_GLOBAL.uit = parseFloat(uitItem.valor);
        if (rmvItem) CONFIG_GLOBAL.rmv = parseFloat(rmvItem.valor);

        // INDICADOR VISUAL: Actualizamos el título para que veas qué UIT se usa
        const lblPeriodo = document.getElementById('periodo-actual');
        if(lblPeriodo) {
            lblPeriodo.innerHTML = `${periodoPlanilla} <span class="bg-yellow-400 text-black px-2 py-0.5 rounded ml-2 text-xs font-bold">UIT: S/ ${CONFIG_GLOBAL.uit}</span>`;
            if (INFO_CIERRE) inyectarBotones();   // el innerHTML borró los avisos de bloqueo / copia
        }

        console.log(`[CONFIG] UIT: ${CONFIG_GLOBAL.uit} | RMV: ${CONFIG_GLOBAL.rmv}`);

    } catch (e) { console.error("Error config:", e); }
}

// === 2. BOTÓN DE INGRESO (RECARGA COMPLETA) ===
window.ingresarAlSistema = async function() {
    const btn = document.querySelector('button[onclick="ingresarAlSistema()"]');
    if(btn) btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Procesando...';

    // 1. Recargar Configuración (Por seguridad)
    await cargarConfiguracionDelPeriodo();

    // 2. Aplicar Filtros
    FILTRO_ACTUAL_TIPO = document.getElementById('inicio-tipo').value;
    FILTRO_ACTUAL_SUBTIPO = document.getElementById('inicio-subtipo').value;
    
    // 3. Ocultar Modal y Recalcular
    const modal = document.getElementById('modal-inicio');
    modal.style.opacity = '0';
    setTimeout(() => { 
        modal.classList.add('hidden'); 
        recalcularPlanilla(); // <--- AQUÍ SE APLICA LA FÓRMULA
        if(btn) btn.innerHTML = '<span>INGRESAR AL SISTEMA</span> <i class="fas fa-arrow-right"></i>';
    }, 300);
}

// === 3. CARGA DE DATOS (AHORA INCLUYE RECÁLCULO) ===
async function cargarDatosReales() {
    // Si se llama desde el botón "Recalcular", mostramos loading
    if(table) table.setData([]); 

    try {
        // 1. Aseguramos config fresca antes de traer datos
        if(CONFIG_GLOBAL.uit === 0) await cargarConfiguracionDelPeriodo();

        const res = await fetch(`${API_URL}/planilla/datos-maqueta?periodo=${encodeURIComponent(periodoPlanilla)}&tipo_planilla=${TIPO_SOLICITUD}${PARAM_EN_VIVO}`, { 
            headers: {'Authorization':`Bearer ${tokenPlanilla}`} 
        });
        
        if(!res.ok) throw new Error("Error datos");
        EMPLEADOS_DB = await res.json();
        
        if(EMPLEADOS_DB.length === 0) {
            Swal.fire("Vacío", "No hay trabajadores para procesar.", "info");
        }

        llenarCombosDinamicos(); 
        
        // ¡LA CLAVE! Ejecutamos el cálculo inmediatamente después de cargar
        recalcularPlanilla(); 
        
        const Toast = Swal.mixin({ toast: true, position: 'top-end', showConfirmButton: false, timer: 2000 });
        Toast.fire({ icon: 'success', title: 'Planilla Recalculada' });

    } catch (e) { console.error(e); }
}

// ... (Las funciones llenarCombosDinamicos y actualizarComboSubtipos se quedan igual) ...
function llenarCombosDinamicos() {
    const tipos = [...new Set(EMPLEADOS_DB.map(e => (e.tipo_contrato||'').toUpperCase().trim()))].filter(x=>x);
    const selT = document.getElementById('inicio-tipo');
    if(selT) { 
        const valorPrevio = selT.value;
        selT.innerHTML='<option value="TODOS">-- TODOS --</option>'; 
        tipos.sort().forEach(t => { 
            const o = document.createElement('option'); o.value = t; o.textContent = t; selT.appendChild(o); 
        });
        if(tipos.includes(valorPrevio)) selT.value = valorPrevio;
        selT.onchange = function() { actualizarComboSubtipos(); };
        actualizarComboSubtipos();
    }
}
function actualizarComboSubtipos() {
    const selT = document.getElementById('inicio-tipo');
    const selS = document.getElementById('inicio-subtipo');
    if (!selT || !selS) return;
    const tipoSeleccionado = selT.value; 
    let empleadosFiltrados = EMPLEADOS_DB;
    if (tipoSeleccionado !== 'TODOS') {
        empleadosFiltrados = EMPLEADOS_DB.filter(e => (e.tipo_contrato || '').toUpperCase().trim() === tipoSeleccionado);
    }
    const subtipos = [...new Set(empleadosFiltrados.map(e => (e.subtipo || '').toUpperCase().trim()))].filter(x => x && x !== '-' && x !== 'NULL');
    selS.innerHTML = '<option value="">(Opcional) TODOS</option>';
    subtipos.sort().forEach(s => { const o = document.createElement('option'); o.value = s; o.textContent = s; selS.appendChild(o); });
}

// === ESTADO DEL TRABAJADOR EN EL MES (pantalla + Excel) ===
// tipo: 'cese' | 'reincorporado' | 'ingreso' | 'normal' (se usa para el color)
function ddmm(fecha) { return fecha ? `${fecha.slice(8, 10)}/${fecha.slice(5, 7)}` : ''; }
function estadoPlanilla(emp) {
    const partes = [];
    let tipo = 'normal';
    // Baja de un tramo anterior dentro de este mes (ej. BAJA 24/09 - REINCORPORADO 25/09)
    (emp.bajas_previas_en_mes || []).forEach(f => partes.push(`BAJA ${ddmm(f)}`));
    if (emp.reincorporado_en_mes) { partes.push(`REINCORPORADO ${ddmm(emp.fecha_raw)}`); tipo = 'reincorporado'; }
    else if (emp.ingreso_en_mes) { partes.push(`INGRESO ${ddmm(emp.fecha_raw)}`); tipo = 'ingreso'; }
    if (emp.cese_en_mes) { partes.push(`CESE ${ddmm(emp.fecha_baja)}`); tipo = 'cese'; }
    if (tipo === 'normal' && partes.length) tipo = 'cese';   // solo baja previa (reingreso en un mes posterior)
    const texto = partes.length ? partes.join(' - ') : (emp.estado_asistencia || 'ACTIVO');
    return { texto, tipo };
}

// === 4. FÓRMULA MAESTRA (RECALCULAR PLANILLA) ===
function recalcularPlanilla() {
    const tipo = FILTRO_ACTUAL_TIPO;
    const subtipo = FILTRO_ACTUAL_SUBTIPO;

    console.log(`[CÁLCULO] Ejecutando... UIT: ${CONFIG_GLOBAL.uit}`);

    const empleadosFiltrados = EMPLEADOS_DB.filter(emp => {
        let pT = tipo === 'TODOS' || (emp.tipo_contrato || '').toUpperCase() === tipo;
        let pS = subtipo === '' || (emp.subtipo || '').toUpperCase().trim() === subtipo;
        return pT && pS;
    });

    const datosProcesados = empleadosFiltrados.map((emp) => {
        let edad = 0; if (emp.fecha_nacimiento) { const hoy = new Date(); const cumple = new Date(emp.fecha_nacimiento); edad = hoy.getFullYear() - cumple.getFullYear(); const m = hoy.getMonth() - cumple.getMonth(); if (m < 0 || (m === 0 && hoy.getDate() < cumple.getDate())) { edad--; } }

        // --- PRORRATEO POR DÍAS COMPUTABLES (cese / ingreso a mitad de mes) ---
        // El backend calcula dias_computables con fecha_ingreso y fecha_baja (30 = mes completo).
        // Cada concepto mensual se paga en proporción: monto * dias_computables / 30.
        const divisor = CONFIG_GLOBAL.divisor_dias;
        const diasComputablesRaw = parseFloat(emp.dias_computables);
        const diasComputables = Number.isFinite(diasComputablesRaw) ? Math.min(Math.max(diasComputablesRaw, 0), divisor) : divisor;
        const factorDias = diasComputables / divisor;
        // Mes completo: se deja el monto tal cual (sin redondeo) para no alterar la planilla de quien no cesa.
        const prorratear = (monto) => factorDias === 1 ? (parseFloat(monto) || 0) : Math.round((parseFloat(monto) || 0) * factorDias * 100) / 100;

        // --- INGRESOS DINÁMICOS: una columna por concepto activo (Mantenimiento -> Conceptos) ---
        // emp.ingresos = { 'REM. BÁSICA': 50, 'DS 320-2022': 220.32, ... } (mes completo, por columna).
        // Se recorren EN EL ORDEN del catálogo: la suma queda idéntica a la de la fórmula anterior.
        const ingresosMes = emp.ingresos || {};
        const colsIngreso = columnasDe('INGRESO').map(c => c.columna);
        Object.keys(ingresosMes).filter(k => !colsIngreso.includes(k)).forEach(k => {
            console.warn(`[PLANILLA] Columna de ingreso "${k}" no está en el catálogo: se agrega al final.`); colsIngreso.push(k);
        });
        // Montos mensuales completos (sirven para valorizar el día de falta y para la proyección de renta)
        const ingresosMensualesCompletos = colsIngreso.reduce((s, col) => s + (parseFloat(ingresosMes[col]) || 0), 0);
        // Montos del periodo (prorrateados)
        const ingresosPeriodo = {};
        colsIngreso.forEach(col => { ingresosPeriodo[col] = prorratear(ingresosMes[col]); });
        const ingresosSinAsistencia = colsIngreso.reduce((s, col) => s + ingresosPeriodo[col], 0);

        // Descuentos fijos y aportes fijos dinámicos (monto del concepto, no se prorratean)
        const montosPorColumna = (grupo, origen) => columnasDe(grupo).reduce((acc, c) => { acc[c.columna] = parseFloat((origen || {})[c.columna]) || 0; return acc; }, {});
        const descuentosFijos = montosPorColumna('DESCUENTO', emp.descuentos_fijos);
        const aportesFijos = montosPorColumna('APORTE', emp.aportes_fijos);
        const totalDescuentosFijos = Object.values(descuentosFijos).reduce((s, v) => s + v, 0);

        // El día (y minuto) se valoriza sobre el mes COMPLETO, no sobre el monto ya prorrateado.
        const valorDia = ingresosMensualesCompletos / divisor;
        const valorHora = valorDia / 8;
        const valorMinuto = valorHora / 60;

        // No se pueden descontar más faltas que los días que le corresponden en el mes
        const diasFalta = Math.min(parseFloat(emp.faltas) || 0, diasComputables);
        const minutosTardanza = parseFloat(emp.tardanzas) || 0;

        const descuentoFaltas = valorDia * diasFalta;
        const descuentoTardanzas = valorMinuto * minutosTardanza;
        const totalDescuentoAsistencia = descuentoFaltas + descuentoTardanzas;

        // Base imponible = ingresos prorrateados - asistencia  => AFP/ONP/judicial salen proporcionales
        const totalIngresos = ingresosSinAsistencia - totalDescuentoAsistencia;
        let baseImponible = totalIngresos > 0 ? totalIngresos : 0;

        // Pensiones
        let onp = 0, afpApo = 0, afpCom = 0, afpPri = 0;
        if (baseImponible > 0) {
            const regNom = (emp.regimen_nombre || '').toUpperCase();
            if (regNom.includes('ONP') || regNom.includes('SNP')) { onp = baseImponible * 0.13; } 
            else {
                let tasaApo = parseFloat(emp.afp_apo_valor) || 0; let tasaCom = parseFloat(emp.afp_com_valor) || 0; let tasaPri = parseFloat(emp.afp_pri_valor) || 0; 
                if (tasaApo > 1) tasaApo = tasaApo / 100; if (tasaCom > 1) tasaCom = tasaCom / 100; if (tasaPri > 1) tasaPri = tasaPri / 100;
                const tipoCom = (emp.tipo_comision || 'Flujo').trim(); 
                if (tipoCom === 'Mixta') { tasaCom = 0; } else if (tipoCom === 'Flujo') { tasaPri = 0; }
                if (edad >= 65) { tasaPri = 0; }
                afpApo = baseImponible * tasaApo; afpCom = baseImponible * tasaCom; afpPri = baseImponible * tasaPri; 
            }
        }
        const totalPension = onp + afpApo + afpCom + afpPri;
        
        // --- RENTA 5TA (FORZADA SIEMPRE) ---
        // ¡IGNORAMOS EL DATO GUARDADO PARA OBLIGAR A RECALCULAR CON LA NUEVA UIT!
        // La proyección anual se hace con la remuneración del MES COMPLETO (proyectar el monto prorrateado x12
        // subestimaría el ingreso anual); luego la retención del mes se prorratea igual que los demás conceptos.
        let renta5ta = 0; 
        const ingresoMensualParaRenta = factorDias === 1 ? totalIngresos : ingresosMensualesCompletos - totalDescuentoAsistencia;
        if (ingresoMensualParaRenta > 2000) { 
            renta5ta = calcularRenta5taSunat(ingresoMensualParaRenta, periodoPlanilla, emp.tipo_contrato, emp.fecha_raw) * factorDias; 
        }
        
        let baseJudicial = totalIngresos - totalPension - renta5ta; if (baseJudicial < 0) baseJudicial = 0;
        const porcentajeJudicial = parseFloat(emp.judicial_porcentaje) || 0; const descuentoJudicial = baseJudicial * (porcentajeJudicial / 100);
        const sindicato = parseFloat(emp.sindicato) || 0; const prestamos = parseFloat(emp.prestamos) || 0;
        const totalDescuentos = totalPension + renta5ta + sindicato + descuentoJudicial + prestamos + totalDescuentosFijos;
        const netoPagar = totalIngresos - totalDescuentos;
        
        // --- ESSALUD ---
        let essalud = 0; 
        if (baseImponible > 0) { 
            // Base mínima = RMV proporcional a los días computables del mes
            const baseMinima = CONFIG_GLOBAL.rmv * factorDias;
            let baseCalculo = baseImponible < baseMinima ? baseMinima : baseImponible; 
            essalud = baseCalculo * CONFIG_GLOBAL.tasa_essalud; 
            const esCAS = (emp.tipo_contrato || '').toUpperCase().includes('CAS'); 
            // TOPE FIJO CAS (SOLICITADO)
            if (esCAS && essalud > 223.97) { essalud = 223.97; } 
        } 
        
        const estadoInfo = estadoPlanilla(emp);
        let fechaIngresoStr = emp.fecha_raw ? new Date(emp.fecha_raw).toLocaleDateString('es-PE', { timeZone: 'UTC' }) : '-';

        // Campos planos para la tabla y el Excel (ING_0, DSC_0, APO_0...) según el catálogo
        const camposDinamicos = {};
        COLUMNAS_PLANILLA.forEach(c => {
            camposDinamicos[c.clave] = c.grupo === 'INGRESO' ? (ingresosPeriodo[c.columna] || 0)
                : c.grupo === 'DESCUENTO' ? descuentosFijos[c.columna] : aportesFijos[c.columna];
        });

        return {
            ...camposDinamicos,
            id: emp.id, nombre_completo: emp.nombre,estado: estadoInfo.texto, estado_tipo: estadoInfo.tipo, fecha_ingreso: fechaIngresoStr, meta: emp.meta || '',
            dni: emp.dni, cargo: emp.cargo, area: emp.area, nivel: emp.nivel, dias: diasComputables - diasFalta, dias_computables: diasComputables, tardanzas: minutosTardanza, faltas: diasFalta, snp_onp: emp.regimen_nombre, cuspp: emp.cuspp, subtipo: emp.subtipo, tipo_contrato: emp.tipo_contrato,
            detalle: {
                INGRESOS: ingresosPeriodo, DESCUENTOS_FIJOS: descuentosFijos, APORTES_FIJOS: aportesFijos,
                DSCTO_ASISTENCIA:totalDescuentoAsistencia, ONP: onp, AFP_APORTE: afpApo, AFP_COMISION: afpCom, AFP_PRIMA: afpPri, RENTA_5TA: renta5ta, SINDICATO: sindicato, 
                JUDICIAL: descuentoJudicial, PRESTAMOS: prestamos, DSCTO_FALTAS: descuentoFaltas, DSCTO_TARDANZAS: descuentoTardanzas, ESSALUD: essalud
            },
            total_ingresos: totalIngresos, total_descuentos: totalDescuentos, neto_pagar: netoPagar
        };
    });
    
    PLANILLA_CALCULADA = datosProcesados;
    if(table) table.setData(datosProcesados); 
    actualizarKPIs(datosProcesados);
}

// ... (Las funciones calcularRenta5taSunat, actualizarKPIs, initTable, initChart, etc. se quedan IGUAL al último código completo que te pasé) ...
// PEGA AQUÍ EL RESTO DE FUNCIONES (initTable, verBoleta, calcularRenta5taSunat, etc.) DE TU VERSIÓN ANTERIOR
// SON LAS MISMAS, NO CAMBIAN.
// LO IMPORTANTE ARRIBA ES EL FLUJO: CONFIG -> DATOS -> RECALCULAR.

function calcularRenta5taSunat(ingresoMensual, periodoTexto, tipoContrato, fechaIngresoRaw) { 
    // 1. Detectar Mes Actual (Solo para referencia, ya no cambia el divisor)
    const partes = periodoTexto.split('-'); 
    const anioFiscal = parseInt(partes[0]) || 2025; 
    
    // 2. Proyección Anual (Ingresos totales del año)
    // Se proyecta el sueldo x 12 para obtener la base anual estable
    let proyeccionAnual = 0; 
    const tipo = (tipoContrato || '').toUpperCase().trim();

    if (tipo.includes('CAS') || tipo.includes('FUNCIONARIO') || tipo.includes('EMPLEADO') || tipo.includes('NOMBRADO')) { 
        // CAS/PÚBLICO: 12 Sueldos + 600 soles de Aguinaldos
        const aguinaldosAnuales = 600; 
        proyeccionAnual = (ingresoMensual * 12) + aguinaldosAnuales; 
    } else { 
        // OBREROS/PRIVADO: 14 Sueldos (12 + 2 Gratificaciones)
        proyeccionAnual = (ingresoMensual * 12) + (ingresoMensual * 2); 
    } 
    
    // 3. Deducción de 7 UIT
    // Usamos la UIT que descargamos del servidor (Configuración del mes)
    const UIT = CONFIG_GLOBAL.uit; 
    const deduccion = 7 * UIT; 
    const rentaNeta = proyeccionAnual - deduccion; 
    
    // Si no supera las 7 UIT, no paga nada. Fin.
    if (rentaNeta <= 0) return 0; 
    
    // 4. Cálculo del Impuesto ANUAL (Escala acumulativa SUNAT)
    let impuestoAnual = 0; 
    let remanente = rentaNeta; 
    
    // Tramo 1: Hasta 5 UIT (8%)
    const tramo1 = 5 * UIT; 
    if (remanente > tramo1) { 
        impuestoAnual += tramo1 * 0.08; 
        remanente -= tramo1; 
    } else { 
        impuestoAnual += remanente * 0.08; 
        remanente = 0; 
    } 
    
    // Tramo 2: Exceso de 5 hasta 20 UIT (14%)
    if (remanente > 0) { 
        const tramo2 = 15 * UIT; // (20-5)
        if (remanente > tramo2) { 
            impuestoAnual += tramo2 * 0.14; 
            remanente -= tramo2; 
        } else { 
            impuestoAnual += remanente * 0.14; 
            remanente = 0; 
        } 
    } 
    
    // Tramo 3: Exceso de 20 hasta 35 UIT (17%)
    if (remanente > 0) { 
        const tramo3 = 15 * UIT; // (35-20)
        if (remanente > tramo3) { 
            impuestoAnual += tramo3 * 0.17; 
            remanente -= tramo3; 
        } else { 
            impuestoAnual += remanente * 0.17; 
            remanente = 0; 
        } 
    } 
    
    // Tramo 4: Exceso de 35 hasta 45 UIT (20%)
    if (remanente > 0) { 
        const tramo4 = 10 * UIT; // (45-35)
        if (remanente > tramo4) { 
            impuestoAnual += tramo4 * 0.20; 
            remanente -= tramo4; 
        } else { 
            impuestoAnual += remanente * 0.20; 
            remanente = 0; 
        } 
    } 
    
    // Tramo 5: Exceso de 45 UIT (30%)
    if (remanente > 0) { 
        impuestoAnual += remanente * 0.30; 
    } 
    
    // 5. Retención Mensual (MÉTODO LINEAL)
    // Aquí estaba el problema. Eliminamos los divisores 9, 8, 5, 4.
    // Dividimos siempre entre 12 para que el descuento sea IDÉNTICO cada mes.
    return impuestoAnual / 12; 
}

// =======================================================
// === MÓDULO DE EXPORTACIÓN A EXCEL (INTELIGENTE Y DINÁMICO) ===
// =======================================================

document.addEventListener('DOMContentLoaded', () => {
    const btnExportar = document.getElementById('btn-exportar');
    if (btnExportar) {
        const nuevoBtn = btnExportar.cloneNode(true);
        btnExportar.parentNode.replaceChild(nuevoBtn, btnExportar);
        nuevoBtn.addEventListener('click', exportarExcelMaster);
    }
});

// =======================================================
// === BUSCADOR EN TIEMPO REAL (APELLIDOS Y NOMBRES / DNI) ===
// =======================================================
// Se usa el filtro nativo de Tabulator (en vez de display:none sobre el DOM)
// porque la tabla renderiza filas virtuales; así también se recalculan los totales.
// El buscador y el combo de tipo (#filtro-tipo-planilla) se combinan en un solo filtro.

function normalizarTexto(txt) {
    return String(txt ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

function aplicarFiltrosTabla() {
    if (!table) return;
    const termino = normalizarTexto(document.getElementById('filtro')?.value);
    const tipo = normalizarTexto(document.getElementById('filtro-tipo-planilla')?.value || 'TODOS');
    const filtrarTipo = tipo && tipo !== 'todos';

    if (!termino && !filtrarTipo) {
        table.clearFilter();
        return;
    }

    table.setFilter(data => {
        // includes: los tipos reales pueden ser compuestos (ej. "OBRERO PERMANENTE")
        const pasaTipo = !filtrarTipo || normalizarTexto(data.tipo_contrato).includes(tipo);
        const pasaTexto = !termino ||
            normalizarTexto(data.nombre_completo).includes(termino) ||
            normalizarTexto(data.dni).includes(termino);
        return pasaTipo && pasaTexto;
    });
}

// Invocada desde el onchange de #filtro-tipo-planilla
window.filtrarPlanilla = aplicarFiltrosTabla;

document.addEventListener('DOMContentLoaded', () => {
    const inputFiltro = document.getElementById('filtro');
    if (inputFiltro) inputFiltro.addEventListener('input', aplicarFiltrosTabla);
});

// =======================================================
// === MÓDULO DE EXPORTACIÓN A EXCEL (CORREGIDO Y SINCRONIZADO) ===
// =======================================================

async function exportarExcelMaster() {
    // 1. Validar si hay datos
    if (!PLANILLA_CALCULADA || PLANILLA_CALCULADA.length === 0) {
        return Swal.fire("Atención", "No hay datos en pantalla. Primero 'Ingresa al Sistema'.", "warning");
    }

    // 2. DETECTAR TÍTULO INTELIGENTE (Usando las variables globales)
    // Ya no buscamos en el HTML, usamos la memoria del sistema que es más segura.
    // La pantalla de reincorporados SIEMPRE lo indica en el nombre y el título: sin esto ambos Excel
    // salían como "GENERAL" y podían confundirse o sumarse dos veces.
    let tituloTipo = esPaginaReincorporados ? "REINCORPORADOS" : "GENERAL";

    if (FILTRO_ACTUAL_TIPO && FILTRO_ACTUAL_TIPO !== 'TODOS') {
        // Ej: "OBRERO PERMANENTE" / "REINCORPORADOS - OBRERO PERMANENTE"
        tituloTipo = esPaginaReincorporados ? `REINCORPORADOS - ${FILTRO_ACTUAL_TIPO}` : FILTRO_ACTUAL_TIPO;
        
        // Si hay subtipo seleccionado, lo agregamos también
        if (FILTRO_ACTUAL_SUBTIPO && FILTRO_ACTUAL_SUBTIPO !== '' && FILTRO_ACTUAL_SUBTIPO !== '-') {
            tituloTipo += ` (${FILTRO_ACTUAL_SUBTIPO})`; // Ej: "OBRERO PERMANENTE (LIMPIEZA PÚBLICA)"
        }
    }

    Swal.fire({ title: 'Generando Reporte...', html: `Exportando: ${tituloTipo}`, didOpen: () => Swal.showLoading() });

    // --- ESTILOS REUTILIZABLES ---
    const borderStyle = { style: "thin", color: { rgb: "000000" } };
    const bordersAll = { top: borderStyle, bottom: borderStyle, left: borderStyle, right: borderStyle };
    
    const styleTitle = { font: { bold: true, sz: 14, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "1E3A8A" } }, alignment: { horizontal: "center", vertical: "center" } }; 
    const styleSubTitle = { font: { bold: true, sz: 11 }, alignment: { horizontal: "left" } };
    const styleHeadGroup = { font: { bold: true, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "475569" } }, alignment: { horizontal: "center" }, border: bordersAll }; 
    const styleHeadCol = { font: { bold: true, sz: 8 }, fill: { fgColor: { rgb: "E2E8F0" } }, alignment: { horizontal: "center", vertical: "center", wrapText: true }, border: bordersAll }; 
    const styleText = { font: { sz: 9 }, alignment: { horizontal: "left" }, border: bordersAll };
    const styleCenter = { font: { sz: 9 }, alignment: { horizontal: "center" }, border: bordersAll };
    const styleMoney = { font: { sz: 9 }, alignment: { horizontal: "right" }, numFmt: '"S/" #,##0.00', border: bordersAll };
    const styleMoneyBold = { font: { bold: true, sz: 9 }, alignment: { horizontal: "right" }, numFmt: '"S/" #,##0.00', border: bordersAll, fill: { fgColor: { rgb: "F1F5F9" } } };
    const COLOR_ESTADO_EXCEL = { cese: { font: "B91C1C", fill: "FEE2E2" }, reincorporado: { font: "1D4ED8", fill: "DBEAFE" }, ingreso: { font: "1D4ED8", fill: "DBEAFE" } };
    const styleNeto = { font: { bold: true, sz: 10, color: { rgb: "000000" } }, fill: { fgColor: { rgb: "FEF3C7" } }, alignment: { horizontal: "right" }, numFmt: '"S/" #,##0.00', border: bordersAll }; 

    // 3. DEFINICIÓN DE COLUMNAS
    const columnas = [
        { header: "N°", key: "index", width: 5, style: styleCenter },
        { header: "DNI", key: "dni", width: 10, style: styleCenter },
        { header: "APELLIDOS Y NOMBRES", key: "nombre", width: 35, style: styleText },
        { header: "CARGO", key: "cargo", width: 20, style: styleText },
        { header: "ESTADO", key: "estado", width: 32, style: styleCenter },
        { header: "DIAS", key: "dias", width: 5, style: styleCenter },
        
        // Una columna por concepto de ingreso activo (catálogo), en su orden
        ...columnasDe('INGRESO').map(c => ({ header: c.columna, key: c.clave, width: 11, style: styleMoney })),
        { header: "TOTAL BRUTO", key: "total_ing", width: 13, style: styleMoneyBold },

        { header: "ONP / SNP", key: "onp", width: 10, style: styleMoney },        
        { header: "AFP APORTE", key: "afp_apo", width: 10, style: styleMoney },   
        { header: "AFP COMISIÓN", key: "afp_com", width: 10, style: styleMoney }, 
        { header: "AFP PRIMA", key: "afp_pri", width: 10, style: styleMoney },    
        
        { header: "RENTA 5TA", key: "renta_5ta", width: 10, style: styleMoney },
        { header: "SINDICATO", key: "sindicato", width: 10, style: styleMoney },
        { header: "JUDICIAL", key: "judicial", width: 10, style: styleMoney },
        { header: "PRÉSTAMOS", key: "prestamos", width: 10, style: styleMoney },
        ...columnasDe('DESCUENTO').map(c => ({ header: c.columna, key: c.clave, width: 10, style: styleMoney })),
        { header: "TARD/FALTAS", key: "dscto_asistencia", width: 10, style: styleMoney },
        { header: "TOTAL DSCTO", key: "total_desc", width: 13, style: styleMoneyBold },

        { header: "ESSALUD 9%", key: "essalud", width: 11, style: styleMoney },
        ...columnasDe('APORTE').map(c => ({ header: c.columna, key: c.clave, width: 11, style: styleMoney })),
        { header: "NETO A PAGAR", key: "neto", width: 15, style: styleNeto }
    ];

    // 4. PROCESAR DATOS (Usamos directamente PLANILLA_CALCULADA porque ya está filtrada)
    let filasDatos = [];
    let totales = {};

    PLANILLA_CALCULADA.forEach((emp, i) => {
        const d = emp.detalle;
        // Columnas dinámicas (ING_x, DSC_x, APO_x) tal como salen del cálculo
        const dinamicas = {};
        COLUMNAS_PLANILLA.forEach(c => { dinamicas[c.clave] = emp[c.clave] || 0; });

        const fila = {
            index: i + 1,
            dni: emp.dni,
            nombre: emp.nombre_completo,
            cargo: emp.cargo,
            estado: emp.estado,
            dias: emp.dias,
            ...dinamicas, total_ing: emp.total_ingresos,
            onp: d.ONP || 0, afp_apo: d.AFP_APORTE || 0, afp_com: d.AFP_COMISION || 0, afp_pri: d.AFP_PRIMA || 0,
            renta_5ta: d.RENTA_5TA, sindicato: d.SINDICATO, judicial: d.JUDICIAL, prestamos: d.PRESTAMOS,
            dscto_asistencia: d.DSCTO_ASISTENCIA || 0, total_desc: emp.total_descuentos,
            essalud: d.ESSALUD, neto: emp.neto_pagar
        };

        filasDatos.push(fila);
        Object.keys(fila).forEach(k => { if (typeof fila[k] === 'number' && k !== 'index' && k !== 'dni' && k !== 'dias') totales[k] = (totales[k] || 0) + fila[k]; });
    });

    // 5. CONSTRUIR HOJA
    const ws_data = [];
    ws_data.push(["MUNICIPALIDAD DISTRITAL DE TUPAC AMARU INCA"]);
    ws_data.push(["RUC: 20147604310"]);
    
    // TÍTULO DINÁMICO (AQUÍ ESTÁ LA CORRECCIÓN CLAVE)
    // Usamos el 'tituloTipo' que calculamos al principio con las variables globales
    const textoTitulo = `PLANILLA DE PAGOS${tituloTipo === 'GENERAL' ? '' : ' (' + tituloTipo + ')'} - ${periodoPlanilla}`;
        
    ws_data.push([textoTitulo.toUpperCase()]);
    ws_data.push([]); 

    // Posiciones de los grupos calculadas por clave (si se agrega/quita una columna no se descuadra nada)
    const colDe = (key) => columnas.findIndex(c => c.key === key);
    const cIngIni = columnasDe('INGRESO').length ? colDe(columnasDe('INGRESO')[0].clave) : colDe('total_ing'), cIngFin = colDe('total_ing');
    const cDscIni = colDe('onp'), cDscFin = colDe('total_desc');
    const cAporte = colDe('essalud'), cNeto = colDe('neto');
    const superHeaderRow = columnas.map(() => "");
    superHeaderRow[cIngIni] = "INGRESOS"; superHeaderRow[cDscIni] = "DESCUENTOS"; superHeaderRow[cAporte] = "APORTE"; superHeaderRow[cNeto] = "NETO";
    ws_data.push(superHeaderRow);
    ws_data.push(columnas.map(c => c.header));
    filasDatos.forEach(f => ws_data.push(columnas.map(c => f[c.key])));
    
    const rowTotales = columnas.map(c => {
        if (c.key === 'nombre') return 'TOTAL GENERAL:';
        if (totales[c.key] !== undefined) return totales[c.key];
        return '';
    });
    ws_data.push(rowTotales);

    // 6. CREAR ARCHIVO
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(ws_data);
    ws['!cols'] = columnas.map(c => ({ wch: c.width }));
    
    // MERGES
    ws['!merges'] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: 10 } }, 
        { s: { r: 1, c: 0 }, e: { r: 1, c: 10 } }, 
        { s: { r: 2, c: 0 }, e: { r: 2, c: columnas.length - 1 } }, 
        { s: { r: 4, c: cIngIni }, e: { r: 4, c: cIngFin } }, // Grupo INGRESOS
        { s: { r: 4, c: cDscIni }, e: { r: 4, c: cDscFin } } // Grupo DESCUENTOS
    ];
    // Grupo APORTE: EsSalud + aportes fijos dinámicos
    if (columnasDe('APORTE').length) ws['!merges'].push({ s: { r: 4, c: cAporte }, e: { r: 4, c: colDe(columnasDe('APORTE').slice(-1)[0].clave) } });

    // ESTILOS
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let R = range.s.r; R <= range.e.r; ++R) {
        for (let C = range.s.c; C <= range.e.c; ++C) {
            const cell_ref = XLSX.utils.encode_cell({ r: R, c: C });
            if (!ws[cell_ref]) continue;

            if (R === 2) ws[cell_ref].s = styleTitle;
            else if (R < 4) ws[cell_ref].s = styleSubTitle;
            else if (R === 4) { if ([cIngIni, cDscIni, cAporte, cNeto].includes(C)) ws[cell_ref].s = styleHeadGroup; }
            else if (R === 5) ws[cell_ref].s = styleHeadCol;
            else if (R > 5) {
                if (filasDatos.length > 0 && R === 5 + filasDatos.length + 1) ws[cell_ref].s = styleMoneyBold; 
                else if (R <= 5 + filasDatos.length) {
                    const col = columnas[C]; if (col && col.style) ws[cell_ref].s = col.style;
                    // ESTADO en color: rojo = cese, azul = reincorporado / ingreso
                    const colorEstado = col && col.key === 'estado' && COLOR_ESTADO_EXCEL[PLANILLA_CALCULADA[R - 6].estado_tipo];
                    if (colorEstado) ws[cell_ref].s = { ...styleCenter, font: { sz: 9, bold: true, color: { rgb: colorEstado.font } }, fill: { fgColor: { rgb: colorEstado.fill } } };
                }
            }
        }
    }

    XLSX.utils.book_append_sheet(wb, ws, "Planilla Oficial");
    
    // Nombre del archivo también dinámico
    const nombreArchivo = `Planilla_MDTAI_${tituloTipo.replace(/ /g, '_')}_${periodoPlanilla}.xlsx`;
    XLSX.writeFile(wb, nombreArchivo);
    
    Swal.close();
}

function actualizarKPIs(data) { let tIng = 0, tDesc = 0, tNeto = 0; data.forEach(d => { tIng += d.total_ingresos || 0; tDesc += d.total_descuentos || 0; tNeto += d.neto_pagar || 0; }); const elCount = document.getElementById('kpi-count'); if(elCount) elCount.textContent = data.length; const elBruto = document.getElementById('kpi-bruto'); if(elBruto) elBruto.textContent = `S/ ${tIng.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`; const elDesc = document.getElementById('kpi-desc'); if(elDesc) elDesc.textContent = `S/ ${tDesc.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`; const elNeto = document.getElementById('kpi-neto'); if(elNeto) elNeto.textContent = `S/ ${tNeto.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`; if(chart) { chart.updateOptions({ plotOptions: { pie: { donut: { labels: { total: { formatter: function (w) { return `S/ ${(tIng/1000).toFixed(1)}k`; } } } } } } }); chart.updateSeries([tNeto, tDesc]); } }
function initChart() { if(!document.querySelector("#chart-container")) return; const options = { series: [0, 0], chart: { type: 'donut', height: 160 }, labels: ['Neto a Pagar', 'Descuentos'], colors: ['#3b82f6', '#ef4444'], legend: { show: false }, dataLabels: { enabled: false }, plotOptions: { pie: { donut: { size: '75%', labels: { show: true, name: { show: true, fontSize: '10px', color: '#64748b' }, value: { show: true, fontSize: '14px', fontWeight: 'bold', color: '#0f172a', formatter: function (val) { return `S/ ${(val/1000).toFixed(1)}k` } }, total: { show: true, showAlways: true, label: 'TOTAL', fontSize: '10px', fontWeight: 'bold', color: '#64748b' } } } } }, tooltip: { y: { formatter: function(val) { return "S/ " + val.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}) } } } }; chart = new ApexCharts(document.querySelector("#chart-container"), options); chart.render(); }
function inyectarBotones() {
    const areaBotones = document.querySelector('#botones-accion-dinamicos');
    if (!areaBotones) return;
    areaBotones.innerHTML = '';

    const btnCierre = document.createElement('button');
    if (PLANILLA_CERRADA) {
        btnCierre.className = "bg-amber-500 text-white hover:bg-amber-600 px-3 py-2 rounded text-xs font-bold transition flex items-center shadow-sm";
        btnCierre.innerHTML = '<i class="fas fa-lock-open mr-2"></i> ACTIVAR PLANILLA';
        btnCierre.onclick = reabrirPlanilla;
    } else {
        btnCierre.className = "bg-red-600 text-white hover:bg-red-700 px-3 py-2 rounded text-xs font-bold transition flex items-center shadow-sm";
        btnCierre.innerHTML = '<i class="fas fa-lock mr-2"></i> CERRAR PLANILLA';
        btnCierre.onclick = cerrarPlanilla;
    }
    areaBotones.appendChild(btnCierre);

    // Copia del cierre: indicar desde dónde se dibuja y permitir alternar con los datos actuales
    const copia = INFO_CIERRE && INFO_CIERRE.copia;
    if (copia) {
        const btnVista = document.createElement('button');
        btnVista.className = "bg-slate-600 text-white hover:bg-slate-700 px-3 py-2 rounded text-xs font-bold transition flex items-center shadow-sm ml-2";
        btnVista.innerHTML = VER_EN_VIVO
            ? '<i class="fas fa-archive mr-2"></i> VER COPIA DEL CIERRE'
            : '<i class="fas fa-sync mr-2"></i> VER DATOS ACTUALES';
        btnVista.title = VER_EN_VIVO
            ? 'Volver a la planilla tal como se guardó al cerrarla'
            : 'Recalcular con los datos de hoy (no modifica la copia guardada)';
        btnVista.onclick = () => {
            const url = new URL(window.location.href);
            if (VER_EN_VIVO) url.searchParams.delete('en_vivo'); else url.searchParams.set('en_vivo', '1');
            window.location.href = url.toString();
        };
        areaBotones.appendChild(btnVista);
    }

    const lblPeriodo = document.getElementById('periodo-actual');
    if (lblPeriodo) {
        lblPeriodo.querySelectorAll('.badge-planilla-cerrada, .badge-copia-cierre').forEach(b => b.remove());
        if (copia) {
            const badge = document.createElement('span');
            badge.className = VER_EN_VIVO
                ? 'badge-copia-cierre bg-orange-500 text-white px-2 py-0.5 rounded ml-2 text-xs font-bold'
                : 'badge-copia-cierre bg-emerald-600 text-white px-2 py-0.5 rounded ml-2 text-xs font-bold';
            badge.innerHTML = VER_EN_VIVO
                ? '<i class="fas fa-exclamation-triangle mr-1"></i> DATOS ACTUALES (NO SON LOS DEL CIERRE)'
                : `<i class="fas fa-archive mr-1"></i> COPIA DEL CIERRE v${copia.version} · ${copia.fecha}`;
            lblPeriodo.appendChild(badge);
        }
        if (PLANILLA_CERRADA) {
            const badge = document.createElement('span');
            badge.className = 'badge-planilla-cerrada bg-red-600 text-white px-2 py-0.5 rounded ml-2 text-xs font-bold';
            badge.innerHTML = '<i class="fas fa-lock mr-1"></i> SISTEMA BLOQUEADO';
            lblPeriodo.appendChild(badge);
        }
    }
}

async function verificarEstadoPlanilla() {
    try {
        const res = await fetch(`${API_URL}/api/planilla/estado?periodo=${encodeURIComponent(periodoPlanilla)}`, {
            headers: { 'Authorization': `Bearer ${tokenPlanilla}` }
        });
        const data = await res.json();
        // "bloqueado" es el candado GLOBAL (todo el sistema). Es la fuente de verdad.
        PLANILLA_CERRADA = !!data.bloqueado;
        INFO_CIERRE = data;
    } catch (e) {
        console.error('No se pudo verificar el estado de la planilla:', e);
        PLANILLA_CERRADA = false;
        INFO_CIERRE = null;
    }
    inyectarBotones();
}

async function cerrarPlanilla() {
    const confirm = await Swal.fire({
        title: '¿Cerrar Planilla?',
        html: `Esto bloqueará <b>todo el sistema</b>: ningún módulo (empleados, asistencias, préstamos, comisiones, personas, etc.) podrá modificarse hasta que actives la planilla de nuevo con la contraseña.<br><br>Úsalo solo cuando ya se haya pagado a los trabajadores.`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'Sí, cerrar todo',
        confirmButtonColor: '#dc2626'
    });
    if (!confirm.isConfirmed) return;

    Swal.fire({ title: 'Cerrando...', didOpen: () => Swal.showLoading() });
    try {
        const res = await fetch(`${API_URL}/api/planilla/cerrar`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenPlanilla}` },
            body: JSON.stringify({ periodo: periodoPlanilla })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'No se pudo cerrar la planilla.');
        await verificarEstadoPlanilla();
        Swal.fire('¡Sistema bloqueado!', data.message, 'success');
    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
}

async function reabrirPlanilla() {
    const { value: password } = await Swal.fire({
        title: 'Activar Planilla',
        html: 'Ingresa la contraseña para desbloquear todo el sistema.',
        input: 'password',
        inputPlaceholder: 'Contraseña',
        inputAttributes: { autocapitalize: 'off', autocorrect: 'off' },
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'Activar'
    });
    if (!password) return;

    Swal.fire({ title: 'Activando...', didOpen: () => Swal.showLoading() });
    try {
        const res = await fetch(`${API_URL}/api/planilla/reabrir`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenPlanilla}` },
            body: JSON.stringify({ periodo: periodoPlanilla, password: password })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'No se pudo activar la planilla.');
        await verificarEstadoPlanilla();
        Swal.fire('¡Sistema activado!', data.message, 'success');
    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
}
function verBoleta(id) { const d = PLANILLA_CALCULADA.find(x => x.id === id); if (!d || !d.detalle) { Swal.fire("Error", "No se encontraron detalles.", "error"); return; } const nombresOficiales = { "REM_BASICA": "REMUN. BÁSICA", "REM_REUNIF": "REM. REUNIF.", "COSTO_VIDA": "COSTO DE VIDA", "BONIF_DIF_CARGO": "BONIF. DIF. CARGO", "BONIF_DIF_PERM": "BONIF. DIF. PERM.", "REFRIG_MOV": "REFRIG. Y MOVIL.", "ASIG_FAMILIAR": "ASIG. FAMILIAR", "BONIF_PERSONAL": "BONIF. PERSONAL", "TRANS_HOMOL": "TRANS. HOMOL.", "RIESGO_SALUD": "RIESGO SALUD", "DS_314_2023": "DS 314-2023-EF", "DS_320_2022": "DS 320-2022-EF", "DS_268_2024": "DS 268-2024-EF", "DS_280_2024": "DS 280-2024-EF", "DS_279_2024": "DS 279-2024-EF", "DS_265_2024": "DS 265-2024-EF", "DS_313_2023": "DS 313-2023-EF", "DS_311_2022": "DS 311-2022-EF", "RA_341_2011": "R.A. 341-2011", "AFP_APORTE": "APOR. OBLIG", "AFP_COMISION": "COMISION", "AFP_PRIMA": "PRIMA DE SEGURO", "ONP": "ONP 13%", "RENTA_5TA": "RENTA 5TA.CATEG.", "SINDICATO": "CUOTA SINDICAL", "PRESTAMOS": "DSCTO PRESTAMOS", "JUDICIAL": "DSCTO JUDIC.", "ESSALUD": "ESSALUD 9%", "DSCTO_FALTAS": "DSCTO. FALTAS", "DSCTO_TARDANZAS": "DSCTO. TARDANZAS", "ING_AFP": "AFP (CONCEPTO)" }; const ingresos = columnasDe('INGRESO').map(c => [c.columna, (d.detalle.INGRESOS || {})[c.columna] || 0]).filter(([k, v]) => v > 0); const descuentos = [['ONP','ONP 13%'],['AFP_APORTE','APOR. OBLIG'],['AFP_COMISION','COMISION'],['AFP_PRIMA','PRIMA DE SEGURO'],['RENTA_5TA','RENTA 5TA.CATEG.'],['SINDICATO','CUOTA SINDICAL'],['JUDICIAL','DSCTO JUDIC.'],['PRESTAMOS','DSCTO PRESTAMOS']].map(([k, etq]) => [etq, d.detalle[k] || 0]).concat(columnasDe('DESCUENTO').map(c => [c.columna, (d.detalle.DESCUENTOS_FIJOS || {})[c.columna] || 0])).concat([['DSCTO. FALTAS', d.detalle.DSCTO_FALTAS || 0], ['DSCTO. TARDANZAS', d.detalle.DSCTO_TARDANZAS || 0]]).filter(([k, v]) => v > 0); let html = `<div class="border border-slate-300 p-6 mb-4 font-sans text-xs bg-white"><div class="text-center mb-6 border-b pb-4"><h2 class="font-bold text-xl text-slate-800">MUNICIPALIDAD DISTRITAL</h2><p class="text-sm text-slate-500 font-bold uppercase">BOLETA DE PAGO - ${periodoPlanilla}</p></div><div class="grid grid-cols-2 gap-4 mb-6 bg-slate-50 p-4 rounded border border-slate-200"><div><p class="mb-1"><strong class="text-slate-600">Trabajador:</strong> <span class="text-slate-900 font-bold uppercase">${d.nombre_completo}</span></p><p class="mb-1"><strong class="text-slate-600">Cargo:</strong> <span class="uppercase">${d.cargo}</span></p><p class="mb-1"><strong class="text-slate-600">Área:</strong> <span class="uppercase font-bold text-blue-700">${d.area || '-'}</span></p><p class="mb-1"><strong class="text-slate-600">Nivel:</strong> ${d.nivel}</p><p class="mb-1"><strong class="text-slate-600">Meta:</strong> ${d.meta}</p></div><div class="text-right"><p class="mb-1"><strong class="text-slate-600">DNI:</strong> ${d.dni}</p><p class="mb-1"><strong class="text-slate-600">Régimen:</strong> <span class="bg-blue-100 text-blue-800 px-1 rounded font-bold">${d.snp_onp}</span></p><p class="mb-1"><strong class="text-slate-600">CUSPP:</strong> <span class="font-mono font-bold text-gray-800">${d.cuspp || '-'}</span></p><p class="mb-1"><strong class="text-slate-600">F. Ingreso:</strong> ${d.fecha_ingreso}</p><p class="mb-1"><strong class="text-slate-600">Estado:</strong> <span class="px-1 rounded border font-bold ${d.estado_tipo === 'cese' ? 'bg-red-50 text-red-700 border-red-300' : (d.estado_tipo === 'reincorporado' || d.estado_tipo === 'ingreso') ? 'bg-blue-50 text-blue-700 border-blue-300' : 'bg-green-50 text-green-700 border-green-300'}">${d.estado || 'ACTIVO'}</span></p><p class="mb-1"><strong class="text-slate-600">Días Trab:</strong> ${d.dias}</p></div></div><table class="w-full mb-6 border-collapse"><thead><tr class="border-b-2 border-slate-800 bg-slate-100 text-slate-700"><th class="text-left py-2 px-2">CONCEPTOS</th><th class="text-right py-2 px-2 w-24">INGRESOS</th><th class="text-right py-2 px-2 w-24">DESCUENTOS</th></tr></thead><tbody>${ingresos.map(([k,v]) => `<tr class="border-b border-slate-100"><td class="py-1 px-2 text-slate-600">${nombresOficiales[k] || k}</td><td class="text-right py-1 px-2 font-mono">${v.toFixed(2)}</td><td></td></tr>`).join('')}<tr class="bg-green-50 border-t border-green-200"><td class="py-1 px-2 font-bold text-green-800 text-right">TOTAL BRUTO:</td><td class="text-right py-1 px-2 font-bold text-green-800 font-mono">${d.total_ingresos.toFixed(2)}</td><td></td></tr>${descuentos.map(([k,v]) => `<tr class="border-b border-slate-100"><td class="py-1 px-2 text-slate-600">${nombresOficiales[k] || k}</td><td></td><td class="text-right py-1 px-2 font-mono text-red-600">${v.toFixed(2)}</td></tr>`).join('')}</tbody><tfoot class="border-t-2 border-slate-800"><tr><td class="py-2 px-2 font-bold text-right">TOTALES:</td><td class="text-right py-2 px-2 font-bold">${d.total_ingresos.toFixed(2)}</td><td class="text-right py-2 px-2 font-bold text-red-600">${d.total_descuentos.toFixed(2)}</td></tr></tfoot></table><div class="grid grid-cols-2 gap-4 items-end mt-4 pt-4 border-t border-slate-200"><div class="bg-slate-50 border border-slate-200 rounded p-3"><p class="text-[10px] font-bold text-slate-500 uppercase mb-1 border-b pb-1">Aportes Empleador</p><div class="flex justify-between text-xs"><span class="text-slate-700">ESSALUD (9%):</span><span class="font-mono font-bold text-slate-800">S/ ${d.detalle.ESSALUD.toFixed(2)}</span></div>${columnasDe('APORTE').filter(c => (d.detalle.APORTES_FIJOS || {})[c.columna] > 0).map(c => `<div class="flex justify-between text-xs"><span class="text-slate-700">${c.columna}:</span><span class="font-mono font-bold text-slate-800">S/ ${d.detalle.APORTES_FIJOS[c.columna].toFixed(2)}</span></div>`).join('')}</div><div class="bg-slate-800 text-white p-3 rounded-lg shadow-lg text-right"><span class="text-xs font-bold uppercase block mb-1 opacity-80">Neto a Pagar:</span><span class="text-xl font-mono font-bold text-yellow-400">S/ ${d.neto_pagar.toFixed(2)}</span></div></div><div class="mt-4 text-[10px] text-slate-400 text-center"><p>Documento generado el ${new Date().toLocaleDateString()}</p></div></div>`; document.getElementById('contenido-boleta').innerHTML = html; document.getElementById('modalBoleta').classList.remove('hidden'); }
function initTable() { const moneyParams = { precision: 2, symbol: "" }; table = new Tabulator("#tabla-nomina", { height: "100%", layout: "fitColumns", columnDefaults: { tooltip: true, headerHozAlign: "center", headerWordWrap: true, headerVertAlign: "bottom" }, frozenRows: 0, columns: [ {title:"N°", field:"id", width:40, frozen:true, cssClass:"font-bold text-center bg-slate-50 text-slate-400"}, {title:"APELLIDOS Y NOMBRES", field:"nombre_completo", frozen:true, width:280, cssClass:"font-bold text-slate-700 border-r-2 border-slate-300 bg-white"}, {title:"DATOS LABORALES", cssClass:"header-blue", columns:[ {title:"ESTADO", field:"estado", width:215, hozAlign:"center", formatter:function(cell){ const val = (cell.getValue() || 'ACTIVO').toUpperCase(); const tipo = cell.getRow().getData().estado_tipo; let color = "bg-green-100 text-green-700"; if(val.includes("VACACION")) color = "bg-orange-100 text-orange-700"; if(tipo === 'reincorporado' || tipo === 'ingreso') color = "bg-blue-100 text-blue-700"; if(tipo === 'cese') color = "bg-red-100 text-red-700"; return `<span class="px-2 py-1 rounded text-[10px] font-bold ${color}">${val}</span>`; }}, {title:"F. Ingreso", field:"fecha_ingreso", width:85, hozAlign:"center"}, {title:"Meta", field:"meta", width:50, hozAlign:"center", cssClass:"font-bold text-blue-600 bg-blue-50"}, {title:"DNI", field:"dni", width:75}, {title:"Cargo", field:"cargo", width:130}, {title:"ÁREA", field:"area", width:150, cssClass:"text-xs font-bold text-slate-600 bg-slate-50"}, {title:"NIVEL", field:"nivel", width:70, hozAlign:"center"}, {title:"Dias", field:"dias", width:50, hozAlign:"center"}, {title:"Tardanzas", field:"tardanzas", width:75, hozAlign:"center", cssClass:"text-orange-600 bg-orange-50", formatter: function(cell){ const val = cell.getValue() || 0; return val > 0 ? `${val} min` : '-'; }}, {title:"Faltas", field:"faltas", width:60, hozAlign:"center", cssClass:"text-red-600 font-bold bg-red-50", formatter: function(cell){ const val = cell.getValue() || 0; return val > 0 ? val : '-'; }}, {title:"RÉGIMEN", field:"snp_onp", width:90, hozAlign:"center", formatter: cell => `<span class="px-2 py-1 rounded text-[10px] font-bold bg-blue-100 text-blue-700">${cell.getValue()||''}</span>`}, {title:"CUSPP", field:"cuspp", width:95}, ]}, {title:"INGRESOS / HABERES", cssClass:"header-green", columns:[ ...columnasDe('INGRESO').map(c => ({title: c.columna, field: c.clave, width: 80, formatter: "money", bottomCalc: "sum", cssClass: "money-cell"})), {title:"DESC. TARD. FALTAS", field:"detalle.DSCTO_ASISTENCIA", width:90, cssClass:"text-red-600 font-bold bg-red-50 money-cell", formatter: c => c.getValue()>0 ? `-${c.getValue().toFixed(2)}`:'0.00', bottomCalc:"sum"}, ]}, {title:"TOTAL BRUTO", field:"total_ingresos", width:110, formatter:"money", formatterParams:{symbol:""}, bottomCalc:"sum", bottomCalcFormatter:"money", bottomCalcFormatterParams:moneyParams, cssClass:"font-bold bg-green-100 text-green-800 money-cell border-l-2 border-r-2 border-slate-300"}, {title:"DESCUENTOS AL TRABAJADOR", cssClass:"header-red", columns:[ {title:"AFP", columns:[ {title:"APOR. OBLIG", field:"detalle.AFP_APORTE", width:85, formatter:"money", bottomCalc:"sum", cssClass:"money-cell text-slate-500"}, {title:"COMISION", field:"detalle.AFP_COMISION", width:80, formatter:"money", bottomCalc:"sum", cssClass:"money-cell text-slate-500"}, {title:"PRIMA SEGURO", field:"detalle.AFP_PRIMA", width:85, formatter:"money", bottomCalc:"sum", cssClass:"money-cell text-slate-500"}, ]}, {title:"ONP 13%", field:"detalle.ONP", width:75, formatter:"money", bottomCalc:"sum", cssClass:"money-cell"}, {title:"RENTA 5TA", field:"detalle.RENTA_5TA", width:85, formatter:"money", bottomCalc:"sum", cssClass:"money-cell text-red-500"}, {title:"CUOTA SINDICAL", field:"detalle.SINDICATO", width:80, formatter:"money", bottomCalc:"sum", cssClass:"money-cell"}, {title:"DSCTO PRESTAMOS", field:"detalle.PRESTAMOS", width:85, formatter:"money", bottomCalc:"sum", cssClass:"money-cell"}, {title:"DSCTO JUDIC.", field:"detalle.JUDICIAL", width:80, formatter:"money", bottomCalc:"sum", cssClass:"money-cell text-red-600"}, ...columnasDe('DESCUENTO').map(c => ({title: c.columna, field: c.clave, width: 85, formatter: "money", bottomCalc: "sum", cssClass: "money-cell"})), {title:"TOTAL DSCTO.", field:"total_descuentos", width:100, formatter:"money", formatterParams:{symbol:""}, bottomCalc:"sum", bottomCalcFormatter:"money", bottomCalcFormatterParams:moneyParams, cssClass:"font-bold bg-red-100 text-red-900 money-cell border-l-2 border-r-2 border-slate-300"}, ]}, {title:"ESSALUD 9%", field:"detalle.ESSALUD", width:80, formatter:"money", bottomCalc:"sum", cssClass:"money-cell text-blue-600"}, ...columnasDe('APORTE').map(c => ({title: c.columna, field: c.clave, width: 85, formatter: "money", bottomCalc: "sum", cssClass: "money-cell text-blue-600"})), {title:"NETO A PAGAR", field:"neto_pagar", formatter:"money", formatterParams:{symbol:"S/ "}, bottomCalc:"sum", cssClass:"font-bold bg-indigo-100 text-indigo-900 money-cell text-right text-base border-l-2 border-indigo-300", width:130}, {title:"", width:80, hozAlign:"center", headerSort:false, formatter: function(cell) { const id = cell.getRow().getData().id; return `<div class="flex gap-1 justify-center"><button class="btn-mini bg-indigo-50 text-indigo-600 hover:bg-indigo-600 hover:text-white" onclick="window.verBoleta(${id})" title="Ver Boleta"><i class="fas fa-eye"></i></button></div>`; }} ], }); }