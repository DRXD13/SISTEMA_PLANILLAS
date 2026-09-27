// =======================================================
// === MANTENIMIENTO-AREA.JS (LÓGICA MAESTRA GLOBAL) ===
// =======================================================

const API_URL = '';
const token = localStorage.getItem('token'); 

// --- Mover estas funciones afuera para que 'onclick' las encuentre ---
const mostrarAlerta = (mensaje, icono) => {
    Swal.fire({
        title: 'Información',
        text: mensaje,
        icon: icono,
        showConfirmButton: false,
        timer: 1800
    });
};

function abrirModalArea(area = null) {
    const formArea = document.getElementById('area-form');
    const modalElement = document.getElementById('areaModal');
    if (!formArea || !modalElement) return;

    formArea.reset();
    document.getElementById('area-id').value = '';
    const modalLabel = document.getElementById('areaModalLabel');
    const guardarBtn = document.getElementById('guardar-area-btn');

    guardarBtn.classList.remove('bg-blue-600', 'hover:bg-blue-700', 'bg-green-600', 'hover:bg-green-700');

    if (area && area.id) { // Modo Editar
        modalLabel.textContent = 'Editar Área';
        document.getElementById('area-id').value = area.id;
        document.getElementById('area-descripcion').value = area.descripcion;
        document.getElementById('area-abreviatura').value = area.abreviatura || '';
        document.getElementById('area-anio').value = area.anio || '';
        document.getElementById('area-estado').value = area.estado;
        guardarBtn.textContent = 'Guardar Cambios';
        guardarBtn.classList.add('bg-blue-600', 'hover:bg-blue-700');
    } else { // Modo Crear
        modalLabel.textContent = 'Registrar Nueva Área';
        document.getElementById('area-estado').value = 'activo'; // Estado por defecto
        guardarBtn.textContent = 'Guardar';
        guardarBtn.classList.add('bg-green-600', 'hover:bg-green-700');
    }
    
    modalElement.style.display = 'block';
    document.body.style.overflow = 'hidden';
}

function cerrarModalArea() {
    const modalElement = document.getElementById('areaModal');
    if (modalElement) {
        modalElement.style.display = 'none';
        document.body.style.overflow = '';
        document.getElementById('area-form').reset();
        document.getElementById('area-id').value = '';
    }
}

async function abrirModalEditar(areaId) {
    document.getElementById('area-form').reset(); 
    document.getElementById('area-id').value = areaId;
    document.getElementById('areaModalLabel').textContent = 'Editar Área';
    
    // YA NO SE USA EL PERÍODO
    
    try {
        if (!token) { throw new Error("Sesión expirada. Vuelve a iniciar sesión."); }
        
        // Se consulta el ID maestro, sin período
        const response = await fetch(`${API_URL}/api/areas/${areaId}`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (response.status === 404) { throw new Error('Área no encontrada en la base de datos.'); }
        if (!response.ok) {
             const errorData = await response.json().catch(() => ({ message: `Error al obtener los datos del área.` }));
             throw new Error(errorData.message || `Error al obtener los datos del área.`);
        }
        
        const area = await response.json();
        
        document.getElementById('area-descripcion').value = area.descripcion;
        document.getElementById('area-abreviatura').value = area.abreviatura || '';
        document.getElementById('area-anio').value = area.anio || '';
        document.getElementById('area-estado').value = area.estado;

        abrirModalArea(area); // Llama a la función global con los datos

    } catch (error) {
        console.error('Error cargando datos para edición:', error);
        mostrarAlerta(error.message, 'error');
    }
}

async function eliminarArea(areaId) {
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
                const response = await fetch(`${API_URL}/api/areas/${areaId}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${token}` }
                });

                if (response.status === 404) { throw new Error('Área no encontrada.'); }
                if (!response.ok) {
                     const errorData = await response.json().catch(() => ({ message: `Error al eliminar el área.` }));
                     throw new Error(errorData.message || `Error al eliminar.`);
                }
                
                mostrarAlerta('El área ha sido eliminada.', 'success');
                cargarAreas(); 

            } catch (error) {
                console.error('Error al eliminar:', error);
                mostrarAlerta(error.message, 'error');
            }
        }
    });
}

