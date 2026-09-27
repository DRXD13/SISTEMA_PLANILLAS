const API_URL = '';
const token = localStorage.getItem('token');
let datosGlobales = [];
let filtroActivo = '';

document.addEventListener('DOMContentLoaded', () => {
    if (!token) { window.location.href = 'login.html'; return; }
    
    cargarTablaPrestamos();
    setupLiveSearch();

    // Evento para el botón BUSCAR que ya tenías
    const btnFiltrar = document.getElementById('btn-filtrar');
    if(btnFiltrar) {
        btnFiltrar.addEventListener('click', renderizarTabla);
    }

    // Enter en 'valor_busqueda' envía el formulario (submit implícito) y recarga la página:
    // lo interceptamos y aplicamos el mismo filtro que el botón BUSCAR.
    document.getElementById('form-buscar-prestamo')?.addEventListener('submit', (e) => {
        e.preventDefault();
        renderizarTabla();
    });
});

// ================= [FILTRO POR BOTONES] =================
function aplicarFiltroTipo(tipo) {
    filtroActivo = tipo;
    renderizarTabla();
    const mensaje = tipo === '' ? 'Mostrando TODOS' : `Filtrando por: ${tipo}`;
    const Toast = Swal.mixin({ toast: true, position: 'top-end', showConfirmButton: false, timer: 2000 });
    Toast.fire({ icon: 'info', title: mensaje });
}

// ================= 1. CARGA DE BANCOS (CON SEGURIDAD) =================
async function cargarBancosEnSelect() {
    const select = document.getElementById('pres-entidad');
    select.innerHTML = '<option value="">Cargando...</option>';
    try {
        const res = await fetch(`${API_URL}/entidades-financieras`, { headers: { 'Authorization': `Bearer ${token}` } });
        const bancos = await res.json();
        select.innerHTML = '<option value="">-- SELECCIONE BANCO / CAJA --</option>';
        
        bancos.forEach(b => {
            // [SEGURIDAD SINDICATO] 
            // Si la entidad es Sindicato, NO la mostramos en el combo para crear manual
            const nombreUpper = b.nombre.toUpperCase();
            if (nombreUpper.includes('SINDIC') || nombreUpper.includes('CUOTA SINDICAL')) {
                return; // Lo saltamos
            }

            const option = document.createElement('option');
            option.value = b.nombre;
            option.textContent = b.nombre;
            select.appendChild(option);
        });
    } catch (e) {
        console.error(e);
        select.innerHTML = '<option value="">Error al cargar lista</option>';
    }
}

// ================= 2. TABLA PRINCIPAL (CON CANDADO) =================
async function cargarTablaPrestamos() {
    const tbody = document.getElementById('cuerpo-tabla-prestamos');
    tbody.innerHTML = '<tr><td colspan="8" class="text-center py-4">Cargando...</td></tr>';
    try {
        const res = await fetch(`${API_URL}/prestamos`, { headers: { 'Authorization': `Bearer ${token}` } });
        datosGlobales = await res.json();
        renderizarTabla();
    } catch (e) { console.error(e); }
}

