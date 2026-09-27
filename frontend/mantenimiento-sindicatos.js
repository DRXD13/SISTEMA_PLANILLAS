// =======================================================
// === MANTENIMIENTO-SINDICATOS.JS (AJUSTADO AL HTML) ===
// =======================================================

const API_URL = ''; // Asegúrate de que esto coincida con tu configuración global
const token = localStorage.getItem('token'); 

// --- ALERTA VISUAL ---
const mostrarAlerta = (mensaje, icono) => {
    Swal.fire({
        title: 'Información',
        text: mensaje,
        icon: icono,
        showConfirmButton: false,
        timer: 1500
    });
};

// --- GESTIÓN DEL MODAL ---
function abrirModalSindicato(sindicato = null) {
    const formSindicato = document.getElementById('sindicato-form');
    const modalElement = document.getElementById('sindicatoModal');
    
    if (!formSindicato || !modalElement) return;

    formSindicato.reset();
    document.getElementById('sindicato-id').value = '';
    const modalLabel = document.getElementById('sindicatoModalLabel');
    const guardarBtn = document.getElementById('guardar-sindicato-btn');

    // Resetear colores del botón
    guardarBtn.classList.remove('bg-blue-600', 'hover:bg-blue-700', 'bg-green-600', 'hover:bg-green-700');

    if (sindicato && sindicato.id) { // MODO EDITAR
        modalLabel.textContent = 'Editar Sindicato';
        document.getElementById('sindicato-id').value = sindicato.id;
        document.getElementById('sindicato-descripcion').value = sindicato.descripcion;
        document.getElementById('sindicato-monto').value = sindicato.monto; 
        document.getElementById('sindicato-estado').value = sindicato.estado || 'activo';
        
        guardarBtn.textContent = 'Guardar Cambios';
        guardarBtn.classList.add('bg-blue-600', 'hover:bg-blue-700');
    } else { // MODO CREAR
        modalLabel.textContent = 'Registrar Nuevo Sindicato';
        document.getElementById('sindicato-estado').value = 'activo';
        
        guardarBtn.textContent = 'Guardar';
        guardarBtn.classList.add('bg-green-600', 'hover:bg-green-700');
    }
    
    modalElement.style.display = 'block';
    document.body.style.overflow = 'hidden';
}

function cerrarModalSindicato() {
    const modalElement = document.getElementById('sindicatoModal');
    if (modalElement) {
        modalElement.style.display = 'none';
        document.body.style.overflow = '';
        document.getElementById('sindicato-form').reset();
    }
}

// --- FUNCIONES CRUD ---

// 1. CARGAR DATOS EN LA TABLA
async function cargarSindicatos() {
    const tbody = document.getElementById('sindicatos-body');
    if(!tbody) return;
    
    tbody.innerHTML = '<tr><td colspan="5" class="px-6 py-4 text-center text-gray-500">Cargando...</td></tr>';

    try {
        if (!token) throw new Error("Sesión expirada.");

        const response = await fetch(`${API_URL}/sindicatos`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!response.ok) throw new Error('Error al cargar datos.');
        
        const sindicatos = await response.json();
        
        if (sindicatos.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="px-6 py-4 text-center text-gray-500">No hay registros.</td></tr>';
            return;
        }

        let html = '';
        sindicatos.forEach(s => {
            const estadoTexto = s.estado === 'activo' 
                ? '<span class="bg-green-100 text-green-800 text-xs font-bold px-2 py-1 rounded">ACTIVO</span>' 
                : '<span class="bg-red-100 text-red-800 text-xs font-bold px-2 py-1 rounded">INACTIVO</span>';

            html += `
                <tr class="hover:bg-gray-50 border-b">
                    <td class="px-6 py-4 font-bold text-gray-600">#${s.id}</td>
                    <td class="px-6 py-4 font-bold text-gray-800 uppercase">${s.descripcion}</td>
                    <td class="px-6 py-4 font-mono text-blue-600 font-bold">S/ ${parseFloat(s.monto || 0).toFixed(2)}</td>
                    <td class="px-6 py-4">${estadoTexto}</td>
                    <td class="px-6 py-4 flex gap-2">
                        <button onclick="prepararEditar(${s.id})" class="text-white bg-yellow-400 hover:bg-yellow-500 font-bold py-1 px-3 rounded" title="Editar"><i class="fas fa-edit"></i></button>
                        <button onclick="eliminarSindicato(${s.id})" class="text-white bg-red-600 hover:bg-red-700 font-bold py-1 px-3 rounded" title="Eliminar"><i class="fas fa-trash-alt"></i></button>
                    </td>
                </tr>
            `;
        });
        tbody.innerHTML = html;

    } catch (error) {
        tbody.innerHTML = `<tr><td colspan="5" class="px-6 py-4 text-center text-red-600">${error.message}</td></tr>`; 
    }
};

