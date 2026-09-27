// =======================================================
// === MANTENIMIENTO-COMISIONES-SPP.JS (FINAL) ===
// =======================================================
const API_URL = ''; // Dejar vacío si está en el mismo puerto
const token = localStorage.getItem('token');
const periodoActual = localStorage.getItem('periodo'); // OBTENEMOS EL PERIODO SELECCIONADO

// Referencias DOM
const tablaBody = document.getElementById('comisiones-body');
const buscarInput = document.getElementById('buscar-input');
const buscarBtn = document.getElementById('btn-buscar');
const btnActualizar = document.getElementById('btn-actualizar');

// Modales
const modalCrear = document.getElementById('modalCrear');
const formCrear = document.getElementById('form-crear');
const modalEditar = document.getElementById('modalEditar');
const formEditar = document.getElementById('form-editar');
const modalActualizar = document.getElementById('modalActualizar');
const formActualizar = document.getElementById('form-actualizar');
const btnInicializar = document.getElementById('btn-inicializar');

let todosLosDatos = [];

// --- Validación Inicial ---
document.addEventListener('DOMContentLoaded', () => {
    if (!token) { window.location.href = 'login.html'; return; }
    
    // Mostrar periodo en el título o cabecera si existe el elemento
    const lblPeriodo = document.getElementById('periodo-actual');
    if(lblPeriodo) lblPeriodo.textContent = `Período: ${periodoActual || 'Ninguno'}`;

    if (!periodoActual) {
        Swal.fire('Error', 'No hay periodo seleccionado. Vuelva al inicio.', 'error')
            .then(() => window.location.href = 'index.html');
        return;
    }

    // CARGAR DATOS FILTRADOS
    cargarComisiones();

    // Eventos
    if(btnActualizar) btnActualizar.addEventListener('click', abrirModalActualizar);
    if(buscarBtn) buscarBtn.addEventListener('click', filtrarTabla);
    if(buscarInput) buscarInput.addEventListener('keyup', filtrarTabla);
    if(btnInicializar) btnInicializar.addEventListener('click', inicializarRegistros);
});

// ==================== CARGAR DATOS (EL CAMBIO CLAVE) ====================
// En mantenimiento-comisiones-spp.js

