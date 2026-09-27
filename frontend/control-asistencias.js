// =======================================================
// === CONTROL-ASISTENCIAS.JS (FIX: BASE 30 DÍAS COMERCIALES) ===
// =======================================================

const API_URL = ''; 
const tokenAsistencia = localStorage.getItem('token');
const periodoAsistencia = localStorage.getItem('periodo');

const tablaBody = document.getElementById('tabla-asistencias-body');
const panelTabla = document.getElementById('panel-tabla');
const mensajeInicio = document.getElementById('mensaje-inicio');
const buscarEmpleadoInput = document.getElementById('buscar-empleado');
const infoCambios = document.getElementById('info-cambios');

let tipoActual = ''; 
let filaSeleccionada = null; 

// =========================================================================
// === [CAMBIO IMPORTANTE] REGLA DE ORO: SIEMPRE SON 30 DÍAS ===
// =========================================================================
// En planilla comercial, no importa si es Febrero (28) o Enero (31).
// La base de cálculo y asistencia completa siempre es 30.
let diasTotalesDelMes = 30; 
// =========================================================================

document.addEventListener('DOMContentLoaded', () => {
    if (!tokenAsistencia) { window.location.href = 'login.html'; return; }
    if (!periodoAsistencia) { Swal.fire('Atención', 'No hay periodo seleccionado.', 'warning').then(() => window.location.href = 'index.html'); return; }
    
    // Ya no necesitamos calcular fechas complejas. Se usa 30 fijo.
    console.log("Sistema iniciado con Base 30 Días (Comercial).");

    if(buscarEmpleadoInput){
        buscarEmpleadoInput.addEventListener('input', (e) => {
            const term = e.target.value.toLowerCase();
            const filas = tablaBody.getElementsByTagName('tr');
            Array.from(filas).forEach(row => {
                const texto = row.dataset.texto || "";
                row.style.display = texto.includes(term) ? '' : 'none';
            });
        });
    }
});

// --- MODAL DE ESTADO ---
window.abrirModalEstado = function(btn) {
    filaSeleccionada = btn.closest('tr'); 
    const inputEstado = filaSeleccionada.querySelector('.estado-val').value;
    const inputDetalle = filaSeleccionada.querySelector('.estado-det').value;

    document.getElementById('select-estado-modal').value = inputEstado;
    document.getElementById('input-detalle-modal').value = inputDetalle; 

    document.getElementById('modalEstado').classList.remove('hidden');
};

window.cerrarModalEstado = function() {
    document.getElementById('modalEstado').classList.add('hidden');
    filaSeleccionada = null;
};

window.aplicarEstado = function() {
    if(!filaSeleccionada) return;

    const nuevoEstado = document.getElementById('select-estado-modal').value;
    const nuevoDetalle = document.getElementById('input-detalle-modal').value.toUpperCase();

    // Guardar en ocultos
    filaSeleccionada.querySelector('.estado-val').value = nuevoEstado;
    filaSeleccionada.querySelector('.estado-det').value = nuevoDetalle;

    // Referencias inputs
    const inpTrab = filaSeleccionada.querySelector('.dias-trab');
    const inpFalta = filaSeleccionada.querySelector('.dias-falta');
    const inpVac = filaSeleccionada.querySelector('.dias-vac');
    const inpLic = filaSeleccionada.querySelector('.dias-lic');
    const inpTard = filaSeleccionada.querySelector('.min-tard');

    // === LÓGICA DE DÍAS ===
    if (nuevoEstado === 'LICENCIA_SIN_GOCE') {
        inpTrab.value = 0;
        inpFalta.value = 0;
        inpVac.value = 0;
        inpLic.value = 0;
        inpTard.value = 0;
    } 
    else if (nuevoEstado === 'ACTIVO') {
        // SI VUELVE A ACTIVO, PONE 30 DÍAS
        inpTrab.value = diasTotalesDelMes; 
        inpFalta.value = 0;
        inpVac.value = 0;
        inpLic.value = 0;
        inpTard.value = 0;
    }
    // ======================

    // Actualizar visual
    const btnTexto = filaSeleccionada.querySelector('.btn-texto-estado');
    const contenedorBtn = filaSeleccionada.querySelector('.btn-main-estado'); 
    
    let colorClass = "text-gray-600";
    if(nuevoEstado === 'ACTIVO') colorClass = "text-green-600 font-bold";
    else if(nuevoEstado === 'VACACIONES') colorClass = "text-yellow-600 font-bold";
    else colorClass = "text-purple-600 font-bold";

    btnTexto.className = `btn-texto-estado text-xs block ${colorClass}`;
    btnTexto.innerHTML = nuevoEstado; 
    contenedorBtn.title = nuevoDetalle || "Sin detalle";

    window.marcarCambio();
    window.cerrarModalEstado();
};

