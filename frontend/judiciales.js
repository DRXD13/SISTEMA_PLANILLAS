const API_URL = '';
const token = localStorage.getItem('token');

// Variable para el filtro (Por defecto TODOS)
let filtroActualTipo = 'TODOS'; 
let datosGlobales = []; 

document.addEventListener('DOMContentLoaded', () => {
    if (!token) { window.location.href = 'login.html'; return; }
    
    cargarTablaJudiciales();
    setupLiveSearch('trabajador', 'lista-trabajadores');
    setupLiveSearch('beneficiario', 'lista-beneficiarios');
    
    // Asignar evento al botón de filtro
    const btnFiltro = document.getElementById('btn-abrir-filtro');
    if(btnFiltro) btnFiltro.onclick = mostrarOpcionesFiltro;

    // BUSCAR y Enter aplican el mismo filtro (sobre los datos ya cargados).
    // Enter envía el formulario (submit implícito) y recargaría la página: lo evitamos.
    document.getElementById('btn-filtrar')?.addEventListener('click', cargarTablaJudiciales);
    document.getElementById('form-buscar-judicial')?.addEventListener('submit', (e) => {
        e.preventDefault();
        cargarTablaJudiciales();
    });
});

// ================= TABLA PRINCIPAL =================
async function cargarTablaJudiciales() {
    const tbody = document.getElementById('cuerpo-tabla-judiciales');
    tbody.innerHTML = '<tr><td colspan="5" class="text-center py-4">Cargando...</td></tr>';
    
    try {
        // 1. Cargar datos del servidor (si no hay caché)
        // OJO: Si acabas de guardar/editar, limpiamos datosGlobales para forzar recarga
        if(datosGlobales.length === 0) {
            const res = await fetch(`${API_URL}/judiciales`, { headers: { 'Authorization': `Bearer ${token}` } });
            datosGlobales = await res.json();
        }
        
        // 2. APLICAR FILTRO INTELIGENTE
        let dataFiltrada = datosGlobales;
        
        if (filtroActualTipo !== 'TODOS') {
            dataFiltrada = datosGlobales.filter(item => {
                const tipoDB = (item.tipo_contrato || '').toUpperCase();
                // Usamos INCLUDES para que si dice "CAS COVID" lo encuentre al filtrar "CAS"
                return tipoDB.includes(filtroActualTipo);
            });
        }

        // 3. FILTRO DEL BUSCADOR (POR CAMPO + DATOS DE BÚSQUEDA)
        const valorBusqueda = (document.getElementById('valor_busqueda')?.value || '').trim().toUpperCase();
        const tipoBusqueda = document.getElementById('tipo_busqueda')?.value;
        if (valorBusqueda) {
            dataFiltrada = dataFiltrada.filter(item => tipoBusqueda === 'dni'
                ? (item.dni_trabajador || '').includes(valorBusqueda)
                : (item.nombre_trabajador || '').toUpperCase().includes(valorBusqueda));
        }

        renderizarTabla(dataFiltrada);
        
    } catch (e) { 
        console.error(e);
        tbody.innerHTML = '<tr><td colspan="5" class="text-center py-4 text-red-500">Error de conexión.</td></tr>';
    }
}