function renderizarTabla() {
    const tbody = document.getElementById('cuerpo-tabla-prestamos');
    const valorBusqueda = document.getElementById('valor_busqueda').value.toUpperCase();
    const tipoBusqueda = document.getElementById('tipo_busqueda').value; // nombre o dni
    const lblTotal = document.getElementById('lbl-total-prestamos'); 

    tbody.innerHTML = '';

    // Filtrar los datos en memoria
    let listaMostrar = datosGlobales.filter(item => {
        // 1. Filtro por Tipo (Botones)
        const tipoContrato = (item.tipo_contrato || '').toUpperCase();
        const cumpleTipo = filtroActivo === '' || tipoContrato.includes(filtroActivo);

        // 2. Filtro por Buscador (Input y Select)
        let cumpleBusqueda = true;
        if (valorBusqueda) {
            if (tipoBusqueda === 'dni') {
                cumpleBusqueda = item.dni.includes(valorBusqueda);
            } else {
                cumpleBusqueda = item.nombre_completo.toUpperCase().includes(valorBusqueda);
            }
        }

        return cumpleTipo && cumpleBusqueda;
    });

    // CALCULAR TOTAL
    const totalSuma = listaMostrar.reduce((acum, item) => acum + (parseFloat(item.monto_total) || 0), 0);
    if(lblTotal) lblTotal.textContent = `S/ ${totalSuma.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    if (listaMostrar.length === 0) { 
        tbody.innerHTML = '<tr><td colspan="8" class="text-center py-4 text-gray-500">No hay préstamos encontrados.</td></tr>'; 
        return; 
    }

    listaMostrar.forEach(item => {
        const row = document.createElement('tr');
        row.className = "hover:bg-gray-50 border-b align-middle";
        
        const tipoTrab = (item.tipo_contrato || '---').toUpperCase();
        let colorTrab = 'bg-gray-200 text-gray-700';
        if(tipoTrab.includes('CAS')) colorTrab = 'bg-purple-100 text-purple-700 border border-purple-200';
        if(tipoTrab.includes('NOMBRADO')) colorTrab = 'bg-green-100 text-green-700 border border-green-200';
        if(tipoTrab.includes('OBRERO')) colorTrab = 'bg-orange-100 text-orange-700 border border-orange-200';

        const banco = (item.entidad_financiera || '---').toUpperCase();
        
        // [SEGURIDAD SINDICATO] Detectar si es Sindicato
        const esSindicato = banco.includes('SINDIC') || banco.includes('CUOTA SINDICAL');

        let iconoBanco = '<i class="fas fa-university text-gray-400 mr-1"></i>';
        if(banco.includes('BCP') || banco.includes('CREDITO')) iconoBanco = '<i class="fas fa-circle text-orange-500 mr-1 text-[8px]"></i>';
        else if(banco.includes('BBVA')) iconoBanco = '<i class="fas fa-circle text-blue-500 mr-1 text-[8px]"></i>';
        else if(banco.includes('INTERBANK')) iconoBanco = '<i class="fas fa-circle text-green-500 mr-1 text-[8px]"></i>';
        else if(banco.includes('NACION')) iconoBanco = '<i class="fas fa-circle text-red-600 mr-1 text-[8px]"></i>';
        else if(banco.includes('SCOTIA')) iconoBanco = '<i class="fas fa-circle text-red-500 mr-1 text-[8px]"></i>';
        else if(banco.includes('CAJA')) iconoBanco = '<i class="fas fa-square text-yellow-500 mr-1 text-[8px]"></i>';

        let fechaFmt = '-';
        if(item.fecha_inicio) {
            const d = new Date(item.fecha_inicio);
            fechaFmt = d.toLocaleDateString('es-PE', { timeZone: 'UTC' });
        }

        // [SEGURIDAD SINDICATO] Decidir qué botones mostrar
        let accionesHtml = '';
        
        if (esSindicato) {
            // MOSTRAR CANDADO
            accionesHtml = `
                <div class="flex justify-center gap-2">
                    <span class="bg-gray-100 text-gray-400 w-8 h-8 rounded shadow flex items-center justify-center cursor-not-allowed" title="Gestionar en Módulo Sindicatos">
                        <i class="fas fa-lock text-xs"></i>
                    </span>
                </div>
            `;
        } else {
            // MOSTRAR BOTONES NORMALES (Editar y Eliminar)
            accionesHtml = `
                <div class="flex justify-center gap-2">
                    <button onclick="editarPrestamo(${item.id})" class="bg-yellow-400 hover:bg-yellow-500 text-white w-8 h-8 rounded shadow flex items-center justify-center transition" title="Editar"><i class="fas fa-pen text-xs"></i></button>
                    <button onclick="eliminarPrestamo(${item.id})" class="bg-red-500 hover:bg-red-600 text-white w-8 h-8 rounded shadow flex items-center justify-center transition" title="Eliminar"><i class="fas fa-trash text-xs"></i></button>
                </div>
            `;
        }

        row.innerHTML = `
            <td class="px-6 py-4 text-gray-500 font-mono text-xs">${item.id}</td>
            <td class="px-6 py-4 font-bold text-gray-700">${item.dni}</td>
            <td class="px-6 py-4"><div class="font-bold text-gray-800 uppercase text-sm">${item.nombre_completo}</div></td>
            <td class="px-6 py-4"><span class="${colorTrab} text-[10px] font-extrabold px-2 py-0.5 rounded uppercase tracking-wider">${tipoTrab}</span></td>
            <td class="px-6 py-4"><div class="font-bold text-gray-600 text-xs uppercase flex items-center">${iconoBanco} ${banco}</div></td>
            <td class="px-6 py-4 text-center font-bold text-gray-800">S/. ${parseFloat(item.monto_total).toFixed(2)}</td>
            <td class="px-6 py-4 text-center text-sm text-gray-600">${fechaFmt}</td>
            <td class="px-6 py-4 text-center">
                ${accionesHtml}
            </td>
        `;
        tbody.appendChild(row);
    });
}

// 4. MODAL Y CRUD
window.abrirModalPrestamo = function() {
    document.getElementById('form-prestamo').reset();
    document.getElementById('id_prestamo').value = '';
    document.getElementById('modal-title').textContent = "REGISTRAR NUEVO PRÉSTAMO";
    cargarBancosEnSelect();
    limpiarSeleccion();
    cambiarTab('tab-trabajador');
    document.getElementById('prestamoModal').classList.remove('hidden');
};
window.cerrarModalPrestamo = function() { document.getElementById('prestamoModal').classList.add('hidden'); };
window.cambiarTab = function(tabId) {
    document.getElementById('tab-trabajador').classList.add('hidden');
    document.getElementById('tab-detalle').classList.add('hidden');
    document.getElementById(tabId).classList.remove('hidden');
    const activeClass = "flex-1 py-4 text-center font-bold text-sm text-gray-700 bg-white border-t-4 border-blue-600 uppercase";
    const inactiveClass = "flex-1 py-4 text-center font-bold text-sm text-gray-500 hover:bg-gray-50 border-t-4 border-transparent uppercase";
    document.getElementById('btn-tab-trabajador').className = tabId === 'tab-trabajador' ? activeClass : inactiveClass;
    document.getElementById('btn-tab-detalle').className = tabId === 'tab-detalle' ? activeClass : inactiveClass;
};

// 5. BUSCADOR TRABAJADOR
function setupLiveSearch() {
    const input = document.getElementById(`search-trabajador`);
    const lista = document.getElementById('lista-trabajadores');
    if(!input || !lista) return;

    input.addEventListener('input', async function() {
        if (this.value.length < 2) { lista.classList.add('hidden'); return; }
        try {
            const typeBusqueda = /^\d+$/.test(this.value) ? 'dni' : 'nombre';
            const res = await fetch(`${API_URL}/buscar-persona?type=${typeBusqueda}&term=${encodeURIComponent(this.value)}`, { headers: { 'Authorization': `Bearer ${token}` } });
            const data = await res.json();
            lista.innerHTML = '';
            const resultados = data.filter(p => p.empleado_id != null);
            if (resultados.length === 0) lista.innerHTML = '<li class="px-4 py-2 text-sm text-gray-500">Sin resultados.</li>';
            else {
                resultados.forEach(p => {
                    const li = document.createElement('li');
                    li.className = "px-4 py-2 hover:bg-blue-100 cursor-pointer text-sm text-gray-700 border-b flex justify-between";
                    li.innerHTML = `<span><b>${p.dni}</b> - ${p.nombre} ${p.apellido_paterno}</span>`;
                    li.onclick = () => seleccionarTrabajador(p);
                    lista.appendChild(li);
                });
            }
            lista.classList.remove('hidden');
        } catch(e) { console.error(e); }
    });
    document.addEventListener('click', (e) => { if (!input.contains(e.target) && !lista.contains(e.target)) lista.classList.add('hidden'); });
}

function seleccionarTrabajador(p) {
    document.getElementById('id_trabajador_sel').value = p.empleado_id;
    document.getElementById('search-trabajador').parentElement.classList.add('hidden');
    document.getElementById('info-trabajador').classList.remove('hidden');
    document.getElementById('txt-trabajador').textContent = `${p.dni} - ${p.nombre} ${p.apellido_paterno}`;
    const img = document.getElementById('img-avatar-trabajador');
    img.src = p.foto && p.foto.startsWith('data:') ? p.foto : (p.foto ? `data:image/jpeg;base64,${p.foto}` : 'avatar.png');
}

window.limpiarSeleccion = function() {
    document.getElementById('id_trabajador_sel').value = '';
    document.getElementById('search-trabajador').parentElement.classList.remove('hidden');
    document.getElementById('info-trabajador').classList.add('hidden');
    document.getElementById('img-avatar-trabajador').src = 'avatar.png';
    document.getElementById('search-trabajador').value = '';
};

// ================= 6. GUARDAR =================
window.guardarPrestamo = async function() {
    const idPrestamo = document.getElementById('id_prestamo').value;
    const data = {
        empleado_id: document.getElementById('id_trabajador_sel').value,
        entidad_financiera: document.getElementById('pres-entidad').value,
        monto_total: document.getElementById('pres-monto').value,
        fecha_inicio: document.getElementById('pres-fecha').value,
        observacion: document.getElementById('pres-obs').value
    };

    if(!data.empleado_id) { Swal.fire('Error', 'Seleccione un Trabajador', 'warning'); return; }
    if(!data.entidad_financiera) { Swal.fire('Error', 'Seleccione Entidad Financiera', 'warning'); return; }
    if(!data.monto_total) { Swal.fire('Error', 'Ingrese monto', 'warning'); return; }

    const method = idPrestamo ? 'PUT' : 'POST';
    const url = idPrestamo ? `${API_URL}/prestamos/${idPrestamo}` : `${API_URL}/prestamos`;

    try {
        const res = await fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify(data)
        });

        if(res.ok) {
            Swal.fire('Éxito', 'Préstamo guardado correctamente', 'success');
            cerrarModalPrestamo();
            cargarTablaPrestamos();
        } else {
            Swal.fire('Error', 'No se pudo guardar', 'error');
        }
    } catch (e) { console.error(e); }
};

// ================= 7. EDITAR =================
window.editarPrestamo = async function(id) {
    try {
        const res = await fetch(`${API_URL}/prestamos/${id}`, { headers: { 'Authorization': `Bearer ${token}` } });
        if(!res.ok) throw new Error("Error al obtener préstamo");
        const data = await res.json();

        document.getElementById('form-prestamo').reset();
        document.getElementById('id_prestamo').value = data.id;
        document.getElementById('modal-title').textContent = "EDITAR PRÉSTAMO #" + data.id;

        await cargarBancosEnSelect();
        document.getElementById('pres-entidad').value = data.entidad_financiera || '';

        seleccionarTrabajador({
            empleado_id: data.empleado_id,
            dni: data.dni,
            nombre: data.nombre,
            apellido_paterno: `${data.apellido_paterno} ${data.apellido_materno}`,
            foto: data.foto
        });

        document.getElementById('pres-monto').value = data.monto_total;
        
        if(data.fecha_inicio) document.getElementById('pres-fecha').value = new Date(data.fecha_inicio).toISOString().split('T')[0];
        document.getElementById('pres-obs').value = data.observacion;

        cambiarTab('tab-trabajador');
        document.getElementById('prestamoModal').classList.remove('hidden');

    } catch (e) { 
        console.error(e);
        Swal.fire('Error', 'No se pudieron cargar los datos', 'error'); 
    }
};

window.eliminarPrestamo = async function(id) {
    if(!confirm('¿Eliminar Préstamo?')) return;
    await fetch(`${API_URL}/prestamos/${id}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } });
    cargarTablaPrestamos();
};