async function cargarComisiones() {
    if (!tablaBody) return;
    tablaBody.innerHTML = '<tr><td colspan="4" class="px-6 py-4 text-center text-gray-500"><i class="fas fa-spinner fa-spin"></i> Cargando datos de ' + periodoActual + '...</td></tr>';
    
    try {
        const response = await fetch(`${API_URL}/comisiones-spp?periodo=${periodoActual}`, {
            method: 'GET', 
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (response.status === 401) { window.location.href = 'login.html'; return; }
        if (!response.ok) throw new Error('Error al cargar datos');
        
        todosLosDatos = await response.json(); 
        
        // --- CAMBIO AQUÍ: Se quitó el cuadro amarillo y el botón ---
        // Ahora solo muestra un texto simple si no hay datos.
        if (todosLosDatos.length === 0) {
             tablaBody.innerHTML = '<tr><td colspan="4" class="px-6 py-4 text-center text-gray-500">No hay comisiones registradas.</td></tr>';
             return;
        }
        // -----------------------------------------------------------

        renderizarTabla(todosLosDatos); 
        
    } catch (error) {
        console.error(error);
        tablaBody.innerHTML = `<tr><td colspan="4" class="px-6 py-4 text-center text-red-500">Error: ${error.message}</td></tr>`;
    }
}

function renderizarTabla(comisiones) {
    if (!tablaBody) return;
    tablaBody.innerHTML = '';

    comisiones.forEach(c => {
        const estadoClass = c.estado === 'activo' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800';
        
        const row = document.createElement('tr');
        row.className = 'hover:bg-gray-50 border-b transition-colors';
        
        // AQUI ESTA LA CORRECCIÓN: 4 COLUMNAS EXACTAS (Sin datos extra)
        row.innerHTML = `
            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500 font-mono">
                ${c.id}
            </td>
            <td class="px-6 py-4 whitespace-nowrap text-sm font-bold text-gray-900">
                ${c.regimen}
            </td>
            <td class="px-6 py-4 whitespace-nowrap text-center">
                <span class="px-2 py-1 text-xs font-semibold rounded-full ${estadoClass}">${c.estado}</span>
            </td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-center">
                <button onclick='abrirModalEditar(${JSON.stringify(c)})' class="text-blue-600 hover:text-blue-900 bg-blue-50 p-2 rounded transition mr-2" title="Editar">
                    <i class="fas fa-edit"></i>
                </button>
                <button onclick="eliminarComision(${c.id})" class="text-red-600 hover:text-red-900 bg-red-50 p-2 rounded transition" title="Eliminar">
                    <i class="fas fa-trash"></i>
                </button>
            </td>
        `;
        tablaBody.appendChild(row);
    });
}

// ==================== MODALES ====================

// MODAL ACTUALIZAR (SBS)
function abrirModalActualizar() {
    if(!modalActualizar) return;
    formActualizar.reset();
    
    // Llenar automáticamente con el periodo actual del sistema
    const inputPeriodo = document.getElementById('actualizar-periodo');
    
    // Convertir "2025-Enero" -> "2025-01" para que la SBS lo entienda
    const mapMeses = {'enero':'01','enero-utiles':'01','febrero':'02','marzo':'03','abril':'04','mayo':'05','junio':'06','junio-grati':'06','julio':'07','agosto':'08','septiembre':'09','octubre':'10','noviembre':'11','diciembre':'12','diciembre-grati':'12'};
    
    if(periodoActual) {
        const [anio, mesTexto] = periodoActual.split('-');
        const mesNum = mapMeses[mesTexto.toLowerCase().trim()] || '01';
        inputPeriodo.value = `${anio}-${mesNum}`;
    }

    modalActualizar.style.display = 'block';
}

formActualizar.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('guardar-actualizar-btn');
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Conectando SBS...';

    const periodoInput = document.getElementById('actualizar-periodo').value;

    try {
        const res = await fetch(`${API_URL}/comisiones-spp/actualizar-sbs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ periodo: periodoInput })
        });
        
        const data = await res.json();
        if(!res.ok) throw new Error(data.message);

        Swal.fire('Éxito', data.message, 'success');
        cerrarModalActualizar();
        cargarComisiones(); // Recargar tabla para ver los nuevos datos

    } catch (err) {
        Swal.fire('Error', err.message, 'error');
    } finally {
        btn.disabled = false; btn.textContent = 'Actualizar Datos';
    }
});

function cerrarModalActualizar() { modalActualizar.style.display = 'none'; }

// MODAL EDITAR
function abrirModalEditar(c) {
    if(!modalEditar) return;
    // ... Llenar campos con c ...
    document.getElementById('editar-id').value = c.id;
    document.getElementById('editar-comision').value = c.comision;
    document.getElementById('editar-mixta').value = c.comision_mixta;
    document.getElementById('editar-seguro').value = c.seguroprima;
    document.getElementById('editar-aporte').value = c.aporte;
    document.getElementById('editar-periodo').value = c.periodo;
    
    // Campos ocultos necesarios para el UPDATE
    document.getElementById('editar-regimen-hidden').value = c.regimen;
    document.getElementById('editar-estado-hidden').value = c.estado;

    modalEditar.style.display = 'block';
}

formEditar.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('editar-id').value;
    const body = {
        regimen: document.getElementById('editar-regimen-hidden').value,
        estado: document.getElementById('editar-estado-hidden').value,
        comision: document.getElementById('editar-comision').value,
        comision_mixta: document.getElementById('editar-mixta').value,
        seguroprima: document.getElementById('editar-seguro').value,
        aporte: document.getElementById('editar-aporte').value,
        periodo: document.getElementById('editar-periodo').value
    };

    try {
        await fetch(`${API_URL}/comisiones-spp/${id}`, {
            method: 'PUT', headers: {'Content-Type':'application/json', 'Authorization':`Bearer ${token}`},
            body: JSON.stringify(body)
        });
        Swal.fire('Guardado', '', 'success');
        cerrarModalEditar();
        cargarComisiones();
    } catch(err) { Swal.fire('Error', '', 'error'); }
});

function cerrarModalEditar() { modalEditar.style.display = 'none'; }

// MODAL CREAR (Manual)
function abrirModalCrear() { modalCrear.style.display='block'; formCrear.reset(); }
function cerrarModalCrear() { modalCrear.style.display='none'; }
// ===============================================
// LÓGICA DE GUARDAR (CREAR) - FINAL CON PERIODO
// ===============================================
if (formCrear) {
    formCrear.addEventListener('submit', async (e) => {
        e.preventDefault(); 
        console.log("--> Botón guardar presionado");

        const btn = document.getElementById('guardar-crear-btn');
        const originalText = btn.textContent;
        
        // 1. Obtener valores
        const regimenVal = document.getElementById('crear-regimen').value;
        const estadoVal = document.getElementById('crear-estado').value;

        // 2. Validación simple
        if (!regimenVal) {
            Swal.fire('Falta información', 'Escribe el nombre del régimen.', 'warning');
            return;
        }

        // 3. Feedback visual
        btn.disabled = true;
        btn.textContent = 'Guardando...';

        try {
            // 4. Enviar al backend
            const response = await fetch(`${API_URL}/comisiones-spp`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json', 
                    'Authorization': `Bearer ${token}` 
                },
                body: JSON.stringify({
                    regimen: regimenVal.toUpperCase(),
                    estado: estadoVal,
                    periodo: periodoActual // <--- ¡ESTA ES LA LÍNEA IMPORTANTE QUE FALTABA!
                })
            });

            // 5. Verificar respuesta
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.message || 'Error al guardar');
            }

            // 6. Todo salió bien
            Swal.fire({
                icon: 'success',
                title: '¡Guardado!',
                text: 'El régimen se creó correctamente.',
                timer: 1500,
                showConfirmButton: false
            });

            cerrarModalCrear();
            cargarComisiones(); // Al recargar, ahora SÍ aparecerá porque tiene fecha

        } catch (err) {
            console.error(err);
            Swal.fire('Error', err.message, 'error');
        } finally {
            // 7. Restaurar botón
            btn.disabled = false;
            btn.textContent = originalText;
        }
    });
} else {
    console.error("Error: No se encontró el formulario 'form-crear' en el HTML.");
}

// UTILS
function filtrarTabla() {
    const term = buscarInput.value.toLowerCase();
    const filtrados = todosLosDatos.filter(x => x.regimen.toLowerCase().includes(term));
    renderizarTabla(filtrados);
}
async function eliminarComision(id) {
    if(await Swal.fire({title:'¿Eliminar?', showCancelButton:true, confirmButtonText:'Si'}).then(r=>r.isConfirmed)) {
        await fetch(`${API_URL}/comisiones-spp/${id}`, {method:'DELETE', headers:{'Authorization':`Bearer ${token}`}});
        cargarComisiones();
    }
}

// Cerrar al clic fuera
window.onclick = function(e) {
    if(e.target == modalCrear) cerrarModalCrear();
    if(e.target == modalEditar) cerrarModalEditar();
    if(e.target == modalActualizar) cerrarModalActualizar();
}
async function inicializarRegistros() {
    // Confirmación para que el usuario sepa qué va a pasar
    const result = await Swal.fire({
        title: '¿Generar Plantilla?',
        text: `Se crearán registros vacíos para todas las AFPs activas en el periodo ${periodoActual}.`,
        icon: 'question',
        showCancelButton: true,
        confirmButtonColor: '#9333ea', // Color morado
        confirmButtonText: 'Sí, generar',
        cancelButtonText: 'Cancelar'
    });

    if (!result.isConfirmed) return;

    const btn = document.getElementById('btn-inicializar');
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

    try {
        const response = await fetch(`${API_URL}/comisiones-spp/inicializar`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json', 
                'Authorization': `Bearer ${token}` 
            },
            body: JSON.stringify({ periodo: periodoActual })
        });

        const data = await response.json();

        if (!response.ok) throw new Error(data.message);

        Swal.fire('Proceso Terminado', data.message, 'success');
        cargarComisiones(); // Recarga la tabla para ver los nuevos campos vacíos

    } catch (error) {
        Swal.fire('Error', error.message, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
    }
}