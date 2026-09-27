// =======================================================
// === MANTENIMIENTO-PROFESION.JS (CORREGIDO) ===
// =======================================================

const API_URL = ''; // Si usas localhost y está en el mismo puerto, déjalo vacío. Si no, 'http://localhost:3000'
const token = localStorage.getItem('token');

// Referencias del DOM
const profesionModal = document.getElementById('profesionModal');
const formProfesion = document.getElementById('form-profesion');
const tablaBody = document.getElementById('cuerpo-tabla-profesiones');
const inputBusqueda = document.getElementById('valor_busqueda_profesion');
const btnLimpiarBusqueda = document.getElementById('limpiar_busqueda_profesion');

// ==================== INICIALIZACIÓN ====================
document.addEventListener('DOMContentLoaded', () => {
    if (!token) {
        window.location.href = 'login.html';
        return;
    }

    // Cargar datos iniciales
    cargarProfesiones();

    // Listeners
    if (formProfesion) {
        formProfesion.addEventListener('submit', manejarGuardado);
    }

    if (inputBusqueda) {
        inputBusqueda.addEventListener('keyup', filtrarProfesiones);
    }

    if (btnLimpiarBusqueda) {
        btnLimpiarBusqueda.addEventListener('click', () => {
            inputBusqueda.value = '';
            filtrarProfesiones();
        });
    }
});

// ==================== LÓGICA DE DATOS ====================

async function cargarProfesiones() {
    if (!tablaBody) return;
    tablaBody.innerHTML = '<tr><td colspan="4" class="px-6 py-4 text-center text-gray-500">Cargando...</td></tr>';

    try {
        const res = await fetch(`${API_URL}/profesiones`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!res.ok) throw new Error('Error al cargar profesiones');

        const profesiones = await res.json();
        renderizarTabla(profesiones);
    } catch (error) {
        console.error(error);
        tablaBody.innerHTML = '<tr><td colspan="4" class="px-6 py-4 text-center text-red-500">Error al cargar datos.</td></tr>';
    }
}