// --- Carga y Renderizado de Tabla (CORREGIDO) ---
async function cargarAreas() {
    const areasBody = document.getElementById('areas-body');
    areasBody.innerHTML = '<tr><td colspan="6" class="px-6 py-4 text-center text-gray-500">Cargando áreas...</td></tr>';

    // YA NO SE USA EL PERÍODO
    
    if (!token) {
        console.error("Token no encontrado. Redirigiendo a login.");
        window.location.href = './login.html';
        return; 
    }
    
    try {
        // Se consulta la ruta maestra, sin período
        const response = await fetch(`${API_URL}/api/areas`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}` 
            }
        });

        if (response.status === 403) {
             throw new Error("Sesión expirada o acceso denegado. Vuelve a iniciar sesión.");
        }
        if (!response.ok) {
            throw new Error('Error al obtener la lista de áreas. Verifica que el servidor (backend) esté corriendo.');
        }
        
        const areas = await response.json();
        
        if (areas.length === 0) {
            areasBody.innerHTML = '<tr><td colspan="6" class="px-6 py-4 text-center text-gray-700">No hay áreas registradas.</td></tr>';
            return;
        }

        let html = '';
        areas.forEach(area => {
            const estadoTexto = area.estado === 'activo' 
                ? '<span class="bg-green-100 text-green-800 text-xs font-medium px-2.5 py-0.5 rounded-full">ACTIVO</span>' 
                : '<span class="bg-gray-100 text-gray-800 text-xs font-medium px-2.5 py-0.5 rounded-full">INACTIVO</span>';

            // === ¡CORRECCIÓN VISUAL DE ALINEACIÓN AÑADIDA! ===
            html += `
                <tr class="hover:bg-gray-50">
                    <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900 align-middle">${area.id}</td>
                    <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-700 align-middle">${area.descripcion}</td>
                    <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-700 align-middle">${area.abreviatura || '-'}</td>
                    <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-700 align-middle">${area.anio || '-'}</td>
                    <td class="px-6 py-4 whitespace-nowrap text-sm align-middle">${estadoTexto}</td>
                    <td class="px-6 py-4 whitespace-nowrap text-sm text-right font-medium align-middle">
                        <button onclick="abrirModalEditar(${area.id})" class="text-white bg-yellow-400 hover:bg-yellow-500 font-bold py-1 px-3 rounded-md mr-2 btn-editar" data-id="${area.id}" title="Editar">
                            <i class="fas fa-edit"></i>
                        </button>
                        <button onclick="eliminarArea(${area.id})" class="text-white bg-red-600 hover:bg-red-700 font-bold py-1 px-3 rounded-md btn-eliminar" data-id="${area.id}" title="Eliminar">
                            <i class="fas fa-trash-alt"></i>
                        </button>
                    </td>
                </tr>
            `;
        });

        areasBody.innerHTML = html;

    } catch (error) {
        console.error('Error cargando áreas:', error);
        
        let errorMessage = error.message;
        if (errorMessage.includes('expirada') || errorMessage.includes('denegado')) {
             if (typeof Swal !== 'undefined') {
                Swal.fire({
                    icon: 'error',
                    title: 'Error de Autenticación',
                    text: 'Tu sesión ha caducado.',
                    confirmButtonText: 'Ir a Login'
                }).then(() => {
                    window.location.href = './login.html';
                });
            }
        }
        
        areasBody.innerHTML = `<tr><td colspan="6" class="px-6 py-4 text-center text-red-600 font-bold">Error al cargar: ${errorMessage}</td></tr>`; 
    }
};

const handleFormSubmit = async (event) => {
    event.preventDefault();
    
    const areaId = document.getElementById('area-id').value;
    const isEditing = !!areaId;
    const method = isEditing ? 'PUT' : 'POST';
    const endpoint = isEditing ? `${API_URL}/api/areas/${areaId}` : `${API_URL}/api/areas`; 

    // YA NO SE ENVÍA EL PERÍODO
    const data = {
        descripcion: document.getElementById('area-descripcion').value,
        abreviatura: document.getElementById('area-abreviatura').value,
        anio: document.getElementById('area-anio').value ? parseInt(document.getElementById('area-anio').value) : null,
        estado: document.getElementById('area-estado').value
        // 'periodo' eliminado
    };
    
    const token = localStorage.getItem('token');
    if (!token) {
        mostrarAlerta("Sesión expirada. Redirigiendo a login.", 'error');
        window.location.href = './login.html';
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
            throw new Error(errorData.message || `Error al ${isEditing ? 'actualizar' : 'registrar'} el área.`);
        }

        cerrarModalArea(); 
        mostrarAlerta(`Área ${isEditing ? 'actualizada' : 'registrada'} con éxito.`, 'success');
        cargarAreas(); 

    } catch (error) {
        console.error('Error en el formulario:', error);
        mostrarAlerta(error.message, 'error');
    }
};


// --- Lógica de Inicialización ---
document.addEventListener('DOMContentLoaded', () => {
    cargarAreas();

    const btnNuevaArea = document.getElementById('btn-nueva-area');
    if (btnNuevaArea) {
        btnNuevaArea.addEventListener('click', () => abrirModalArea(null));
    }

    const areaForm = document.getElementById('area-form');
    if (areaForm) {
        areaForm.addEventListener('submit', handleFormSubmit);
    }
    
    // (Este listener es redundante si usas 'onclick' en el HTML, 
    // pero lo dejamos por seguridad)
    const areasBody = document.getElementById('areas-body');
    if (areasBody) {
        areasBody.addEventListener('click', (e) => {
            const target = e.target.closest('button');
            if (!target) return;
            const id = target.getAttribute('data-id');
            if (target.classList.contains('btn-editar')) {
                abrirModalEditar(id);
            } else if (target.classList.contains('btn-eliminar')) {
                eliminarArea(id);
            }
        });
    }

    const buscarAreaInput = document.getElementById('buscar-area-input');
    const areasBodyElement = document.getElementById('areas-body'); 
    const btnBuscarArea = document.getElementById('buscar-area-btn');

    const handleSearch = () => {
        const query = buscarAreaInput.value.toLowerCase();
        const rows = areasBodyElement.getElementsByTagName('tr');
        
        Array.from(rows).forEach(row => {
            if (row.cells && row.cells.length > 0) {
                const text = row.textContent.toLowerCase();
                row.style.display = text.includes(query) ? '' : 'none';
            }
        });
    };

    if (buscarAreaInput) {
        buscarAreaInput.addEventListener('input', handleSearch);
    }
    // Conecta el botón de buscar
    if (btnBuscarArea) {
        btnBuscarArea.addEventListener('click', handleSearch);
    }
    
    // Cierre del modal si se hace clic fuera
    const modalElement = document.getElementById('areaModal');
    window.onclick = function(event) {
        if (event.target === modalElement) {
            cerrarModalArea();
        }
    }
});