// --- MODAL DE NOTAS ---
window.abrirModalNota = function(btn) {
    filaSeleccionada = btn.closest('tr');
    const notaActual = filaSeleccionada.querySelector('.nota-val').value;
    document.getElementById('texto-nota-modal').value = notaActual;
    document.getElementById('modalNota').classList.remove('hidden');
};

window.cerrarModalNota = function() {
    document.getElementById('modalNota').classList.add('hidden');
    filaSeleccionada = null;
};

window.aplicarNota = function() {
    if(!filaSeleccionada) return;
    const nuevaNota = document.getElementById('texto-nota-modal').value.trim().toUpperCase();
    filaSeleccionada.querySelector('.nota-val').value = nuevaNota;
    const icono = filaSeleccionada.querySelector('.btn-nota i');
    if(nuevaNota.length > 0) {
        icono.className = 'fas fa-sticky-note text-lg text-yellow-500 animate-pulse';
        filaSeleccionada.querySelector('.btn-nota').title = nuevaNota;
    } else {
        icono.className = 'fas fa-sticky-note text-lg text-gray-300';
        filaSeleccionada.querySelector('.btn-nota').title = "Agregar nota";
    }
    window.marcarCambio();
    window.cerrarModalNota();
};

// --- CARGA DE DATOS ---
window.cargarPorTipo = async function(tipo) {
    tipoActual = tipo;
    document.querySelectorAll('.btn-tipo').forEach(btn => {
        btn.className = 'btn-tipo p-4 border-2 border-gray-100 rounded-xl hover:border-blue-300 hover:bg-gray-50 transition-all text-center group cursor-pointer bg-white';
        if(btn.innerText.includes(tipo.toUpperCase()) || (tipo === 'Empleado' && btn.innerText.includes('EMPLEADOS'))) {
            btn.className = 'btn-tipo p-4 border-2 border-blue-500 rounded-xl bg-blue-50 transition-all text-center cursor-default shadow-md transform scale-105';
        }
    });

    if(mensajeInicio) mensajeInicio.classList.add('hidden');
    if(panelTabla) panelTabla.classList.remove('hidden');
    if(tablaBody) tablaBody.innerHTML = '<tr><td colspan="9" class="text-center py-10"><i class="fas fa-spinner fa-spin text-3xl text-blue-500"></i><br>Cargando lista...</td></tr>';

    try {
        const res = await fetch(`${API_URL}/asistencias?periodo=${periodoAsistencia}&tipo=${tipo}`, { headers: { 'Authorization': `Bearer ${tokenAsistencia}` } });
        if (!res.ok) throw new Error('Error de conexión');
        const lista = await res.json();
        renderizarTabla(lista);
    } catch (error) {
        if(tablaBody) tablaBody.innerHTML = `<tr><td colspan="9" class="text-center text-red-500 py-4 font-bold">Error: ${error.message}</td></tr>`;
    }
};