function renderizarTabla(data) {
    const tbody = document.getElementById('cuerpo-tabla-judiciales');
    tbody.innerHTML = '';
        
    if (data.length === 0) { 
        tbody.innerHTML = '<tr><td colspan="5" class="text-center py-4 text-gray-500">No se encontraron registros.</td></tr>'; 
        return; 
    }
    
    data.forEach(item => {
        const row = document.createElement('tr');
        row.className = "hover:bg-gray-50 border-b align-middle";
        
        // Etiquetas de Colores
        let badgeColor = 'bg-gray-100 text-gray-800';
        if(item.tipo_judicial === 'Alimentos') badgeColor = 'bg-blue-100 text-blue-800 border border-blue-200';
        if(item.tipo_judicial === 'Defraudacion') badgeColor = 'bg-red-100 text-red-800 border border-red-200';

        const tipoTrab = (item.tipo_contrato || 'SIN TIPO').toUpperCase();
        let colorTrab = 'bg-gray-200 text-gray-700'; // Default
        
        if(tipoTrab.includes('CAS')) colorTrab = 'bg-purple-100 text-purple-700 border border-purple-200';
        if(tipoTrab.includes('EMPLEADO') || tipoTrab.includes('NOMBRADO')) colorTrab = 'bg-green-100 text-green-700 border border-green-200';
        if(tipoTrab.includes('OBRERO')) colorTrab = 'bg-orange-100 text-orange-700 border border-orange-200';

        row.innerHTML = `
            <td class="px-6 py-4 text-gray-500 font-mono text-xs">${item.id}</td>
            <td class="px-6 py-4 font-bold text-gray-700">${item.dni_trabajador}</td>
            <td class="px-6 py-4">
                <div class="font-bold text-gray-800 uppercase text-sm">${item.nombre_trabajador}</div>
                <div class="text-xs text-purple-600 mt-1 flex items-center gap-1">
                    <i class="fas fa-user-check"></i> Benef: ${item.nombre_beneficiario}
                </div>
            </td>
            <td class="px-6 py-4">
                <div class="flex flex-col gap-1 items-start">
                    <span class="${colorTrab} text-[10px] font-extrabold px-2 py-0.5 rounded uppercase tracking-wider mb-1">
                        ${tipoTrab}
                    </span>
                    <span class="${badgeColor} text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wide">
                        ${item.tipo_judicial}
                    </span>
                    <div class="font-bold text-gray-800 text-sm mt-1">
                        Descuento: ${parseFloat(item.porcentual).toFixed(2)}%
                    </div>
                    <div class="text-xs text-gray-400 italic max-w-[200px] truncate">
                        ${item.referencia || ''}
                    </div>
                </div>
            </td>
            <td class="px-6 py-4 text-center">
                <div class="flex justify-center gap-2">
                    <button onclick="editarJudicial(${item.id})" class="bg-yellow-400 hover:bg-yellow-500 text-white w-8 h-8 rounded shadow flex items-center justify-center transition" title="Editar"><i class="fas fa-pen text-xs"></i></button>
                    <button onclick="eliminarJudicial(${item.id})" class="bg-red-500 hover:bg-red-600 text-white w-8 h-8 rounded shadow flex items-center justify-center transition" title="Eliminar"><i class="fas fa-trash text-xs"></i></button>
                </div>
            </td>
        `;
        tbody.appendChild(row);
    });
}

// ================= LÓGICA DEL FILTRO (CORREGIDA) =================
async function mostrarOpcionesFiltro() {
    const { value: seleccion } = await Swal.fire({
        title: 'Filtrar por Tipo',
        input: 'select',
        inputOptions: {
            'TODOS': 'Mostrar Todos',
            'CAS': 'CAS',
            'OBRERO': 'OBRERO',
            'EMPLEADO': 'EMPLEADO'
        },
        inputPlaceholder: 'Seleccione...',
        showCancelButton: true,
        confirmButtonText: 'Filtrar',
        confirmButtonColor: '#2563eb',
        cancelButtonText: 'Cancelar',
        inputValue: filtroActualTipo
    });

    if (seleccion) {
        filtroActualTipo = seleccion;
        
        // Actualizar visualmente el botón
        const btn = document.getElementById('btn-abrir-filtro');
        if(filtroActualTipo !== 'TODOS') {
            btn.classList.remove('bg-gray-100', 'text-gray-600');
            btn.classList.add('bg-blue-600', 'text-white');
            btn.innerHTML = `<i class="fas fa-filter"></i> ${filtroActualTipo}`;
        } else {
            btn.classList.remove('bg-blue-600', 'text-white');
            btn.classList.add('bg-gray-100', 'text-gray-600');
            btn.innerHTML = `<i class="fas fa-filter"></i>`;
        }

        // Volver a renderizar con el filtro aplicado
        // NO llamamos a fetch de nuevo, usamos lo que ya tenemos en memoria (rápido)
        cargarTablaJudiciales(); 
    }
}

