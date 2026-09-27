const API_URL = '';
const token = localStorage.getItem('token');
let filtroTipoActivo = ''; // Variable global para el filtro
let conceptosCache = [];     // para sugerir columnas existentes

// Rol de cálculo: qué hace la planilla con el concepto (debe coincidir con ROLES_CONCEPTO del backend)
const ROLES = [
    { rol: 'INGRESO', op: 'Ingreso', etiqueta: 'INGRESO (suma al bruto, se prorratea por días)' },
    { rol: 'INGRESO_AFP', op: 'Ingreso', etiqueta: 'INGRESO AFP (solo si el trabajador no tiene aporte AFP)' },
    { rol: 'DESCUENTO_FIJO', op: 'Descuento', etiqueta: 'DESCUENTO FIJO (se descuenta el monto asignado)' },
    { rol: 'AFP_APORTE', op: 'Descuento', etiqueta: 'TASA AFP - APORTE OBLIGATORIO (%)' },
    { rol: 'AFP_SEGURO', op: 'Descuento', etiqueta: 'TASA AFP - PRIMA DE SEGURO (%)' },
    { rol: 'AFP_COMISION', op: 'Descuento', etiqueta: 'TASA AFP - COMISIÓN (%)' },
    { rol: 'ONP', op: 'Descuento', etiqueta: 'TASA ONP (%)' },
    { rol: 'RENTA_5TA', op: 'Descuento', etiqueta: 'RENTA 5TA (la calcula el sistema)' },
    { rol: 'JUDICIAL', op: 'Descuento', etiqueta: 'DESCUENTO JUDICIAL (módulo Judiciales)' },
    { rol: 'PRESTAMO', op: 'Descuento', etiqueta: 'PRÉSTAMO (módulo Préstamos)' },
    { rol: 'SINDICATO', op: 'Descuento', etiqueta: 'CUOTA SINDICAL (módulo Sindicatos)' },
    { rol: 'TARDANZAS_FALTAS', op: 'Descuento', etiqueta: 'TARDANZAS / FALTAS (lo calcula el sistema)' },
    { rol: 'APORTE_FIJO', op: 'Aporte', etiqueta: 'APORTE FIJO DEL EMPLEADOR (no afecta el neto)' },
    { rol: 'ESSALUD', op: 'Aporte', etiqueta: 'ESSALUD (lo calcula el sistema)' }
];
const AYUDA_ROL = {
    INGRESO: 'Aparece como columna propia en INGRESOS de la planilla, el Excel y la boleta.',
    DESCUENTO_FIJO: 'Aparece como columna propia en DESCUENTOS; se descuenta el monto asignado al trabajador.',
    APORTE_FIJO: 'Aparece como columna propia en APORTE; no se descuenta al trabajador.'
};
window.llenarRoles = function(rolSeleccionado) {
    const op = document.getElementById('in-operacion').value;
    const sel = document.getElementById('in-rol');
    const actual = rolSeleccionado || sel.value;
    sel.innerHTML = ROLES.filter(r => r.op === op).map(r => `<option value="${r.rol}">${r.etiqueta}</option>`).join('');
    if (ROLES.some(r => r.rol === actual && r.op === op)) sel.value = actual;
    actualizarAyudaRol();
};
window.actualizarAyudaRol = function() {
    const rol = document.getElementById('in-rol').value;
    document.getElementById('ayuda-rol').textContent = AYUDA_ROL[rol] || 'Rol especial: el sistema lo calcula con su propia regla (no genera columna nueva).';
};
function llenarSugerenciasColumnas() {
    const dl = document.getElementById('lista-columnas');
    if (!dl) return;
    const cols = [...new Set(conceptosCache.filter(c => c.estado === 'activo').map(c => c.columna_planilla))].sort();
    dl.innerHTML = cols.map(c => `<option value="${c}">`).join('');
}

// Periodo de trabajo ('2026-Septiembre') -> '2026-09' para el campo "Vigente desde"
const MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
function mesDelPeriodoActual() {
    const [anio, mes] = String(localStorage.getItem('periodo') || '').toLowerCase().split('-');
    const i = MESES.indexOf(mes);
    if (/^\d{4}$/.test(anio) && i >= 0) return `${anio}-${String(i + 1).padStart(2, '0')}`;
    const hoy = new Date();
    return `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}`;
}
const textoVigencia = (v) => v ? `desde ${MESES[+v.slice(5, 7) - 1].slice(0, 3)} ${v.slice(0, 4)}` : 'siempre';