function renderizarTabla(lista) {
    if(!tablaBody) return;
    tablaBody.innerHTML = '';

    if (lista.length === 0) {
        tablaBody.innerHTML = `<tr><td colspan="9" class="text-center text-gray-500 py-10 font-medium">No se encontraron trabajadores de tipo "${tipoActual}".</td></tr>`;
        return;
    }

    lista.forEach((emp, index) => {
        const tr = document.createElement('tr');
        tr.className = "hover:bg-gray-50 border-b transition-colors group";
        tr.dataset.texto = `${emp.nombre} ${emp.apellido_paterno} ${emp.dni}`.toLowerCase();
        
        const bordeEstado = emp.tiene_registro ? 'border-l-4 border-green-500' : 'border-l-4 border-gray-300';
        tr.classList.add(...bordeEstado.split(' '));

        let colorEstado = "text-gray-600";
        if(emp.estado === 'ACTIVO') colorEstado = "text-green-600 font-bold";
        else if(emp.estado === 'VACACIONES') colorEstado = "text-yellow-600 font-bold";
        else colorEstado = "text-purple-600 font-bold";

        const colorNota = emp.nota && emp.nota.length > 0 ? 'text-yellow-500 animate-pulse' : 'text-gray-300';
        const titleNota = emp.nota || "Agregar nota";

        // === DETERMINAR DÍAS TRABAJADOS ===
        // Si ya hay registro guardado, usamos lo de la BD.
        // Si es NUEVO, usamos 30 días exactos (diasTotalesDelMes ahora vale 30 siempre).
        let valorDiasTrab = emp.tiene_registro ? emp.dias_trabajados : diasTotalesDelMes;

        tr.innerHTML = `
            <td class="px-4 py-3 text-gray-400 text-xs font-mono">${index + 1}</td>
            <td class="px-4 py-3">
                <div class="font-bold text-gray-800 text-sm uppercase flex items-center">
                    ${emp.apellido_paterno} ${emp.apellido_materno}, ${emp.nombre}
                    ${emp.tiene_registro ? '<i class="fas fa-check-circle text-green-500 ml-2" title="Guardado"></i>' : ''}
                </div>
                <div class="text-xs text-gray-500 font-mono">${emp.dni}</div>
                <input type="hidden" class="emp-id" value="${emp.empleado_id}">
            </td>
            
            <td class="p-1"><input type="number" min="0" max="30" class="input-celda dias-trab font-bold text-blue-900 bg-blue-50/50 focus:bg-white border-gray-200" value="${valorDiasTrab}" onfocus="this.select()" oninput="window.marcarCambio()"></td>
            <td class="p-1"><input type="number" min="0" max="30" class="input-celda dias-falta text-red-600 focus:bg-red-50 border-gray-200" value="${emp.dias_falta}" onfocus="this.select()" oninput="window.marcarCambio()"></td>
            <td class="p-1"><input type="number" min="0" max="30" class="input-celda dias-vac focus:bg-yellow-50 border-gray-200" value="${emp.dias_vacaciones}" onfocus="this.select()" oninput="window.marcarCambio()"></td>
            <td class="p-1"><input type="number" min="0" max="30" class="input-celda dias-lic focus:bg-purple-50 border-gray-200" value="${emp.dias_licencia}" onfocus="this.select()" oninput="window.marcarCambio()"></td>
            <td class="p-1"><input type="number" min="0" class="input-celda min-tard focus:bg-orange-50 border-gray-200" value="${emp.minutos_tardanza}" onfocus="this.select()" oninput="window.marcarCambio()"></td>
            
            <td class="p-2 text-center">
                <input type="hidden" class="nota-val" value="${emp.nota || ''}">
                <button onclick="window.abrirModalNota(this)" class="btn-nota hover:bg-gray-100 p-2 rounded-full transition-all" title="${titleNota}">
                    <i class="fas fa-sticky-note text-lg ${colorNota}"></i>
                </button>
            </td>

            <td class="p-2 text-center relative">
                <input type="hidden" class="estado-val" value="${emp.estado}">
                <input type="hidden" class="estado-det" value="${emp.estado_detalle}">
                
                <button onclick="window.abrirModalEstado(this)" title="${emp.estado_detalle || 'Sin detalle'}" class="btn-main-estado w-full h-full flex flex-col items-center justify-center p-1 rounded hover:bg-gray-100 border border-transparent hover:border-gray-300 transition-all">
                    <span class="btn-texto-estado text-xs block ${colorEstado}">${emp.estado}</span>
                    <i class="fas fa-edit text-gray-300 text-[10px] mt-1"></i>
                </button>
            </td>
        `;
        tablaBody.appendChild(tr);
    });
}

window.marcarCambio = function() {
    if (infoCambios) infoCambios.classList.remove('hidden');
};

window.guardarAsistencias = async function() {
    const btn = document.getElementById('btn-guardar');
    const filas = tablaBody.getElementsByTagName('tr');
    const datosParaEnviar = [];

    for (let tr of filas) {
        if (!tr.querySelector('.emp-id')) continue;

        datosParaEnviar.push({
            empleado_id: tr.querySelector('.emp-id').value,
            dias_trabajados: parseInt(tr.querySelector('.dias-trab').value) || 0,
            dias_falta: parseInt(tr.querySelector('.dias-falta').value) || 0,
            dias_vacaciones: parseInt(tr.querySelector('.dias-vac').value) || 0,
            dias_licencia: parseInt(tr.querySelector('.dias-lic').value) || 0,
            minutos_tardanza: parseInt(tr.querySelector('.min-tard').value) || 0,
            estado: tr.querySelector('.estado-val').value,
            estado_detalle: tr.querySelector('.estado-det').value,
            nota: tr.querySelector('.nota-val').value
        });
    }

    if (datosParaEnviar.length === 0) return;

    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i> Guardando...';

    try {
        const res = await fetch(`${API_URL}/asistencias`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenAsistencia}` },
            body: JSON.stringify({ periodo: periodoAsistencia, datos: datosParaEnviar })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.message);

        const Toast = Swal.mixin({ toast: true, position: 'top-end', showConfirmButton: false, timer: 3000, timerProgressBar: true });
        Toast.fire({ icon: 'success', title: 'Datos guardados correctamente' });

        if (infoCambios) infoCambios.classList.add('hidden');
        window.cargarPorTipo(tipoActual);

    } catch (error) { Swal.fire('Error', error.message, 'error'); } 
    finally { btn.disabled = false; btn.innerHTML = '<i class="fas fa-save mr-2"></i> GUARDAR LISTA'; }
};