const API_URL = '';
const token = localStorage.getItem('token');
let entidadesGlobal = [];

document.addEventListener('DOMContentLoaded', () => {
    if (!token) { window.location.href = 'login.html'; return; }
    cargarEntidades();

    // Configurar búsqueda
    const inputBusqueda = document.getElementById('txt-busqueda');
    if(inputBusqueda) {
        inputBusqueda.addEventListener('input', filtrarEntidades);
    }
});

// 1. LISTAR
async function cargarEntidades() {
    const tbody = document.getElementById('tabla-entidades');
    tbody.innerHTML = '<tr><td colspan="4" class="text-center py-4">Cargando...</td></tr>';
    
    try {
        const res = await fetch(`${API_URL}/entidades-financieras`, { headers: { 'Authorization': `Bearer ${token}` } });
        if(!res.ok) throw new Error("Error en la petición");
        
        entidadesGlobal = await res.json();
        renderizarTabla(entidadesGlobal);

    } catch (e) {
        console.error(e);
        tbody.innerHTML = '<tr><td colspan="4" class="text-center py-4 text-red-500">Error de conexión con el servidor.</td></tr>';
    }
}

// 2. RENDERIZAR TABLA
function renderizarTabla(data) {
    const tbody = document.getElementById('tabla-entidades');
    tbody.innerHTML = '';

    if(data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="text-center py-4 text-gray-500">No se encontraron resultados.</td></tr>';
        return;
    }

    data.forEach(item => {
        const row = document.createElement('tr');
        row.className = "hover:bg-gray-50 border-b align-middle";
        row.innerHTML = `
            <td class="px-6 py-4 text-gray-500 font-mono text-sm">${item.id}</td>
            <td class="px-6 py-4 font-bold text-gray-800 text-sm">${item.nombre}</td>
            <td class="px-6 py-4 text-center">
                <span class="badge-activo">activo</span>
            </td>
            <td class="px-6 py-4 text-center">
                <div class="flex justify-center gap-2">
                    <button onclick="editarEntidad(${item.id}, '${item.nombre}')" class="btn-action btn-edit" title="Editar">
                        <i class="fas fa-pen text-xs"></i>
                    </button>
                    <button onclick="eliminarEntidad(${item.id})" class="btn-action btn-delete" title="Eliminar">
                        <i class="fas fa-trash text-xs"></i>
                    </button>
                </div>
            </td>
        `;
        tbody.appendChild(row);
    });
}

// 3. FILTRAR
function filtrarEntidades() {
    const termino = document.getElementById('txt-busqueda').value.toLowerCase();
    const filtrados = entidadesGlobal.filter(e => e.nombre.toLowerCase().includes(termino));
    renderizarTabla(filtrados);
}

function limpiarBusqueda() {
    document.getElementById('txt-busqueda').value = '';
    renderizarTabla(entidadesGlobal);
}

// 4. MODAL
window.abrirModalEntidad = function() {
    document.getElementById('entidad_id').value = '';
    document.getElementById('txt-nombre-modal').value = '';
    document.getElementById('modal-title').textContent = 'Registro de Entidad Financiera';
    document.getElementById('entidadModal').classList.remove('hidden');
};

window.cerrarModalEntidad = function() {
    document.getElementById('entidadModal').classList.add('hidden');
};

// 5. GUARDAR
window.guardarEntidadModal = async function() {
    const id = document.getElementById('entidad_id').value;
    const nombre = document.getElementById('txt-nombre-modal').value.trim();
    
    if(!nombre) {
        Swal.fire('Atención', 'Debe escribir el nombre de la entidad', 'warning');
        return;
    }
    
    try {
        const res = await fetch(`${API_URL}/entidades-financieras`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ nombre })
        });

        if (res.ok) {
            cerrarModalEntidad();
            cargarEntidades();
            const Toast = Swal.mixin({ toast: true, position: 'top-end', showConfirmButton: false, timer: 3000 });
            Toast.fire({ icon: 'success', title: 'Operación exitosa' });
        } else {
            Swal.fire('Error', 'No se pudo guardar. Verifique si el nombre ya existe.', 'error');
        }
    } catch (e) { console.error(e); }
};

// 6. EDITAR (Visualización)
window.editarEntidad = function(id, nombre) {
    document.getElementById('entidad_id').value = id;
    document.getElementById('txt-nombre-modal').value = nombre;
    document.getElementById('modal-title').textContent = 'Editar Entidad Financiera';
    document.getElementById('entidadModal').classList.remove('hidden');
};

// 7. ELIMINAR
window.eliminarEntidad = async function(id) {
    const result = await Swal.fire({
        title: '¿Eliminar entidad?',
        text: "Esta acción no se puede deshacer.",
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#ef4444',
        cancelButtonColor: '#6b7280',
        confirmButtonText: 'Sí, eliminar',
        cancelButtonText: 'Cancelar'
    });

    if (result.isConfirmed) {
        try {
            await fetch(`${API_URL}/entidades-financieras/${id}`, { 
                method: 'DELETE', 
                headers: { 'Authorization': `Bearer ${token}` } 
            });
            cargarEntidades();
            Swal.fire('Eliminado', 'La entidad ha sido eliminada.', 'success');
        } catch (e) { console.error(e); }
    }
};