// La columna acompaña al nombre mientras sean iguales (o esté vacía): al renombrar o abreviar un
// concepto, la planilla muestra el nombre nuevo. Una columna personalizada no se toca.
let nombrePrevio = '';
function sincronizarColumnaConNombre() {
    const nombre = document.getElementById('in-nombre');
    const columna = document.getElementById('in-columna');
    const actual = columna.value.trim().toUpperCase();
    if (!actual || actual === nombrePrevio) columna.value = nombre.value.trim().toUpperCase();
    nombrePrevio = nombre.value.trim().toUpperCase();
}

document.addEventListener('DOMContentLoaded', () => {
    if (!token) { window.location.href = 'login.html'; return; }
    listarConceptos();
    document.getElementById('in-nombre').addEventListener('input', sincronizarColumnaConNombre);

    // Filtro en tiempo real (Buscador + Filtro Tipo)
    const buscador = document.getElementById('buscador');
    if(buscador) {
        buscador.addEventListener('input', function() {
            aplicarFiltrosCombinados();
        });
    }
});

// --- NUEVA LÓGICA DE FILTRADO COMBINADO ---
function aplicarFiltrosCombinados() {
    const term = document.getElementById('buscador').value.toLowerCase();
    const rows = document.querySelectorAll('#tabla-body tr');
    
    rows.forEach(row => {
        // Obtenemos texto de toda la fila para búsqueda
        const textoFila = row.textContent.toLowerCase();
        
        // Obtenemos el tipo (APLICA) que está en la 3ra columna (índice 2)
        const celdaTipo = row.cells[2].textContent.toUpperCase().trim(); // Empleado, Obrero, Cas
        
        // Verificamos ambas condiciones
        const coincideTexto = textoFila.includes(term);
        const coincideFiltro = filtroTipoActivo === '' || celdaTipo === filtroTipoActivo.toUpperCase();

        if (coincideTexto && coincideFiltro) {
            row.style.display = '';
        } else {
            row.style.display = 'none';
        }
    });
}

// --- FUNCIONES DEL MODAL DE FILTRO ---
window.abrirModalFiltro = function() {
    document.getElementById('filtroModal').classList.remove('hidden');
};

window.cerrarModalFiltro = function() {
    document.getElementById('filtroModal').classList.add('hidden');
};

window.aplicarFiltro = function(tipo) {
    filtroTipoActivo = tipo; // Guardamos "Empleado", "Obrero", "CAS" o ""
    
    // Actualizamos la etiqueta visual
    const etiqueta = document.getElementById('etiqueta-filtro-activo');
    const texto = document.getElementById('texto-filtro-activo');
    
    if (filtroTipoActivo) {
        if(etiqueta) etiqueta.classList.remove('hidden');
        if(texto) texto.textContent = filtroTipoActivo.toUpperCase();
    } else {
        if(etiqueta) etiqueta.classList.add('hidden');
    }

    aplicarFiltrosCombinados(); // Ejecutamos el filtro
    cerrarModalFiltro();
};

