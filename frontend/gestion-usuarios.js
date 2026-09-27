const API_URL = ''; 
const token = localStorage.getItem('token');

// Verificación de seguridad básica al cargar
document.addEventListener('DOMContentLoaded', () => {
    if (!token) {
        window.location.href = 'login.html';
        return;
    }
    cargarUsuarios();
    
    const formUsuario = document.getElementById('form-nuevo-usuario');
    if(formUsuario) {
        formUsuario.addEventListener('submit', guardarNuevoUsuario);
    }
});

// --- LÓGICA DE PESTAÑAS (TABS) ---
function switchTab(tabName) {
    const tabUsuarios = document.getElementById('tab-usuarios');
    const tabRoles = document.getElementById('tab-roles');
    const btnUsuarios = document.getElementById('btn-tab-usuarios');
    const btnRoles = document.getElementById('btn-tab-roles');

    if (tabName === 'usuarios') {
        tabUsuarios.classList.remove('hidden');
        tabRoles.classList.add('hidden');
        btnUsuarios.className = "inline-flex items-center p-4 border-b-2 rounded-t-lg tab-active transition-colors";
        btnRoles.className = "inline-flex items-center p-4 border-b-2 rounded-t-lg tab-inactive transition-colors";
    } else {
        tabUsuarios.classList.add('hidden');
        tabRoles.classList.remove('hidden');
        btnRoles.className = "inline-flex items-center p-4 border-b-2 rounded-t-lg tab-active transition-colors";
        btnUsuarios.className = "inline-flex items-center p-4 border-b-2 rounded-t-lg tab-inactive transition-colors";
    }
}

// --- MODAL Y CREACIÓN DE USUARIOS ---
function abrirModalUsuario() {
    document.getElementById('form-nuevo-usuario').reset();
    document.getElementById('modal-usuario').classList.remove('hidden');
}

function cerrarModalUsuario() {
    document.getElementById('modal-usuario').classList.add('hidden');
}

async function guardarNuevoUsuario(e) {
    e.preventDefault();
    const btn = document.getElementById('btn-guardar-usr');
    btn.disabled = true;
    btn.innerHTML = 'Guardando...';

    const nuevoUsuario = {
        nombre_completo: document.getElementById('nu_nombre').value.trim(),
        correo: document.getElementById('nu_correo').value.trim(),
        password: document.getElementById('nu_password').value,
        rol: document.getElementById('nu_rol').value
    };

    try {
        const res = await fetch(`${API_URL}/api/usuarios`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify(nuevoUsuario)
        });

        const data = await res.json();

        if (res.ok) {
            Swal.fire('¡Éxito!', data.message, 'success');
            cerrarModalUsuario();
            cargarUsuarios(); // Recargamos la tabla
        } else {
            Swal.fire('Error', data.message, 'error');
        }
    } catch (err) {
        Swal.fire('Error', 'No se pudo conectar con el servidor', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = 'Guardar Usuario';
    }
}

// --- CARGA Y RENDERIZADO DE TABLA ---
async function cargarUsuarios() {
    const tbody = document.getElementById('tabla-usuarios-body');
    try {
        const res = await fetch(`${API_URL}/api/usuarios`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        if (!res.ok) throw new Error('Error al obtener la lista de usuarios');
        
        const usuarios = await res.json();
        tbody.innerHTML = '';

        if (usuarios.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="text-center py-4 text-gray-500">No hay usuarios registrados.</td></tr>';
            return;
        }

        usuarios.forEach(usr => {
            // Estilos dinámicos según el rol
            let rolClass = "bg-gray-100 text-gray-800 border-gray-200";
            if (usr.rol === 'Administrador') rolClass = "bg-purple-100 text-purple-800 border-purple-200";
            if (usr.rol === 'Gestor RRHH') rolClass = "bg-blue-100 text-blue-800 border-blue-200";
            
            // Estilos dinámicos según estado
            const esActivo = usr.estado === 'Activo';
            const estadoClass = esActivo ? "bg-green-100 text-green-800 border-green-200" : "bg-red-100 text-red-800 border-red-200";
            
            // Botón de acción (Suspender o Activar)
            const iconEstado = esActivo ? '<i class="fas fa-ban"></i>' : '<i class="fas fa-check"></i>';
            const colorEstado = esActivo ? 'text-red-600 hover:text-red-900' : 'text-green-600 hover:text-green-900';
            const tituloBoton = esActivo ? 'Suspender Acceso' : 'Reactivar Acceso';

            const fila = `
                <tr class="hover:bg-gray-50 transition-colors">
                    <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">${usr.nombre_completo || 'Sin nombre'}</td>
                    <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${usr.correo}</td>
                    <td class="px-6 py-4 whitespace-nowrap">
                        <span class="${rolClass} text-xs font-bold px-2.5 py-0.5 rounded border">${usr.rol || 'Asistente'}</span>
                    </td>
                    <td class="px-6 py-4 whitespace-nowrap">
                        <span class="${estadoClass} text-xs font-bold px-2.5 py-0.5 rounded border">${usr.estado || 'Inactivo'}</span>
                    </td>
                    <td class="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <button onclick="cambiarEstadoUsuario(${usr.id}, '${esActivo ? 'Inactivo' : 'Activo'}')" 
                                title="${tituloBoton}" 
                                class="${colorEstado}">
                            ${iconEstado}
                        </button>
                    </td>
                </tr>
            `;
            tbody.innerHTML += fila;
        });

    } catch (err) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center py-4 text-red-500">Error de conexión al cargar usuarios.</td></tr>';
    }
}

// --- CAMBIAR ESTADO (BLOQUEAR/ACTIVAR) ---
async function cambiarEstadoUsuario(id, nuevoEstado) {
    const confirmacion = await Swal.fire({
        title: `¿${nuevoEstado === 'Activo' ? 'Reactivar' : 'Suspender'} este usuario?`,
        text: nuevoEstado === 'Inactivo' ? "No podrá iniciar sesión en el sistema." : "Volverá a tener acceso al sistema.",
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: nuevoEstado === 'Activo' ? '#10b981' : '#ef4444',
        cancelButtonColor: '#6b7280',
        confirmButtonText: `Sí, ${nuevoEstado}`,
        cancelButtonText: 'Cancelar'
    });

    if (!confirmacion.isConfirmed) return;

    try {
        const res = await fetch(`${API_URL}/api/usuarios/${id}/estado`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ estado: nuevoEstado })
        });

        const data = await res.json();
        
        if (res.ok) {
            Swal.fire('Actualizado', data.message, 'success');
            cargarUsuarios(); // Recargar la tabla para ver el cambio visual
        } else {
            Swal.fire('Error', data.message, 'error');
        }
    } catch (err) {
        Swal.fire('Error', 'No se pudo contactar con el servidor.', 'error');
    }
}