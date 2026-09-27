const API_URL = ''; 
const token = localStorage.getItem('token');

// VARIABLE GLOBAL PARA ACUMULAR TRABAJADORES
let listaTrabajadores = [];

document.addEventListener('DOMContentLoaded', () => {
    cargarSindicatosCombo();
    listarAfiliaciones();

    // Evento Combo: Llena monto y sugiere descripción
    const selectSindicato = document.getElementById('selSindicato');
    if (selectSindicato) {
        selectSindicato.addEventListener('change', function() {
            const opcion = this.options[this.selectedIndex];
            const monto = opcion.value ? opcion.getAttribute('data-monto') : '0.00';
            const texto = opcion.value ? opcion.text : '';
            
            // Llenar inputs si existen
            const inMonto = document.getElementById('txtMonto');
            const inDesc = document.getElementById('txtDescripcion');
            if(inMonto) inMonto.value = monto;
            if(inDesc) inDesc.value = texto;
        });
    }

    // Enter en el buscador para agregar rápido
    const inputBusqueda = document.getElementById('txtTrabajadorBusqueda');
    if(inputBusqueda) {
        inputBusqueda.addEventListener('keypress', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault(); // Evitar submit del form
                buscarTrabajador();
            }
        });
    }

    const form = document.getElementById('form-asignacion');
    if (form) form.addEventListener('submit', guardarAfiliacion);
});

// ==========================================
// === LÓGICA DE LISTA ACUMULATIVA (NUEVO) ===
// ==========================================