function renderizarTabla(datos) {
    tablaBody.innerHTML = '';
    
    if (datos.length === 0) {
        tablaBody.innerHTML = '<tr><td colspan="4" class="px-6 py-4 text-center text-gray-500">No hay profesiones registradas.</td></tr>';
        return;
    }

    datos.forEach(p => {
        const row = document.createElement('tr');
        row.className = 'bg-white border-b hover:bg-gray-50';
        
        // Estilo del badge de estado
        const estadoClass = p.estado === 'activo' 
            ? 'bg-green-100 text-green-800' 
            : 'bg-red-100 text-red-800';

        // Preparamos el objeto para pasarlo al editar
        const dataStr = JSON.stringify(p).replace(/'/g, "&#39;");

        row.innerHTML = `
            <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">${p.id}</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-700">${p.descripcion}</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm">
                <span class="px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${estadoClass}">
                    ${p.estado}
                </span>
            </td>
            <td class="px-6 py-4 whitespace-nowrap text-sm font-medium">
                <button onclick='abrirModalProfesion(${dataStr})' 
                    class="bg-yellow-400 hover:bg-yellow-500 text-white font-bold py-1 px-2 rounded mr-2" 
                    title="Editar">
                    <i class="fas fa-edit"></i>
                </button>

                <button onclick="eliminarProfesion(${p.id}, '${p.descripcion}')" 
                    class="bg-red-600 hover:bg-red-700 text-white font-bold py-1 px-2 rounded" 
                    title="Eliminar">
                    <i class="fas fa-trash-alt"></i>
                </button>
            </td>
        `;
        tablaBody.appendChild(row);
    });
}

function filtrarProfesiones() {
    const texto = inputBusqueda.value.toLowerCase();
    const filas = tablaBody.getElementsByTagName('tr');

    Array.from(filas).forEach(fila => {
        // Si es la fila de "Cargando" o "No hay datos", la ignoramos
        if (fila.cells.length < 2) return;

        const descripcion = fila.cells[1].textContent.toLowerCase();
        if (descripcion.includes(texto)) {
            fila.style.display = '';
        } else {
            fila.style.display = 'none';
        }
    });
}

// ==================== LÓGICA DEL MODAL ====================

function abrirModalProfesion(data = null) {
    // Reseteamos el formulario
    formProfesion.reset();
    
    const modalTitle = document.getElementById('modal-title-profesion');
    const btnSubmit = document.getElementById('submit-button-profesion');
    const inputId = document.getElementById('profesion_id');
    const inputDesc = document.getElementById('descripcion-profesion');
    const inputEstado = document.getElementById('estado-profesion');

    if (data) {
        // MODO EDICIÓN
        modalTitle.textContent = 'Editar Profesión';
        btnSubmit.textContent = 'Actualizar';
        btnSubmit.classList.remove('bg-green-600', 'hover:bg-green-700');
        btnSubmit.classList.add('bg-blue-600', 'hover:bg-blue-700');
        
        inputId.value = data.id;
        inputDesc.value = data.descripcion;
        inputEstado.value = data.estado;
    } else {
        // MODO CREACIÓN
        modalTitle.textContent = 'Crear Nueva Profesión';
        btnSubmit.textContent = 'Guardar Profesión';
        btnSubmit.classList.remove('bg-blue-600', 'hover:bg-blue-700');
        btnSubmit.classList.add('bg-green-600', 'hover:bg-green-700');
        
        inputId.value = '';
        inputEstado.value = 'activo'; // Valor por defecto
    }

    profesionModal.style.display = 'block';
}

function cerrarModalProfesion() {
    profesionModal.style.display = 'none';
}

// ==================== GUARDAR / ACTUALIZAR ====================

async function manejarGuardado(e) {
    e.preventDefault();

    const id = document.getElementById('profesion_id').value;
    const descripcion = document.getElementById('descripcion-profesion').value.trim();
    const estado = document.getElementById('estado-profesion').value;

    if (!descripcion) {
        Swal.fire('Error', 'La descripción es obligatoria', 'warning');
        return;
    }

    const data = { descripcion, estado };
    
    // Determinar si es POST (Crear) o PUT (Editar)
    const url = id ? `${API_URL}/editar-profesion/${id}` : `${API_URL}/crear-profesion`;
    const method = id ? 'PUT' : 'POST';

    try {
        const res = await fetch(url, {
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(data)
        });

        const result = await res.json();

        if (!res.ok) throw new Error(result.message || 'Error al guardar');

        Swal.fire({
            icon: 'success',
            title: 'Éxito',
            text: result.message,
            timer: 1500,
            showConfirmButton: false
        });

        cerrarModalProfesion();
        cargarProfesiones(); // Recargar tabla

    } catch (error) {
        Swal.fire('Error', error.message, 'error');
    }
}

// ==================== ELIMINAR ====================

function eliminarProfesion(id, nombre) {
    Swal.fire({
        title: '¿Estás seguro?',
        text: `Vas a eliminar la profesión: ${nombre}`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#d33',
        cancelButtonColor: '#3085d6',
        confirmButtonText: 'Sí, eliminar',
        cancelButtonText: 'Cancelar'
    }).then(async (result) => {
        if (result.isConfirmed) {
            try {
                const res = await fetch(`${API_URL}/eliminar-profesion/${id}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${token}` }
                });

                const data = await res.json();

                if (!res.ok) throw new Error(data.message || 'No se pudo eliminar');

                Swal.fire('Eliminado', data.message, 'success');
                cargarProfesiones();

            } catch (error) {
                Swal.fire('Error', error.message, 'error');
            }
        }
    });
}

// Cerrar modal si se hace clic fuera
window.onclick = function(event) {
    if (event.target == profesionModal) {
        cerrarModalProfesion();
    }
}