async function listarConceptos() {
    const tbody = document.getElementById('tabla-body');
    const contador = document.getElementById('contador-registros');
    tbody.innerHTML = '<tr><td colspan="9" class="text-center py-4 text-gray-500">Cargando...</td></tr>';

    try {
        const res = await fetch(`${API_URL}/conceptos?todos=1`, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!res.ok) throw new Error('Error al cargar');
        const data = await res.json();
        conceptosCache = data;
        llenarSugerenciasColumnas();

        tbody.innerHTML = '';
        if (data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="9" class="text-center py-4 text-gray-500">No hay conceptos registrados.</td></tr>';
            if(contador) contador.textContent = '0 registros';
            return;
        }

        data.forEach(c => {
            const row = document.createElement('tr');
            row.className = 'hover:bg-gray-50 transition';
            const dataStr = JSON.stringify(c).replace(/"/g, '&quot;');
            
            // Colores
            const estadoClass = c.estado === 'activo' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800';
            const opClass = c.operacion === 'Ingreso' ? 'text-green-600' : (c.operacion === 'Descuento' ? 'text-red-600' : 'text-blue-600');
            
            let montoExtra = '';
            if (c.monto_defecto && c.monto_defecto > 0) {
                if (c.tipo_concepto === 'Porcentual') {
                    montoExtra = `<span class="text-[10px] bg-yellow-100 px-1 rounded ml-1 text-yellow-800 font-bold">${c.monto_defecto}%</span>`;
                } else {
                    montoExtra = `<span class="text-[10px] bg-slate-200 px-1 rounded ml-1 text-slate-600">S/${c.monto_defecto}</span>`;
                }
            }

            // Columna "APLICA" es clave para el filtro (Index 2)
            row.innerHTML = `
                <td class="px-4 py-3 font-mono text-gray-500 text-xs">${c.id}</td>
                <td class="px-4 py-3 font-bold text-gray-800">${c.nombre}</td>
                <td class="px-4 py-3 text-center"><span class="px-2 py-1 rounded text-xs font-bold bg-blue-50 text-blue-700 uppercase">${c.aplicacion}</span></td>
                <td class="px-4 py-3 text-center text-sm">${c.tipo_concepto} ${montoExtra}</td>
                <td class="px-4 py-3 text-center font-bold text-xs ${opClass} uppercase">${c.operacion}</td>
                <td class="px-4 py-3 text-xs"><span class="font-mono text-slate-500">${c.rol_calculo}</span><br><span class="font-bold text-slate-700">${c.columna_planilla}</span> <span class="text-slate-400">#${c.orden}</span><br><span class="text-[10px] ${c.vigente_desde ? 'text-amber-600 font-bold' : 'text-slate-400'}">vigente ${textoVigencia(c.vigente_desde)}</span></td>
                <td class="px-4 py-3 text-center text-sm font-bold ${Number(c.asignados) ? 'text-slate-800' : 'text-slate-300'}">${c.asignados}</td>
                <td class="px-4 py-3 text-center"><span class="px-2 py-1 rounded-full text-xs font-bold ${estadoClass}">${c.estado}</span></td>
                <td class="px-4 py-3 text-center">
                    <button onclick='abrirModalEditar(${dataStr})' class="text-blue-600 hover:text-blue-900 mx-1" title="Editar"><i class="fas fa-edit"></i></button>
                    ${c.estado === 'activo' ? `<button onclick="eliminarConcepto(${c.id}, ${Number(c.asignados) || 0})" class="text-red-600 hover:text-red-900 mx-1" title="Desactivar"><i class="fas fa-ban"></i></button>` : ''}
                </td>
            `;
            tbody.appendChild(row);
        });
        if(contador) contador.textContent = `${data.length} registros`;
        
        // Re-aplicar filtro por si estaba seleccionado
        aplicarFiltrosCombinados();

    } catch (error) {
        console.error(error);
        tbody.innerHTML = '<tr><td colspan="9" class="text-center py-4 text-red-500">Error de conexión.</td></tr>';
    }
}

// ----------------------------------------------------
// LÓGICA DE MODAL Y FORMULARIO
// ----------------------------------------------------
window.abrirModal = function() {
    document.getElementById('form-concepto').reset();
    document.getElementById('id-concepto').value = '';
    document.getElementById('in-estado').value = 'activo';
    document.getElementById('in-columna').value = '';
    document.getElementById('in-orden').value = '';
    document.getElementById('in-vigente-desde').value = mesDelPeriodoActual();
    nombrePrevio = '';
    llenarRoles('INGRESO');
    document.getElementById('modal-title').textContent = "REGISTRO DE CONCEPTOS";
    document.getElementById('modalConcepto').classList.remove('hidden');
    verificarTipoConcepto();
};

window.abrirModalEditar = function(data) {
    document.getElementById('id-concepto').value = data.id;
    document.getElementById('in-codigo').value = data.codigo || '';
    document.getElementById('in-nombre').value = data.nombre;
    document.getElementById('in-descripcion').value = data.descripcion || '';
    document.getElementById('in-tipo').value = data.tipo_concepto || 'Variable';
    document.getElementById('in-operacion').value = data.operacion;
    document.getElementById('in-aplicacion').value = data.aplicacion;
    document.getElementById('in-estado').value = data.estado;
    document.getElementById('in-monto-defecto').value = data.monto_defecto || '';
    document.getElementById('in-columna').value = data.columna_planilla || '';
    document.getElementById('in-orden').value = data.orden ?? '';
    document.getElementById('in-vigente-desde').value = data.vigente_desde ? data.vigente_desde.slice(0, 7) : '';
    nombrePrevio = String(data.nombre || '').trim().toUpperCase();
    llenarRoles(data.rol_calculo);

    document.getElementById('modal-title').textContent = "EDITAR CONCEPTO";
    document.getElementById('modalConcepto').classList.remove('hidden');
    verificarTipoConcepto();
};

window.cerrarModal = function() {
    document.getElementById('modalConcepto').classList.add('hidden');
};

window.verificarTipoConcepto = function() {
    const tipo = document.getElementById('in-tipo').value;
    const div = document.getElementById('div-monto-defecto');
    const label = div.querySelector('label'); 
    const input = document.getElementById('in-monto-defecto');
    
    if (tipo === 'Fijo') {
        div.classList.remove('hidden');
        label.className = "block text-xs font-bold text-green-400 uppercase tracking-wide";
        label.textContent = "Monto Fijo (S/)";
        input.className = "block w-full rounded bg-slate-800 border-green-600 text-green-400 font-bold text-right focus:ring-green-500 focus:border-green-500 text-sm p-2.5";
        input.placeholder = "0.00";
    } else if (tipo === 'Porcentual') {
        div.classList.remove('hidden');
        label.className = "block text-xs font-bold text-yellow-400 uppercase tracking-wide";
        label.textContent = "Porcentaje (%)"; 
        input.className = "block w-full rounded bg-slate-800 border-yellow-600 text-yellow-400 font-bold text-right focus:ring-yellow-500 focus:border-yellow-500 text-sm p-2.5";
        input.placeholder = "Ej: 10 o 1.5";
    } else {
        div.classList.add('hidden');
        input.value = ''; 
    }
};

window.guardarConcepto = async function() {
    const id = document.getElementById('id-concepto').value;
    const payload = {
        id: id || null,
        codigo: document.getElementById('in-codigo').value,
        nombre: document.getElementById('in-nombre').value,
        descripcion: document.getElementById('in-descripcion').value,
        tipo_concepto: document.getElementById('in-tipo').value, 
        operacion: document.getElementById('in-operacion').value,
        aplicacion: document.getElementById('in-aplicacion').value,
        estado: document.getElementById('in-estado').value,
        monto_defecto: document.getElementById('in-monto-defecto').value || 0,
        rol_calculo: document.getElementById('in-rol').value,
        columna_planilla: document.getElementById('in-columna').value.trim().toUpperCase(),
        orden: document.getElementById('in-orden').value,
        vigente_desde: document.getElementById('in-vigente-desde').value || null
    };

    if(!payload.nombre) { Swal.fire('Error', 'El nombre es obligatorio', 'warning'); return; }

    try {
        const method = id ? 'PUT' : 'POST'; 
        const urlFinal = id ? `${API_URL}/conceptos/${id}` : `${API_URL}/conceptos`;

        const res = await fetch(urlFinal, {
            method: method,
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify(payload)
        });

        if(!res.ok) throw new Error((await res.json()).message || 'Error al guardar');

        Swal.fire({ icon: 'success', title: 'Guardado', timer: 1500, showConfirmButton: false });
        cerrarModal();
        listarConceptos();

    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
};

window.eliminarConcepto = async function(id, asignados = 0) {
    const result = await Swal.fire({
        title: '¿Desactivar concepto?',
        html: asignados
            ? `<b>${asignados} trabajador(es)</b> tienen un monto asignado en este concepto.<br>Al desactivarlo <b>dejan de recibirlo en la planilla</b>.`
            : 'El concepto pasará a inactivo y dejará de procesarse en la planilla.',
        icon: 'warning',
        showCancelButton: true, confirmButtonColor: '#d33', cancelButtonColor: '#3085d6', confirmButtonText: 'Sí, desactivar'
    });

    if (result.isConfirmed) {
        try {
            const res = await fetch(`${API_URL}/conceptos/${id}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } });
            if(!res.ok) throw new Error('Error al eliminar');
            Swal.fire('Desactivado', 'El concepto ya no se procesa en la planilla.', 'success');
            listarConceptos();
        } catch (e) { Swal.fire('Error', e.message, 'error'); }
    }
};