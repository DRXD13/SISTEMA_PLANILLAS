// =======================================================
// === MANTENIMIENTO-GRUPO-OCUPACIONAL.JS (LÓGICA MAESTRA GLOBAL) ===
// =======================================================
const API_URL = '';
const token = localStorage.getItem('token');
const grupoModal = document.getElementById('grupoModal');
const formGrupo = document.getElementById('form-grupo');
const tablaBody = document.getElementById('grupos-body');
const buscarInput = document.getElementById('buscar-grupo-input');

// --- Seguridad ---
if (!token) {
    Swal.fire({
        icon: 'warning', title: 'No Autenticado',
        text: 'Tu sesión ha expirado. Vuelve a iniciar sesión.',
        confirmButtonText: 'Ir a Login'
    }).then(() => { window.location.href = './login.html'; });
}

// --- Alerta ---
function mostrarAlerta(mensaje, icono = 'info') {
    Swal.fire({ title: 'Información', text: mensaje, icon: icono, timer: 1800, showConfirmButton: false });
}

// --- Lógica del Modal (Funciones Globales para onclick) ---
function abrirModalGrupo(grupo = null) {
    if (!formGrupo || !grupoModal) return;
    formGrupo.reset(); // Limpia el formulario
    document.getElementById('grupo-id').value = ''; // Limpia ID oculto
    const modalLabel = document.getElementById('grupoModalLabel');
    const guardarBtn = document.getElementById('guardar-grupo-btn');

    guardarBtn.classList.remove('bg-blue-600', 'hover:bg-blue-700', 'bg-green-600', 'hover:bg-green-700');

    if (grupo && grupo.id) { // Modo Editar
        modalLabel.textContent = 'Editar Grupo Ocupacional';
        document.getElementById('grupo-id').value = grupo.id;
        document.getElementById('grupo-ocasional').value = grupo.grupo_ocasional || '';
        document.getElementById('grupo-nivel').value = grupo.nivel_remunerativo || '';
        document.getElementById('grupo-ds').value = grupo.ds_320_2022_ef || '';
        document.getElementById('grupo-estado').value = grupo.estado || 'activo';
        guardarBtn.textContent = 'Guardar Cambios';
        guardarBtn.classList.add('bg-blue-600', 'hover:bg-blue-700');
    } else { // Modo Crear
        modalLabel.textContent = 'Registrar Nuevo Grupo Ocupacional';
        document.getElementById('grupo-estado').value = 'activo'; // Estado por defecto
        guardarBtn.textContent = 'Guardar';
        guardarBtn.classList.add('bg-green-600', 'hover:bg-green-700');
    }
    grupoModal.style.display = 'block'; // Muestra el modal
    document.body.style.overflow = 'hidden'; // Evita scroll de fondo
}

function cerrarModalGrupo() {
    if (!grupoModal) return;
    grupoModal.style.display = 'none';
    document.body.style.overflow = '';
    if (formGrupo) formGrupo.reset();
}

async function eliminarGrupo(id, descripcion) {
    Swal.fire({
        title: '¿Estás seguro?',
        text: `Se eliminará el grupo: ${descripcion}`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#d33',
        cancelButtonColor: '#3085d6',
        confirmButtonText: 'Sí, eliminar',
        cancelButtonText: 'Cancelar'
    }).then(async (result) => {
        if (result.isConfirmed) {
            try {
                if (!token) { throw new Error("Sesión expirada."); }

                // YA NO SE ENVÍA EL PERÍODO
                const response = await fetch(`${API_URL}/grupos-ocupacionales/${id}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${token}` }
                });

                if (response.status === 401 || response.status === 403) {
                    window.location.href = 'login.html'; return;
                }
                
                const responseData = await response.json();
                if (!response.ok) {
                    throw new Error(responseData.message || `Error al eliminar.`);
                }

                mostrarAlerta(responseData.message, 'success');
                cargarGrupos();

            } catch (error) {
                console.error('Error al eliminar:', error);
                mostrarAlerta(error.message, 'error');
            }
        }
    });
}