// 2. PREPARAR EDICIÓN (Buscar datos actuales)
async function prepararEditar(id) {
    try {
        // Obtenemos la lista actual de la tabla o pedimos al backend
        const response = await fetch(`${API_URL}/sindicatos`, {
             headers: { 'Authorization': `Bearer ${token}` }
        });
        const sindicatos = await response.json();
        const sindicato = sindicatos.find(s => s.id == id);

        if (sindicato) {
            abrirModalSindicato(sindicato);
        } else {
            mostrarAlerta("No se encontraron datos.", 'error');
        }
    } catch (error) {
        console.error(error);
    }
}

// 3. GUARDAR (POST/PUT)
const handleFormSubmit = async (event) => {
    event.preventDefault();
    
    const id = document.getElementById('sindicato-id').value;
    const descripcion = document.getElementById('sindicato-descripcion').value.trim();
    const monto = document.getElementById('sindicato-monto').value;
    
    if(!descripcion) return mostrarAlerta("Ingrese la descripción", "warning");

    const isEditing = !!id;
    const url = isEditing ? `${API_URL}/sindicatos/${id}` : `${API_URL}/sindicatos`; 
    const method = isEditing ? 'PUT' : 'POST';

    const data = {
        descripcion: descripcion,
        monto: monto,
        estado: document.getElementById('sindicato-estado').value
    };
    
    try {
        const response = await fetch(url, {
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`, 
            },
            body: JSON.stringify(data),
        });

        if (!response.ok) throw new Error(`Error al procesar.`);

        cerrarModalSindicato(); 
        mostrarAlerta(`Sindicato ${isEditing ? 'actualizado' : 'registrado'} con éxito.`, 'success');
        cargarSindicatos(); 

    } catch (error) {
        mostrarAlerta(error.message, 'error');
    }
};

// 4. ELIMINAR (DELETE)
async function eliminarSindicato(id) {
    Swal.fire({
        title: "¿Estás seguro?",
        text: "Se desactivará este sindicato.",
        icon: "warning",
        showCancelButton: true,
        confirmButtonColor: "#d33",
        cancelButtonColor: "#3085d6",
        confirmButtonText: "Sí, eliminar"
    }).then(async (result) => {
        if (result.isConfirmed) {
            try {
                const response = await fetch(`${API_URL}/sindicatos/${id}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${token}` }
                });

                if (response.ok) {
                    mostrarAlerta('Sindicato eliminado.', 'success');
                    cargarSindicatos(); 
                } else {
                    throw new Error('No se pudo eliminar.');
                }
            } catch (error) {
                mostrarAlerta(error.message, 'error');
            }
        }
    });
}

// --- INICIALIZACIÓN ---
document.addEventListener('DOMContentLoaded', () => {
    cargarSindicatos();

    // Evento Submit del Formulario
    const form = document.getElementById('sindicato-form');
    if (form) form.addEventListener('submit', handleFormSubmit);

    // Buscador
    const buscarInput = document.getElementById('buscar-sindicato-input');
    const buscarBtn = document.getElementById('buscar-sindicato-btn');
    
    const filtrarTabla = () => {
        const query = buscarInput.value.toLowerCase();
        const rows = document.querySelectorAll('#sindicatos-body tr');
        rows.forEach(row => {
            const texto = row.textContent.toLowerCase();
            row.style.display = texto.includes(query) ? '' : 'none';
        });
    };

    if (buscarInput) buscarInput.addEventListener('input', filtrarTabla);
    if (buscarBtn) buscarBtn.addEventListener('click', filtrarTabla);
    
    // Cerrar modal al hacer clic fuera
    const modalElement = document.getElementById('sindicatoModal');
    window.onclick = function(event) {
        if (event.target === modalElement) cerrarModalSindicato();
    }
});