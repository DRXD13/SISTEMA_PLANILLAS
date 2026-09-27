// =======================================================
// === MANTENIMIENTO-CARGOS.JS (LÓGICA MAESTRA GLOBAL) ===
// =======================================================

const API_URL = '';
const token = localStorage.getItem('token');
const cargoModal = document.getElementById('cargoModal');
const formCargo = document.getElementById('cargo-form');
const buscarCargoInput = document.getElementById('buscar-cargo-input');
const tablaCargosBody = document.getElementById('cargos-body');

// --- Seguridad ---
if (!token) {
    Swal.fire({
        icon: 'warning', title: 'No Autenticado',
        text: 'Tu sesión ha expirado. Vuelve a iniciar sesión.',
        confirmButtonText: 'Ir a Login'
    }).then(() => { window.location.href = './login.html'; });
}

// --- Alerta ---
function mostrarAlerta(mensaje, icono) {
    Swal.fire({
        title: 'Información',
        text: mensaje,
        icon: icono,
        showConfirmButton: false,
        timer: 1800
    });
}

// --- Lógica del Modal (Funciones Globales para onclick) ---
// (Estas funciones deben estar fuera de 'DOMContentLoaded'
// para que los 'onclick' del HTML las encuentren)

function abrirModalCargo(cargo = null) {
    if (!formCargo || !cargoModal) return;
    formCargo.reset();
    document.getElementById('cargo-id').value = '';

    const modalTitle = document.getElementById('cargoModalLabel');
    const submitBtn = document.getElementById('guardar-cargo-btn');

    submitBtn.classList.remove('bg-blue-600', 'hover:bg-blue-700', 'bg-green-600', 'hover:bg-green-700');

    if (cargo && cargo.id) {
        modalTitle.textContent = 'Editar Cargo';
        document.getElementById('cargo-id').value = cargo.id;
        document.getElementById('cargo-descripcion').value = cargo.descripcion;
        document.getElementById('cargo-anio').value = cargo.anio;
        document.getElementById('cargo-estado').value = cargo.estado;
        submitBtn.textContent = 'Guardar Cambios';
        submitBtn.classList.add('bg-blue-600', 'hover:bg-blue-700');
    } else {
        modalTitle.textContent = 'Registrar Nuevo Cargo';
        document.getElementById('cargo-estado').value = 'activo'; // Estado por defecto
        submitBtn.textContent = 'Guardar Cargo';
        submitBtn.classList.add('bg-green-600', 'hover:bg-green-700');
    }

    cargoModal.style.display = 'block';
    document.body.style.overflow = 'hidden';
}

function cerrarModalCargo() {
    if (!cargoModal) return;
    cargoModal.style.display = 'none';
    document.body.style.overflow = '';
    if (formCargo) formCargo.reset();
}

async function cambiarEstadoCargo(cargo) {
    const nuevoEstado = cargo.estado === 'activo' ? 'inactivo' : 'activo';

    // YA NO SE ENVÍA EL PERÍODO
    const datosActualizados = {
        ...cargo, // Esto incluye id, descripcion, anio
        estado: nuevoEstado
        // 'periodo' eliminado
    };
    
    delete datosActualizados.id; // El ID solo va en la URL

    try {
        const res = await fetch(`${API_URL}/cargos/${cargo.id}`, { // La URL es global
            method: 'PUT',
            headers: { 
                'Content-Type': 'application/json', 
                'Authorization': `Bearer ${token}` 
            },
            body: JSON.stringify(datosActualizados) 
        });

        if (res.status === 401 || res.status === 403) {
            window.location.href = 'login.html';
            return;
        }

        if (!res.ok) {
            let errorMessage = `Error ${res.status} al actualizar estado.`;
            try {
                const errorData = await res.json();
                errorMessage = errorData.message || errorMessage;
            } catch (jsonError) {
                errorMessage += `: ${res.statusText}`;
            }
            throw new Error(errorMessage);
        }
        mostrarAlerta(`Estado actualizado a ${nuevoEstado}.`, 'success');
        cargarCargos();
    } catch (err) {
        console.error('Error:', err);
        mostrarAlerta(err.message, 'error');
    }
}