// ================= FUNCIONES DEL MODAL (SIN CAMBIOS) =================
function llenarDatosSeleccion(tipo, id, dni, nombre, apellido, foto) {
    document.getElementById(`id_${tipo}_sel`).value = id;
    document.getElementById(`search-${tipo}`).parentElement.classList.add('hidden');
    document.getElementById(`info-${tipo}`).classList.remove('hidden');
    document.getElementById(`txt-${tipo}`).textContent = `${dni} - ${nombre} ${apellido}`;
    const img = document.getElementById(`img-avatar-${tipo}`);
    if(foto) img.src = foto.startsWith('data:') ? foto : `data:image/jpeg;base64,${foto}`;
    else img.src = 'avatar.png';
}

window.editarJudicial = async function(id) {
    try {
        const res = await fetch(`${API_URL}/judiciales/${id}`, { headers: { 'Authorization': `Bearer ${token}` } });
        if(!res.ok) throw new Error("Error al cargar");
        const data = await res.json();

        document.getElementById('form-judicial').reset();
        limpiarSeleccion('trabajador');
        limpiarSeleccion('beneficiario');

        document.getElementById('id_judicial').value = data.id;
        document.getElementById('modal-title').textContent = "EDITAR JUDICIAL #" + data.id;

        llenarDatosSeleccion('trabajador', data.empleado_id, data.dni_trabajador, data.nom_trabajador, `${data.ape_pat_trabajador} ${data.ape_mat_trabajador}`, data.foto_trabajador);
        llenarDatosSeleccion('beneficiario', data.beneficiario_id, data.dni_beneficiario, data.nom_beneficiario, `${data.ape_pat_beneficiario} ${data.ape_mat_beneficiario}`, data.foto_beneficiario);

        document.getElementById('jud-tipo').value = data.tipo_judicial;
        document.getElementById('jud-porcentual').value = data.porcentual;
        document.getElementById('jud-referencia').value = data.referencia;

        cambiarTabJudicial('tab-trabajador');
        document.getElementById('judicialModal').classList.remove('hidden');
    } catch (e) { Swal.fire('Error', 'No se cargaron datos', 'error'); }
};

window.abrirModalJudicial = function() {
    document.getElementById('form-judicial').reset();
    document.getElementById('id_judicial').value = ''; 
    document.getElementById('modal-title').textContent = "REGISTRAR NUEVO JUDICIAL";
    limpiarSeleccion('trabajador'); limpiarSeleccion('beneficiario');
    cambiarTabJudicial('tab-trabajador');
    document.getElementById('judicialModal').classList.remove('hidden');
};
window.cerrarModalJudicial = function() { document.getElementById('judicialModal').classList.add('hidden'); };

window.cambiarTabJudicial = function(tabId) {
    document.getElementById('tab-trabajador').classList.add('hidden');
    document.getElementById('tab-beneficiario').classList.add('hidden');
    document.getElementById(tabId).classList.remove('hidden');
    const activeClass = "flex-1 py-4 text-center font-bold text-sm text-gray-700 bg-white border-t-4 border-blue-600 uppercase";
    const inactiveClass = "flex-1 py-4 text-center font-bold text-sm text-gray-500 hover:bg-gray-50 border-t-4 border-transparent uppercase";
    document.getElementById('btn-tab-trabajador').className = tabId === 'tab-trabajador' ? activeClass : inactiveClass;
    document.getElementById('btn-tab-beneficiario').className = tabId === 'tab-beneficiario' ? activeClass : inactiveClass;
};