async function buscarTrabajador() {
    const input = document.getElementById('txtTrabajadorBusqueda');
    const query = input.value.trim();
    
    if(query.length < 2) return Swal.fire('Atención', 'Escribe al menos 2 letras.', 'warning');

    try {
        const res = await fetch(`${API_URL}/api/buscar-trabajador-final?q=${query}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();

        if(data.length > 0) {
            // Tomamos el primero que coincida (mejora de UX rápida)
            const t = data[0];
            agregarALista(t);
            input.value = ''; // Limpiar input para el siguiente
            input.focus();
        } else {
            Swal.fire('No encontrado', 'No existe el trabajador.', 'error');
        }
    } catch (err) { console.error(err); }
}

function agregarALista(trabajador) {
    // 1. Validar si ya está en la lista
    const existe = listaTrabajadores.find(x => x.id === trabajador.id);
    if(existe) {
        Swal.fire({
            toast: true, position: 'top-end', icon: 'warning', 
            title: 'El trabajador ya está en la lista', showConfirmButton: false, timer: 1500
        });
        return;
    }

    // 2. Agregar al array
    listaTrabajadores.push(trabajador);

    // 3. Renderizar la tablita pequeña
    renderizarListaSeleccionados();
}

function renderizarListaSeleccionados() {
    const tbody = document.getElementById('lista-seleccionados-body');
    const contador = document.getElementById('countSeleccionados');
    const msg = document.getElementById('msgVacio');

    tbody.innerHTML = '';
    contador.innerText = listaTrabajadores.length;

    if(listaTrabajadores.length > 0) {
        msg.style.display = 'none';
        listaTrabajadores.forEach((t, index) => {
            const tr = document.createElement('tr');
            tr.className = 'border-b last:border-0 hover:bg-gray-100';
            tr.innerHTML = `
                <td class="px-2 py-1 font-mono text-xs">${t.dni}</td>
                <td class="px-2 py-1 text-xs font-bold text-gray-700">${t.nombre_completo}</td>
                <td class="px-2 py-1 text-center">
                    <button type="button" onclick="quitarDeLista(${index})" class="text-red-500 hover:text-red-700 font-bold">X</button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } else {
        msg.style.display = 'block';
    }
}

function quitarDeLista(index) {
    listaTrabajadores.splice(index, 1);
    renderizarListaSeleccionados();
}

// ==========================================
// === GUARDAR MASIVO ===
// ==========================================

async function guardarAfiliacion(e) {
    e.preventDefault();

    const sindicatoId = document.getElementById('selSindicato').value;
    const monto = document.getElementById('txtMonto').value;
    const descripcion = document.getElementById('txtDescripcion').value;
    
    if(listaTrabajadores.length === 0) return Swal.fire('Lista vacía', 'Agrega al menos un trabajador.', 'warning');
    if(!sindicatoId) return Swal.fire('Error', 'Selecciona el sindicato base.', 'warning');
    if(!descripcion) return Swal.fire('Error', 'Escribe la descripción manual.', 'warning');

    // Extraemos solo los IDs del array de objetos
    const idsTrabajadores = listaTrabajadores.map(t => t.id);

    const payload = {
        trabajadores: idsTrabajadores, // Array de IDs [1, 5, 20...]
        sindicato_id: sindicatoId,
        monto: monto,
        descripcion: descripcion
    };

    try {
        const res = await fetch(`${API_URL}/api/guardar-asignacion-final`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}` 
            },
            body: JSON.stringify(payload)
        });

        const data = await res.json();

        if(res.ok) {
            Swal.fire('Guardado', `Se afiliaron ${idsTrabajadores.length} trabajadores.`, 'success');
            cerrarModal();
            listarAfiliaciones(); // Actualizar tabla principal
        } else {
            Swal.fire('Error', data.message, 'error');
        }
    } catch (err) {
        console.error(err);
        Swal.fire('Error', 'Error de conexión', 'error');
    }
}

// ==========================================
// === LISTAR Y ELIMINAR (CRUD PRINCIPAL) ===
// ==========================================

async function listarAfiliaciones() {
    const tbody = document.getElementById('asignacion-body');
    if(!tbody) return;
    tbody.innerHTML = '<tr><td colspan="6" class="text-center py-4">Cargando...</td></tr>';

    try {
        const res = await fetch(`${API_URL}/api/listar-afiliados-sindicato`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();

        if (data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="text-center py-8 text-gray-400">Sin afiliados.</td></tr>';
            return;
        }

        let html = '';
        data.forEach(item => {
            html += `
                <tr class="bg-white border-b hover:bg-gray-50 transition">
                    <td class="px-6 py-4 font-mono text-xs text-gray-400">#${item.id_afiliacion}</td>
                    <td class="px-6 py-4 font-bold text-gray-700">${item.dni}</td>
                    <td class="px-6 py-4 font-medium text-gray-900 uppercase">${item.nombre_completo}</td>
                    <td class="px-6 py-4 font-semibold text-pink-700 uppercase bg-pink-50 rounded-lg text-xs">
                        ${item.descripcion}
                    </td>
                    <td class="px-6 py-4 text-right font-mono font-bold text-green-600">S/ ${parseFloat(item.monto).toFixed(2)}</td>
                    <td class="px-6 py-4 text-center">
                        <button onclick="eliminarAfiliacion(${item.id_afiliacion})" class="text-red-500 hover:text-red-700 transition">
                            <i class="fas fa-trash-alt"></i>
                        </button>
                    </td>
                </tr>
            `;
        });
        tbody.innerHTML = html;

    } catch (err) {
        console.error(err);
        tbody.innerHTML = '<tr><td colspan="6" class="text-center text-red-500">Error red.</td></tr>';
    }
}

function eliminarAfiliacion(id) {
    Swal.fire({
        title: '¿Eliminar?',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#d33',
        confirmButtonText: 'Sí'
    }).then(async (result) => {
        if (result.isConfirmed) {
            try {
                const res = await fetch(`${API_URL}/api/eliminar-afiliacion/${id}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                if(res.ok) listarAfiliaciones();
            } catch (err) { Swal.fire('Error', 'No se pudo eliminar', 'error'); }
        }
    })
}

// ==========================================
// === CARGAR COMBO Y UTILS ===
// ==========================================

async function cargarSindicatosCombo() {
    const select = document.getElementById('selSindicato');
    if(!select) return;

    try {
        const res = await fetch(`${API_URL}/sindicatos`, { 
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        let html = '<option value="">-- Seleccione --</option>';
        data.forEach(s => {
            if(s.estado === 'activo') {
                html += `<option value="${s.id}" data-monto="${s.monto}">${s.descripcion}</option>`;
            }
        });
        select.innerHTML = html;
    } catch (err) { console.error(err); }
}

function abrirModalAsignacion() {
    document.getElementById('form-asignacion').reset();
    listaTrabajadores = []; // RESETEAR LISTA AL ABRIR
    renderizarListaSeleccionados();
    document.getElementById('modalAsignacion').classList.remove('hidden');
}

function cerrarModal() {
    document.getElementById('modalAsignacion').classList.add('hidden');
}