async function eliminarCargo(cargoId) {
    Swal.fire({
        title: "¿Estás seguro?",
        text: "¡No podrás revertir esta acción!",
        icon: "warning",
        showCancelButton: true,
        confirmButtonColor: "#d33",
        cancelButtonColor: "#3085d6",
        confirmButtonText: "Sí, eliminar",
        cancelButtonText: "Cancelar"
    }).then(async (result) => {
        if (result.isConfirmed) {
            try {
                if (!token) { throw new Error("Sesión expirada."); }

                // YA NO SE ENVÍA EL PERÍODO
                const response = await fetch(`${API_URL}/cargos/${cargoId}`, {
                    method: 'DELETE',
                    headers: {
                        'Authorization': `Bearer ${token}`
                    }
                });

                if (response.status === 404) { throw new Error('Cargo no encontrado.'); }
                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({ message: `Error al eliminar el cargo.` }));
                    throw new Error(errorData.message || `Error al eliminar.`);
                }

                mostrarAlerta('El cargo ha sido eliminado.', 'success');
                cargarCargos();

            } catch (error) {
                console.error('Error al eliminar:', error);
                mostrarAlerta(error.message, 'error');
            }
        }
    });
}


// --- Carga y Renderizado de Tabla (CORREGIDO) ---
async function cargarCargos() {
    tablaCargosBody.innerHTML = '<tr><td colspan="5" class="px-6 py-4 text-center text-gray-500">Cargando cargos...</td></tr>';

    // ==================================================
    // === 1. CAMBIO: LÓGICA DE PERÍODO ELIMINADA ===
    // ==================================================
    // const periodo = localStorage.getItem('periodo'); // <--- ELIMINADO
    if (!token) {
        window.location.href = 'login.html';
        return;
    }
    // (Validación de período eliminada)
    // ================================================
    
    try {
        // ✅ CAMBIO AQUÍ: Se llama a la ruta global (sin período)
        const response = await fetch(`${API_URL}/cargos`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (response.status === 403) {
            throw new Error("Sesión expirada o acceso denegado.");
        }
        if (!response.ok) {
            throw new Error('Error al obtener la lista de cargos.');
        }

        const cargos = await response.json();

        if (cargos.length === 0) {
            // ✅ CAMBIO AQUÍ: Mensaje actualizado
            tablaCargosBody.innerHTML = '<tr><td colspan="5" class="px-6 py-4 text-center text-gray-700">No hay cargos registrados.</td></tr>';
            return;
        }

        const html = cargos.map(cargo => {
            const cargoJson = JSON.stringify(cargo).replace(/"/g, '&quot;');
            const estadoBtnClass = cargo.estado === 'activo' ? 'bg-green-500 hover:bg-green-600' : 'bg-red-500 hover:bg-red-600';
            const estadoBtnText = cargo.estado === 'activo' ? 'Activo' : 'Inactivo';

            // Mantenemos la corrección de alineación
            return `
                <tr class="hover:bg-gray-50">
                    <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900 align-middle">${cargo.id}</td>
                    <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-700 align-middle">${cargo.descripcion}</td>
                    <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-700 align-middle">${cargo.anio}</td>
                    <td class="px-6 py-4 whitespace-nowrap text-sm align-middle">
                        <button onclick='cambiarEstadoCargo(${cargoJson})' class="text-white font-bold py-1 px-3 rounded-full text-xs ${estadoBtnClass}">
                            ${estadoBtnText}
                        </button>
                    </td>
                    <td class="px-6 py-4 whitespace-nowrap text-sm text-right font-medium align-middle">
                        <button onclick='abrirModalCargo(${cargoJson})' class="text-white bg-yellow-400 hover:bg-yellow-500 font-bold py-1 px-3 rounded-md mr-2" title="Editar">
                            <i class="fas fa-edit"></i>
                        </button>
                        <button onclick='eliminarCargo(${cargo.id})' class="text-white bg-red-600 hover:bg-red-700 font-bold py-1 px-3 rounded-md" title="Eliminar">
                            <i class="fas fa-trash-alt"></i>
                        </button>
                    </td>
                </tr>
            `;
        }).join('');

        tablaCargosBody.innerHTML = html;

    } catch (error) {
        console.error('Error cargando cargos:', error);
        if (error.message.includes('expirada') || error.message.includes('denegado')) {
            Swal.fire({
                icon: 'error',
                title: 'Error de Autenticación',
                text: 'Tu sesión ha caducado. Vuelve a iniciar sesión.',
                confirmButtonText: 'Ir a Login'
            }).then(() => {
                window.location.href = './login.html';
            });
        }
        tablaCargosBody.innerHTML = `<tr><td colspan="5" class="px-6 py-4 text-center text-red-600 font-bold">Error al cargar: ${error.message}</td></tr>`;
    }
}

// --- Lógica CRUD (Crear/Editar) (CORREGIDO) ---
formCargo.addEventListener('submit', async (e) => {
    e.preventDefault();
    const cargoId = document.getElementById('cargo-id').value;
    const isEditing = !!cargoId;
    const method = isEditing ? 'PUT' : 'POST';
    const endpoint = isEditing ? `${API_URL}/cargos/${cargoId}` : `${API_URL}/cargos`;

    // ==================================================
    // === 2. CAMBIO: PERÍODO ELIMINADO DEL OBJETO data ===
    // ==================================================
    const data = {
        descripcion: document.getElementById('cargo-descripcion').value,
        anio: parseInt(document.getElementById('cargo-anio').value),
        estado: document.getElementById('cargo-estado').value
        // periodo: localStorage.getItem('periodo') // <--- ELIMINADO
    };
    // ================================================

    if (!token) {
        mostrarAlerta("Sesión expirada. Redirigiendo a login.", 'error');
        window.location.href = './login.html';
        return;
    }
    
    if (isNaN(data.anio) || data.anio < 1900 || data.anio > 2100) {
         mostrarAlerta("Por favor, ingrese un año válido (ej: 2025).", 'warning');
         return;
    }

    try {
        const response = await fetch(endpoint, {
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify(data),
        });

        if (response.status === 403) {
            throw new Error("Acceso denegado. Token no válido o expirado.");
        }

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ message: `Error del servidor: ${response.statusText}` }));
            throw new Error(errorData.message || `Error al ${isEditing ? 'actualizar' : 'registrar'} el cargo.`);
        }

        cerrarModalCargo();
        mostrarAlerta(`Cargo ${isEditing ? 'actualizado' : 'registrado'} con éxito.`, 'success');
        cargarCargos();

    } catch (error) {
        console.error('Error en el formulario:', error);
        mostrarAlerta(error.message, 'error');
    }
});


// --- Lógica de Búsqueda y Eventos ---
document.addEventListener('DOMContentLoaded', () => {
    cargarCargos();

    buscarCargoInput.addEventListener('input', () => {
        const query = buscarCargoInput.value.toLowerCase();
        const rows = tablaCargosBody.getElementsByTagName('tr');

        Array.from(rows).forEach(row => {
            if (row.cells && row.cells.length > 0) {
                const text = row.textContent.toLowerCase();
                row.style.display = text.includes(query) ? '' : 'none';
            }
        });
    });

    document.getElementById('btn-nuevo-cargo').addEventListener('click', () => {
        abrirModalCargo();
    });

    window.onclick = function(event) {
        if (event.target === cargoModal) {
            cerrarModalCargo();
        }
    }
});