function setupLiveSearch(tipo, listaId) {
    const input = document.getElementById(`search-${tipo}`);
    const lista = document.getElementById(listaId);
    if(!input || !lista) return;
    input.addEventListener('input', async function() {
        if (this.value.length < 2) { lista.classList.add('hidden'); return; }
        try {
            const typeBusqueda = /^\d+$/.test(this.value) ? 'dni' : 'nombre';
            const res = await fetch(`${API_URL}/buscar-persona?type=${typeBusqueda}&term=${encodeURIComponent(this.value)}`, { headers: { 'Authorization': `Bearer ${token}` } });
            const data = await res.json();
            lista.innerHTML = '';
            let resultados = tipo === 'trabajador' ? data.filter(p => p.empleado_id != null) : data;
            if (resultados.length === 0) lista.innerHTML = '<li class="px-4 py-2 text-sm text-gray-500">Sin resultados.</li>';
            else resultados.forEach(p => {
                const li = document.createElement('li');
                li.className = "px-4 py-2 hover:bg-blue-100 cursor-pointer text-sm text-gray-700 border-b flex justify-between";
                li.innerHTML = `<span><b>${p.dni}</b> - ${p.nombre} ${p.apellido_paterno}</span>`;
                li.onclick = () => seleccionarItem(tipo, p, listaId);
                lista.appendChild(li);
            });
            lista.classList.remove('hidden');
        } catch(e) { console.error(e); }
    });
    document.addEventListener('click', (e) => { if (!input.contains(e.target) && !lista.contains(e.target)) lista.classList.add('hidden'); });
}

function seleccionarItem(tipo, p, listaId) {
    llenarDatosSeleccion(tipo, tipo === 'trabajador' ? p.empleado_id : p.id, p.dni, p.nombre, `${p.apellido_paterno} ${p.apellido_materno}`, p.foto);
    document.getElementById(listaId).classList.add('hidden');
    document.getElementById(`search-${tipo}`).value = ''; 
}

window.limpiarSeleccion = function(tipo) {
    document.getElementById(`id_${tipo}_sel`).value = '';
    document.getElementById(`search-${tipo}`).parentElement.classList.remove('hidden');
    document.getElementById(`info-${tipo}`).classList.add('hidden');
    document.getElementById(`img-avatar-${tipo}`).src = 'avatar.png';
    document.getElementById(`search-${tipo}`).value = '';
    document.getElementById(`search-${tipo}`).focus();
};

async function guardarDatosBackend() {
    const idJudicial = document.getElementById('id_judicial').value;
    const data = {
        empleado_id: document.getElementById('id_trabajador_sel').value,
        beneficiario_id: document.getElementById('id_beneficiario_sel').value,
        tipo_judicial: document.getElementById('jud-tipo').value,
        porcentual: document.getElementById('jud-porcentual').value,
        referencia: document.getElementById('jud-referencia').value
    };
    if(!data.empleado_id || !data.beneficiario_id || !data.porcentual) { Swal.fire('Error', 'Faltan datos', 'warning'); return false; }
    
    // IMPORTANTISIMO: LIMPIAR CACHÉ PARA QUE RECARGUE DESDE EL SERVIDOR
    datosGlobales = []; 

    const method = idJudicial ? 'PUT' : 'POST';
    const url = idJudicial ? `${API_URL}/judiciales/${idJudicial}` : `${API_URL}/judiciales`;
    const res = await fetch(url, { method: method, headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify(data) });
    
    if(res.ok) { cargarTablaJudiciales(); return true; }
    else { Swal.fire('Error', 'No se pudo guardar', 'error'); return false; }
}

window.guardarJudicial = async function() { if(await guardarDatosBackend()) { Swal.fire('Éxito', 'Guardado', 'success'); cerrarModalJudicial(); } };
window.guardarYContinuar = async function() { 
    if(await guardarDatosBackend()) {
        const Toast = Swal.mixin({ toast: true, position: 'top-end', showConfirmButton: false, timer: 2000 });
        Toast.fire({ icon: 'success', title: 'Listo para el siguiente.' });
        document.getElementById('id_judicial').value = ''; 
        document.getElementById('modal-title').textContent = "REGISTRAR NUEVO JUDICIAL";
        limpiarSeleccion('beneficiario');
        document.getElementById('jud-porcentual').value = '';
        document.getElementById('jud-referencia').value = '';
        cambiarTabJudicial('tab-beneficiario');
    }
};
window.eliminarJudicial = async function(id) {
    if(!confirm('¿Eliminar?')) return;
    datosGlobales = [];
    await fetch(`${API_URL}/judiciales/${id}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } });
    cargarTablaJudiciales();
};