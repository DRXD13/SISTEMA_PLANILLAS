// =======================================================
// === MANTENIMIENTO SISTEMAS PENSIONES JS ===
// =======================================================

const API_URL = ''; 

window.mostrarAlerta = (mensaje, icono) => {
    Swal.fire({ title: 'Información', text: mensaje, icon: icono, showConfirmButton: false, timer: 1500 });
};

// --- MODAL ---
window.abrirModalSistema = (data = null) => {
    const modal = document.getElementById('sistemaModal');
    const form = document.getElementById('form-sistema');
    if (!form || !modal) return;

    form.reset();
    const title = document.getElementById('modalLabel');
    const btn = document.getElementById('btn-guardar');

    if (data) {
        title.textContent = 'Editar Sistema';
        document.getElementById('sistema-id').value = data.id;
        document.getElementById('sistema-descripcion').value = data.descripcion;
        document.getElementById('sistema-estado').value = data.estado;
        btn.textContent = 'Actualizar';
        btn.className = "bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded shadow-md";
    } else {
        title.textContent = 'Registrar Sistema';
        document.getElementById('sistema-id').value = '';
        document.getElementById('sistema-estado').value = 'activo';
        btn.textContent = 'Guardar';
        btn.className = "bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-4 rounded shadow-md";
    }
    modal.style.display = 'block';
};

window.cerrarModalSistema = () => {
    document.getElementById('sistemaModal').style.display = 'none';
};

// --- BUSCADOR ---
window.filtrarSistemas = () => {
    const input = document.getElementById('buscar-sistema-input');
    const query = input.value.toLowerCase();
    const rows = document.querySelectorAll('#cuerpo-tabla-sistemas tr');

    rows.forEach(row => {
        // Ignoramos filas de carga o vacías si no tienen celdas
        if(row.cells.length < 2) return;
        
        const texto = row.cells[1].textContent.toLowerCase(); // Columna Descripción
        if (texto.includes(query)) {
            row.style.display = '';
        } else {
            row.style.display = 'none';
        }
    });
};

// --- CRUD ---
window.cargarSistemas = async () => {
    const tbody = document.getElementById('cuerpo-tabla-sistemas');
    tbody.innerHTML = '<tr><td colspan="4" class="px-6 py-4 text-center text-gray-500">Cargando...</td></tr>';
    const token = localStorage.getItem('token');

    try {
        const res = await fetch(`${API_URL}/sistemas-pensiones`, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!res.ok) throw new Error('Error al cargar');
        const datos = await res.json();

        if (datos.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="px-6 py-4 text-center text-gray-700">No hay registros.</td></tr>';
            return;
        }

        let html = '';
        datos.forEach(item => {
            const json = JSON.stringify(item).replace(/"/g, '&quot;');
            const estadoBadge = item.estado === 'activo' 
                ? '<span class="bg-green-100 text-green-800 text-xs font-medium px-2.5 py-0.5 rounded-full">ACTIVO</span>'
                : '<span class="bg-red-100 text-red-800 text-xs font-medium px-2.5 py-0.5 rounded-full">INACTIVO</span>';

            html += `
                <tr class="hover:bg-gray-50 border-b">
                    <td class="px-6 py-4 text-sm text-gray-900">${item.id}</td>
                    <td class="px-6 py-4 text-sm text-gray-700 font-medium">${item.descripcion}</td>
                    <td class="px-6 py-4 text-center">${estadoBadge}</td>
                    <td class="px-6 py-4 text-center">
                        <button onclick='window.abrirModalSistema(${json})' class="text-white bg-yellow-400 hover:bg-yellow-500 font-bold py-1 px-3 rounded mr-2"><i class="fas fa-edit"></i></button>
                        <button onclick='window.eliminarSistema(${item.id})' class="text-white bg-red-600 hover:bg-red-700 font-bold py-1 px-3 rounded"><i class="fas fa-trash-alt"></i></button>
                    </td>
                </tr>`;
        });
        tbody.innerHTML = html;
    } catch (e) {
        console.error(e);
        tbody.innerHTML = `<tr><td colspan="4" class="text-center text-red-500 p-4">${e.message}</td></tr>`;
    }
};

document.getElementById('form-sistema').addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = localStorage.getItem('token');
    const id = document.getElementById('sistema-id').value;
    const method = id ? 'PUT' : 'POST';
    const url = id ? `${API_URL}/sistemas-pensiones/${id}` : `${API_URL}/sistemas-pensiones`;

    const data = {
        descripcion: document.getElementById('sistema-descripcion').value.toUpperCase(),
        estado: document.getElementById('sistema-estado').value
    };

    try {
        const res = await fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify(data)
        });
        if (!res.ok) throw new Error('Error al guardar');
        window.cerrarModalSistema();
        window.mostrarAlerta('Guardado correctamente', 'success');
        window.cargarSistemas();
    } catch (e) {
        window.mostrarAlerta(e.message, 'error');
    }
});

window.eliminarSistema = (id) => {
    Swal.fire({
        title: "¿Eliminar?", text: "No podrás revertir esto.", icon: "warning",
        showCancelButton: true, confirmButtonColor: "#d33", confirmButtonText: "Sí, eliminar"
    }).then(async (r) => {
        if (r.isConfirmed) {
            try {
                const token = localStorage.getItem('token');
                const res = await fetch(`${API_URL}/sistemas-pensiones/${id}`, {
                    method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` }
                });
                if (!res.ok) throw new Error('Error al eliminar');
                window.mostrarAlerta('Eliminado', 'success');
                window.cargarSistemas();
            } catch (e) { window.mostrarAlerta(e.message, 'error'); }
        }
    });
};

// Init
document.addEventListener('DOMContentLoaded', () => {
    window.cargarSistemas();
    
    // Listener para el buscador
    const searchInput = document.getElementById('buscar-sistema-input');
    if(searchInput) {
        searchInput.addEventListener('keyup', window.filtrarSistemas);
    }

    window.onclick = (e) => {
        if (e.target === document.getElementById('sistemaModal')) window.cerrarModalSistema();
    };
});