// --- Carga y Renderizado de Tabla (CORREGIDO SIN PERÍODO) ---
async function cargarGrupos() {
    if (!tablaBody) return;
    tablaBody.innerHTML = '<tr><td colspan="6" class="px-6 py-4 text-center text-gray-500">Cargando...</td></tr>';

    // YA NO SE USA EL PERÍODO
    // const periodo = localStorage.getItem('periodo'); // <--- ELIMINADO
    
    try {
        // Se llama a la ruta global, sin período
        const response = await fetch(`${API_URL}/grupos-ocupacionales`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (response.status === 401 || response.status === 403) throw new Error("Sesión expirada.");
        if (!response.ok) throw new Error(`Error ${response.status} al cargar.`);

        const grupos = await response.json();
        renderizarTabla(grupos);

    } catch (error) {
        console.error('Error cargando grupos:', error);
        tablaBody.innerHTML = `<tr><td colspan="6" class="px-6 py-4 text-center text-red-500 font-bold">Error: ${error.message}</td></tr>`;
        if (error.message === "Sesión expirada.") {
            setTimeout(() => window.location.href = './login.html', 2000);
        }
    }
}

function renderizarTabla(grupos) {
    if (!tablaBody) return;
    tablaBody.innerHTML = ''; // Limpia tabla

    if (!grupos || grupos.length === 0) {
        tablaBody.innerHTML = '<tr><td colspan="6" class="px-6 py-4 text-center text-gray-700">No hay grupos registrados.</td></tr>';
        return;
    }

    grupos.forEach(grupo => {
        const estadoTexto = grupo.estado === 'activo'
            ? '<span class="bg-green-100 text-green-800 text-xs font-medium px-2.5 py-0.5 rounded-full">ACTIVO</span>'
            : '<span class="bg-gray-100 text-gray-800 text-xs font-medium px-2.5 py-0.5 rounded-full">INACTIVO</span>';

        const grupoJson = JSON.stringify(grupo).replace(/"/g, "&quot;");
        const nombreGrupo = (grupo.grupo_ocasional || '').replace(/"/g, "&quot;");

        // === ¡CORRECCIÓN VISUAL Y BOTÓN ELIMINAR AÑADIDO! ===
        const row = `
            <tr class="hover:bg-gray-50">
                <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900 align-middle">${grupo.id}</td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-700 align-middle">${grupo.grupo_ocasional}</td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-700 align-middle">${grupo.nivel_remunerativo || '-'}</td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-700 align-middle">${grupo.ds_320_2022_ef || '-'}</td>
                <td class="px-6 py-4 whitespace-nowrap text-sm align-middle">${estadoTexto}</td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-left font-medium align-middle">
                    <button onclick='abrirModalGrupo(${grupoJson})'
                        class="text-white bg-yellow-400 hover:bg-yellow-500 font-bold py-1 px-3 rounded-md mr-2" title="Editar">
                        <i class="fas fa-edit"></i>
                    </button>
                    <button onclick='eliminarGrupo(${grupo.id}, "${nombreGrupo}")'
                        class="text-white bg-red-600 hover:bg-red-700 font-bold py-1 px-3 rounded-md" title="Eliminar">
                        <i class="fas fa-trash-alt"></i>
                    </button>
                </td>
            </tr>
        `;
        tablaBody.innerHTML += row;
    });
    
    if (buscarInput && buscarInput.value) {
        filtrarTabla();
    }
}

// --- Lógica CRUD (Crear/Editar) (CORREGIDA SIN PERÍODO) ---
formGrupo.addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = document.getElementById('grupo-id').value;
    const esEdicion = !!id;
    const method = esEdicion ? 'PUT' : 'POST';
    const endpoint = esEdicion ? `${API_URL}/grupos-ocupacionales/${id}` : `${API_URL}/grupos-ocupacionales`;

    // YA NO SE ENVÍA EL PERÍODO
    const data = {
        grupo_ocasional: document.getElementById('grupo-ocasional').value.trim(),
        nivel_remunerativo: document.getElementById('grupo-nivel').value.trim() || null,
        ds_320_2022_ef: document.getElementById('grupo-ds').value || null,
        estado: document.getElementById('grupo-estado').value
        // periodo: localStorage.getItem('periodo') // <--- ELIMINADO
    };

    if (!data.grupo_ocasional) {
        mostrarAlerta('El campo "Grupo Ocupacional" es obligatorio.', 'warning');
        return;
    }

    if (data.ds_320_2022_ef && isNaN(parseFloat(data.ds_320_2022_ef))) {
        mostrarAlerta('El campo "DS 320-2022-EF" debe ser un número válido (puede incluir decimales).', 'warning');
        return;
    }

    const guardarBtn = document.getElementById('guardar-grupo-btn');
    guardarBtn.disabled = true;

    try {
        const response = await fetch(endpoint, {
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(data)
        });

        if (response.status === 401 || response.status === 403) throw new Error("Sesión expirada.");

        const responseData = await response.json(); 

        if (!response.ok) {
            throw new Error(responseData.message || `Error ${response.status} al guardar.`);
        }

        mostrarAlerta(responseData.message, 'success');
        cerrarModalGrupo();
        cargarGrupos();

    } catch (error) {
        console.error('Error al guardar:', error);
        mostrarAlerta(error.message, 'error');
        if (error.message === "Sesión expirada.") {
            setTimeout(() => window.location.href = './login.html', 2000);
        }
    } finally {
        guardarBtn.disabled = false;
    }
});

// --- Lógica de Búsqueda (Filtrado en el cliente) ---
function filtrarTabla() {
    if (!buscarInput || !tablaBody) return;
    const query = buscarInput.value.toLowerCase().trim();
    const rows = tablaBody.getElementsByTagName('tr');

    Array.from(rows).forEach(row => {
        if (row.cells.length > 1 && row.cells[1]) {
            const grupoText = row.cells[1].textContent.toLowerCase();
            row.style.display = grupoText.includes(query) ? '' : 'none';
        } else if (query === '') {
            row.style.display = '';
        } else {
            row.style.display = 'none';
        }
    });
}

// --- Inicialización ---
document.addEventListener('DOMContentLoaded', () => {
    cargarGrupos();
    
    if (buscarInput) {
        buscarInput.addEventListener('input', filtrarTabla); // Filtrar mientras se escribe
    }
    
    const btnNuevo = document.getElementById('btn-nuevo-grupo');
    if(btnNuevo) {
        btnNuevo.addEventListener('click', () => abrirModalGrupo(null));
    }

    window.onclick = function(event) {
        if (event.target === grupoModal) {
            cerrarModalGrupo();
        }
    }
});