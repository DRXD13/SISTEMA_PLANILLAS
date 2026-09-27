// =======================================================
// === MANTENIMIENTO META JS ===
// =======================================================

const API_URL = ''; 

window.mostrarAlerta = (mensaje, icono) => {
    Swal.fire({ title: 'Información', text: mensaje, icon: icono, showConfirmButton: false, timer: 1500 });
};

// --- MODAL ---
window.abrirModalMeta = (data = null) => {
    const modal = document.getElementById('metaModal');
    const form = document.getElementById('form-meta');
    if (!form || !modal) return;

    form.reset();
    const title = document.getElementById('modalLabel');
    const btn = document.getElementById('btn-guardar');

    if (data) {
        title.textContent = 'Editar Meta';
        document.getElementById('meta-id').value = data.id;
        document.getElementById('meta-codigo').value = data.meta; // Carga el código
        document.getElementById('meta-descripcion').value = data.descripcion;
        document.getElementById('meta-anio').value = data.anio;
        document.getElementById('meta-estado').value = data.estado;
        btn.textContent = 'Actualizar';
        btn.className = "bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded shadow-md";
    } else {
        title.textContent = 'Registrar Meta';
        document.getElementById('meta-id').value = '';
        document.getElementById('meta-codigo').value = ''; 
        document.getElementById('meta-anio').value = new Date().getFullYear(); 
        document.getElementById('meta-estado').value = 'activo';
        btn.textContent = 'Guardar';
        btn.className = "bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-4 rounded shadow-md";
    }
    modal.style.display = 'block';
};

window.cerrarModalMeta = () => {
    document.getElementById('metaModal').style.display = 'none';
};

// --- BUSCADOR ---
const buscarInput = document.getElementById('buscar-meta-input');
if(buscarInput) {
    buscarInput.addEventListener('keyup', () => {
        const query = buscarInput.value.toLowerCase();
        const rows = document.querySelectorAll('#cuerpo-tabla-metas tr');
        rows.forEach(row => {
            if(row.cells.length < 2) return;
            // Busca en Código (col 1) y Descripción (col 2)
            const codigo = row.cells[1].textContent.toLowerCase();
            const desc = row.cells[2].textContent.toLowerCase();
            row.style.display = (codigo.includes(query) || desc.includes(query)) ? '' : 'none';
        });
    });
}

// --- CRUD ---
window.cargarMetas = async () => {
    const tbody = document.getElementById('cuerpo-tabla-metas');
    tbody.innerHTML = '<tr><td colspan="6" class="px-6 py-4 text-center text-gray-500">Cargando...</td></tr>';
    const token = localStorage.getItem('token');

    try {
        const res = await fetch(`${API_URL}/metas`, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!res.ok) throw new Error('Error al cargar');
        const datos = await res.json();

        if (datos.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="px-6 py-4 text-center text-gray-700">No hay registros.</td></tr>';
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
                    <td class="px-6 py-4 text-sm font-bold text-blue-700">${item.meta}</td>
                    <td class="px-6 py-4 text-sm text-gray-700 font-medium">${item.descripcion}</td>
                    <td class="px-6 py-4 text-sm text-gray-700">${item.anio}</td>
                    <td class="px-6 py-4 text-center">${estadoBadge}</td>
                    <td class="px-6 py-4 text-center">
                        <button onclick='window.abrirModalMeta(${json})' class="text-white bg-yellow-400 hover:bg-yellow-500 font-bold py-1 px-3 rounded mr-2"><i class="fas fa-edit"></i></button>
                        <button onclick='window.eliminarMeta(${item.id})' class="text-white bg-red-600 hover:bg-red-700 font-bold py-1 px-3 rounded"><i class="fas fa-trash-alt"></i></button>
                    </td>
                </tr>`;
        });
        tbody.innerHTML = html;
    } catch (e) {
        console.error(e);
        tbody.innerHTML = `<tr><td colspan="6" class="text-center text-red-500 p-4">${e.message}</td></tr>`;
    }
};

document.getElementById('form-meta').addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = localStorage.getItem('token');
    const id = document.getElementById('meta-id').value;
    const method = id ? 'PUT' : 'POST';
    const url = id ? `${API_URL}/metas/${id}` : `${API_URL}/metas`;

    const data = {
        meta: document.getElementById('meta-codigo').value, // Nuevo campo
        descripcion: document.getElementById('meta-descripcion').value.toUpperCase(),
        anio: document.getElementById('meta-anio').value,
        estado: document.getElementById('meta-estado').value
    };

    try {
        const res = await fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify(data)
        });
        if (!res.ok) throw new Error('Error al guardar');
        window.cerrarModalMeta();
        window.mostrarAlerta('Guardado correctamente', 'success');
        window.cargarMetas();
    } catch (e) {
        window.mostrarAlerta(e.message, 'error');
    }
});

window.eliminarMeta = (id) => {
    Swal.fire({
        title: "¿Eliminar?", text: "No podrás revertir esto.", icon: "warning",
        showCancelButton: true, confirmButtonColor: "#d33", confirmButtonText: "Sí, eliminar"
    }).then(async (r) => {
        if (r.isConfirmed) {
            try {
                const token = localStorage.getItem('token');
                const res = await fetch(`${API_URL}/metas/${id}`, {
                    method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` }
                });
                const responseData = await res.json();
                if (!res.ok) throw new Error(responseData.message || 'Error al eliminar');
                
                window.mostrarAlerta('Eliminado', 'success');
                window.cargarMetas();
            } catch (e) { window.mostrarAlerta(e.message, 'error'); }
        }
    });
};

// Init
document.addEventListener('DOMContentLoaded', () => {
    window.cargarMetas();
    window.onclick = (e) => {
        if (e.target === document.getElementById('metaModal')) window.cerrarModalMeta();
    };
});