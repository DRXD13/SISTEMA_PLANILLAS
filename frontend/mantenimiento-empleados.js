// =======================================================
// === MANTENIMIENTO EMPLEADOS JS (FIX VISUAL BAJA + SEGURIDAD FULL) ===
// =======================================================

const API_URL = ''; 
const token = localStorage.getItem('token');
const username = localStorage.getItem('username');
const periodo = localStorage.getItem('periodo'); 

// Referencias DOM
const empleadoModal = document.getElementById('empleadoModal');
const bajaModal = document.getElementById('bajaModal');
const conceptosModal = document.getElementById('modalConceptos');
const modalEditarIndividual = document.getElementById('modalEditarIndividual'); 
const historialCompletoModal = document.getElementById('historialCompletoModal');
const historialCompletoContenido = document.getElementById('historial-completo-contenido');
const tablaBody = document.getElementById('cuerpo-tabla-empleados');
const formEmpleado = document.getElementById('form-empleado');
const formBaja = document.getElementById('form-baja');

// Variables Globales
let listaGruposCache = [];
let filtroTipoSeleccionado = ''; 
let conceptosCacheGlobal = [];

// =======================================================
// === 1. INICIALIZACIÓN ===
// =======================================================
document.addEventListener('DOMContentLoaded', () => {
    if (!token) { window.location.href = 'login.html'; return; }
    if (!periodo) { Swal.fire('Atención', 'Seleccione un período.', 'warning').then(() => window.location.href = 'index.html'); return; }
    
    document.getElementById('user-name').textContent = `Usuario: ${username || 'Admin'}`; 
    document.getElementById('periodo-actual').textContent = `Período: ${periodo}`;
    
    cargarTablaEmpleados();
    setupToggles(); 
    setupMayusculas();
    setupLiveSearch();
    asignarListeners();
    activarFiltroSubtipos(); 
});

// =======================================================
// === 2. LÓGICA DE INTERRUPTOR (BOTONES AZULES) ===
// =======================================================
function setupToggles() {
    const botones = document.querySelectorAll('.toggle-btn');
    botones.forEach(btn => {
        const nuevoBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(nuevoBtn, btn);
        
        nuevoBtn.addEventListener('click', function() {
            const parent = this.parentElement;
            parent.querySelectorAll('.toggle-btn').forEach(b => {
                b.classList.remove('active'); 
                b.classList.remove('bg-blue-600', 'text-white');
            });
            this.classList.add('active');
            
            const groupName = parent.dataset.toggleGroup;
            const hiddenInput = document.getElementById(`modal_${groupName}`);
            if(hiddenInput) hiddenInput.value = this.dataset.value;
        });
    });
}

function setToggle(groupName, valor) { 
    const valNormalizado = (valor === 'Si' || valor === 'SI' || valor === true || valor === 1) ? 'Si' : 'No';
    const parent = document.querySelector(`[data-toggle-group="${groupName}"]`);
    const hiddenInput = document.getElementById(`modal_${groupName}`);

    if(parent && hiddenInput) {
        hiddenInput.value = valNormalizado;
        parent.querySelectorAll('.toggle-btn').forEach(b => {
            if(b.dataset.value === valNormalizado) b.classList.add('active');
            else b.classList.remove('active');
        });
    }
}

function resetearToggles() { 
    setToggle('funcionario', 'No'); 
    setToggle('regimen', 'No'); 
}

// =======================================================
// === 3. GESTIÓN DE CONCEPTOS (SEGURIDAD TOTAL) ===
// =======================================================

window.abrirModalConceptos = async function(idEmpleado, nombre, dni) {
    const modal = document.getElementById('modalConceptos');
    if(modal) modal.classList.remove('hidden');
    
    document.getElementById('lbl-nombre-concep').textContent = `TRABAJADOR: ${nombre} (${dni})`;
    document.getElementById('id-empleado-concep').value = idEmpleado;
    
    const inputMonto = document.getElementById('input-monto-add');
    inputMonto.value = '';
    inputMonto.readOnly = false;
    inputMonto.classList.remove('bg-gray-200', 'cursor-not-allowed', 'text-gray-500');
    
    let tipoTrabajador = 'Empleado';
    try {
        const res = await fetch(`${API_URL}/buscar-empleado-por-id/${idEmpleado}`, { headers: { 'Authorization': `Bearer ${token}` } });
        if(res.ok) {
            const data = await res.json();
            if (data.tipo_contrato === 'Obrero') tipoTrabajador = 'Obrero';
            if (data.tipo_contrato === 'CAS') tipoTrabajador = 'CAS';
        }
    } catch(e) { console.error(e); }

    await cargarComboConceptosInicial(tipoTrabajador);
    await cargarTablaConceptosAsignados(idEmpleado);
    window.filtrarComboConceptos('Todos');
};

window.cerrarModalConceptos = function() {
    document.getElementById('modalConceptos').classList.add('hidden');
};

async function cargarComboConceptosInicial(tipoFiltro) {
    try {
        const res = await fetch(`${API_URL}/conceptos`, { headers: { 'Authorization': `Bearer ${token}` } });
        const data = await res.json();
        
        conceptosCacheGlobal = data.filter(c => {
            if (c.estado !== 'activo') return false;
            if (tipoFiltro && c.aplicacion) {
                const tipoEmp = tipoFiltro.toUpperCase().trim();
                const aplicaCon = c.aplicacion.toUpperCase().trim();
                if (tipoEmp !== aplicaCon) return false;
            }
            return true;
        });
    } catch(e) { console.error(e); }
}

// Un concepto se ve en la planilla con su COLUMNA (conceptos.columna_planilla). Se muestra ese mismo texto
// aquí para que el modal y la planilla coincidan; el nombre interno se agrega solo si es distinto.
function etiquetaConcepto(columna, nombre) {
    const col = String(columna || nombre || '').trim();
    const nom = String(nombre || '').trim();
    return nom && nom.toUpperCase() !== col.toUpperCase() ? `${col} [${nom}]` : col;
}

// [SEGURIDAD 1] OCULTAR SINDICATO Y PRÉSTAMOS DEL COMBO
window.filtrarComboConceptos = function(filtroOperacion) {
    const select = document.getElementById('select-concepto-add');
    const inputMonto = document.getElementById('input-monto-add');
    select.innerHTML = '<option value="" data-monto="0" data-tipo="Variable">-- SELECCIONE --</option>';

    const btnTodos = document.getElementById('btn-filtro-todos');
    const btnIng = document.getElementById('btn-filtro-ingreso');
    const btnDesc = document.getElementById('btn-filtro-descuento');

    [btnTodos, btnIng, btnDesc].forEach(b => {
        b.className = "px-3 py-1 text-xs font-bold rounded bg-slate-800 text-slate-400 border border-slate-700 hover:bg-slate-700";
    });

    if(filtroOperacion === 'Todos') btnTodos.className = "px-3 py-1 text-xs font-bold rounded bg-blue-600 text-white border border-blue-500";
    if(filtroOperacion === 'Ingreso') btnIng.className = "px-3 py-1 text-xs font-bold rounded bg-green-600 text-white border border-green-500";
    if(filtroOperacion === 'Descuento') btnDesc.className = "px-3 py-1 text-xs font-bold rounded bg-red-600 text-white border border-red-500";

    const filtrados = conceptosCacheGlobal.filter(c => {
        if (filtroOperacion !== 'Todos' && c.operacion !== filtroOperacion) return false;
        
        // BLOQUEO SEGURIDAD: cuota sindical y préstamos se gestionan en sus módulos (por rol, no por nombre)
        if (c.rol_calculo === 'SINDICATO' || c.rol_calculo === 'PRESTAMO') return false;
        
        return true;
    });

    filtrados.forEach(c => {
        const montoDef = c.monto_defecto || 0;
        const tipoCon = c.tipo_concepto || 'Variable'; 
        const color = c.operacion === 'Ingreso' ? '🟢' : '🔴';
        // Mismo texto que la cabecera de la planilla (columna); el nombre interno solo si es distinto
        const etiqueta = etiquetaConcepto(c.columna_planilla, c.nombre);
        select.innerHTML += `<option value="${c.id}" data-monto="${montoDef}" data-tipo="${tipoCon}">${color} ${etiqueta} (${c.operacion})</option>`;
    });

    const nuevoSelect = select.cloneNode(true);
    select.parentNode.replaceChild(nuevoSelect, select);
    
    nuevoSelect.addEventListener('change', function() {
        const opcion = this.options[this.selectedIndex];
        if(!opcion.getAttribute('data-monto')) return;

        const montoAuto = parseFloat(opcion.getAttribute('data-monto')) || 0;
        const tipoConcepto = opcion.getAttribute('data-tipo');
        
        if (montoAuto > 0) {
            inputMonto.value = montoAuto.toFixed(2);
            inputMonto.classList.add('bg-blue-900', 'text-yellow-400'); 
            setTimeout(() => inputMonto.classList.remove('bg-blue-900', 'text-yellow-400'), 500);
        } else {
            if(tipoConcepto !== 'Fijo' || montoAuto === 0) inputMonto.value = ''; 
        }

        if (tipoConcepto === 'Fijo') {
            inputMonto.readOnly = true; 
            inputMonto.classList.add('bg-slate-700', 'cursor-not-allowed', 'text-slate-500'); 
        } else {
            inputMonto.readOnly = false; 
            inputMonto.classList.remove('bg-slate-700', 'cursor-not-allowed', 'text-slate-500'); 
        }
    });
};

window.agregarConcepto = async function() {
    const idEmpleado = document.getElementById('id-empleado-concep').value;
    const idConcepto = document.getElementById('select-concepto-add').value;
    const monto = parseFloat(document.getElementById('input-monto-add').value);

    if(!idConcepto) { Swal.fire("Atención", "Seleccione un concepto.", "warning"); return; }
    if(isNaN(monto) || monto < 0) { Swal.fire("Atención", "Ingrese un monto válido.", "warning"); return; }

    try {
        const resConcepto = await fetch(`${API_URL}/empleados/conceptos`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ empleado_id: idEmpleado, concepto_id: idConcepto, monto: monto })
        });

        if(!resConcepto.ok) {
            const error = await resConcepto.json();
            throw new Error(error.message || "Error al agregar");
        }

        await cargarTablaConceptosAsignados(idEmpleado);
        document.getElementById('input-monto-add').value = '';
        document.getElementById('select-concepto-add').value = '';
        const inputMonto = document.getElementById('input-monto-add');
        inputMonto.readOnly = false;
        inputMonto.classList.remove('bg-slate-700', 'cursor-not-allowed', 'text-slate-500');
        
        const Toast = Swal.mixin({ toast: true, position: 'top-end', showConfirmButton: false, timer: 2000 });
        Toast.fire({ icon: 'success', title: 'Concepto Agregado' });

    } catch(e) { Swal.fire("Error", e.message, "error"); }
};

// [SEGURIDAD 2] CANDADO + LIMPIEZA DE CEROS
async function cargarTablaConceptosAsignados(idEmpleado) {
    const tbody = document.getElementById('tabla-conceptos-empleado');
    if(!tbody) return;
    tbody.innerHTML = '<tr><td colspan="4" class="text-center py-4 text-slate-500">Cargando...</td></tr>';

    try {
        const res = await fetch(`${API_URL}/empleados/${idEmpleado}/conceptos?periodo=${periodo}`, { headers: { 'Authorization': `Bearer ${token}` } });
        const lista = await res.json();

        tbody.innerHTML = '';
        if(lista.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="text-center py-4 text-slate-500 italic">Sin conceptos.</td></tr>';
            return;
        }

        let hayVisibles = false;

        lista.forEach(item => {
            const montoNum = parseFloat(item.monto);

            // [LIMPIEZA] SI ES 0, NO SE MUESTRA
            if (montoNum === 0) return; 

            hayVisibles = true;

            const row = document.createElement('tr');
            row.className = "border-b border-slate-700 hover:bg-slate-800 transition";
            const esIngreso = item.operacion === 'Ingreso';
            const colorOp = esIngreso ? 'text-green-400 bg-green-900/20' : 'text-red-400 bg-red-900/20';
            const iconOp = esIngreso ? '<i class="fas fa-arrow-up mr-1"></i>' : '<i class="fas fa-arrow-down mr-1"></i>';
            // Etiqueta = columna de la planilla (tabla maestra conceptos, vía JOIN en el backend)
            const etiqueta = item.nombre_concepto_maestro;   // nombre vigente de la tabla maestra (JOIN en el backend)
            const nombreSafe = etiqueta.replace(/'/g, "");
            const esFijo = item.tipo_concepto === 'Fijo';
            const esEspecial = item.rol_calculo === 'JUDICIAL' || item.tipo_concepto === 'Porcentual';

            // SEGURIDAD (por rol de cálculo: no depende de cómo se llame el concepto)
            const esSindicato = item.rol_calculo === 'SINDICATO';
            const esPrestamo = item.rol_calculo === 'PRESTAMO';

            let valorVis = esEspecial ? `${montoNum.toFixed(2)}%` : `S/. ${montoNum.toFixed(2)}`;
            
            let botonesAccion = '';
            
            if (esSindicato || esPrestamo) {
                let msg = esPrestamo ? "Gestionar en Módulo Préstamos" : "Gestionar en Módulo Sindicatos";
                botonesAccion = `<span class="text-gray-500 cursor-not-allowed" title="${msg}"><i class="fas fa-lock text-lg"></i></span>`;
            } else {
                let btnEdit = esFijo ? `<span class="text-slate-600 cursor-not-allowed mr-3"><i class="fas fa-lock"></i></span>` : 
                    `<button class="text-blue-400 hover:text-blue-300 mr-3" onclick="window.abrirEditarConceptoIndividual(${item.id}, '${nombreSafe}', ${item.monto})"><i class="fas fa-edit"></i></button>`;
                let btnDelete = `<button class="text-red-400 hover:text-red-300 transition" onclick="window.eliminarConceptoAsignado(${item.id}, ${idEmpleado})"><i class="fas fa-trash-alt"></i></button>`;
                botonesAccion = btnEdit + btnDelete;
            }

            row.innerHTML = `
                <td class="px-4 py-3 font-bold text-slate-200 uppercase text-xs">${etiqueta}</td>
                <td class="px-4 py-3 text-right font-mono text-white text-sm">${valorVis}</td>
                <td class="px-4 py-3 text-center"><span class="${colorOp} px-2 py-1 rounded text-[10px] font-bold border border-slate-700/50">${iconOp} ${item.operacion}</span></td>
                <td class="px-4 py-3 text-center flex justify-center">
                    ${botonesAccion}
                </td>
            `;
            tbody.appendChild(row);
        });

        if (!hayVisibles) {
            tbody.innerHTML = '<tr><td colspan="4" class="text-center py-4 text-slate-500 italic">Sin conceptos activos.</td></tr>';
        }

    } catch(e) { tbody.innerHTML = '<tr><td colspan="4" class="text-center text-red-500">Error carga.</td></tr>'; }
}

window.eliminarConceptoAsignado = async function(idRelacion, idEmpleado) {
    if(!confirm("¿Quitar este concepto?")) return;
    try {
        await fetch(`${API_URL}/empleados/conceptos/${idRelacion}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } });
        cargarTablaConceptosAsignados(idEmpleado);
    } catch(e) { alert("Error al eliminar"); }
};

window.abrirEditarConceptoIndividual = function(idRelacion, nombreConcepto, montoActual) {
    const modal = document.getElementById('modalEditarIndividual');
    if(!modal) return;
    document.getElementById('lbl-concepto-editar').textContent = `EDITAR: ${nombreConcepto}`;
    document.getElementById('edit-ind-id').value = idRelacion;
    document.getElementById('edit-ind-monto').value = parseFloat(montoActual).toFixed(2);
    modal.classList.remove('hidden');
    setTimeout(() => document.getElementById('edit-ind-monto').focus(), 100);
};

window.cerrarModalIndividual = function() {
    document.getElementById('modalEditarIndividual').classList.add('hidden');
};

window.guardarEdicionIndividual = async function() {
    const idRelacion = document.getElementById('edit-ind-id').value;
    const nuevoMonto = parseFloat(document.getElementById('edit-ind-monto').value);
    const idEmpleado = document.getElementById('id-empleado-concep').value;

    if (isNaN(nuevoMonto) || nuevoMonto < 0) {
        Swal.fire("Error", "Ingrese un monto válido", "warning");
        return;
    }

    try {
        const res = await fetch(`${API_URL}/empleados/conceptos-individual/${idRelacion}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ monto: nuevoMonto })
        });
        if (!res.ok) throw new Error("No se pudo actualizar");
        
        const Toast = Swal.mixin({ toast: true, position: 'top-end', showConfirmButton: false, timer: 1500 });
        Toast.fire({ icon: 'success', title: `Actualizado: S/ ${nuevoMonto.toFixed(2)}` });

        cerrarModalIndividual();
        cargarTablaConceptosAsignados(idEmpleado);
    } catch (e) { console.error(e); Swal.fire("Error", "Falló la actualización", "error"); }
};

// =======================================================
// === 5. FUNCIONES CRUD PRINCIPALES ===
// =======================================================

async function cargarSelectsModal() {
    try {
        const headers = { 'Authorization': `Bearer ${token}` };
        const [rA, rC, rM, rS, rG] = await Promise.all([
            fetch(`${API_URL}/api/areas`, { headers }),
            fetch(`${API_URL}/cargos`, { headers }),
            fetch(`${API_URL}/metas`, { headers }),
            fetch(`${API_URL}/sistemas-pensiones`, { headers }),
            fetch(`${API_URL}/grupos-ocupacionales`, { headers })
        ]);
        
        const llenar = async (r, el, field) => { 
            const d = await r.json(); 
            if(el) { 
                el.innerHTML='<option value="">Seleccione...</option>'; 
                d.forEach(i=>{if(i.estado==='activo')el.innerHTML+=`<option value="${i.id}">${i[field]}</option>`}); 
            } 
        };
        
        await llenar(rA, document.getElementById('modal_area'), 'descripcion');
        await llenar(rC, document.getElementById('modal_cargo'), 'descripcion');
        await llenar(rS, document.getElementById('modal_sistema_pension'), 'descripcion');
        
        const metasData = await rM.json(); 
        const elMeta = document.getElementById('modal_meta'); 
        if(elMeta) { 
            elMeta.innerHTML = '<option value="">Seleccione Meta...</option>'; 
            metasData.forEach(item => { if(item.estado === 'activo') elMeta.innerHTML += `<option value="${item.id}">${item.meta} - ${item.descripcion}</option>`; }); 
        }
        
        const grupos = await rG.json(); 
        listaGruposCache = grupos; 
        const comboNombre = document.getElementById('aux_grupo_nombre'); 
        if(comboNombre) { 
            comboNombre.innerHTML = '<option value="">Grupo...</option>'; 
            [...new Set(grupos.filter(g => g.estado === 'activo').map(g => g.grupo_ocasional))].forEach(nombre => { comboNombre.innerHTML += `<option value="${nombre}">${nombre}</option>`; }); 
        }
    } catch(e) { console.error("Error selects", e); }
}

window.abrirModalEmpleadoVacioParaCrear = async function() {
    if(formEmpleado) formEmpleado.reset(); 
    resetearToggles(); 
    limpiarSeleccionBusqueda();
    safelySetValue('empleado_id', ''); 
    safelySetValue('persona_id', ''); 
    safelySetValue('modal_id', 'NUEVO');
    safelySetValue('txtCuspp', ''); 
    safelySetValue('modal_tipo_comision', ''); 
    safelySetValue('modal_subtipo', ''); 
    safelySetValue('aux_grupo_nombre', ''); 
    document.getElementById('modal_grupo_ocupacional').innerHTML = '<option value="">Nivel</option>';
    document.getElementById('modal-title').textContent = "REGISTRAR NUEVO EMPLEADO";
    document.getElementById('live_search_input').classList.remove('hidden'); 
    document.getElementById('btn_limpiar_seleccion').classList.add('hidden');
    document.getElementById('btn-modal-baja').style.display = 'none'; 
    document.getElementById('btn-modal-historial').style.display = 'none';
    
    await cargarSelectsModal(); 
    
    if(empleadoModal) { 
        window.cambiarTab('tab-personales'); 
        empleadoModal.classList.remove('hidden'); 
        document.body.style.overflow = 'hidden'; 
    }
    setupToggles(); 
};

window.abrirModalParaEditarDesdeTabla = async function(empleadoId) {
    try {
        const res = await fetch(`${API_URL}/buscar-empleado-por-id/${empleadoId}`, { headers: { 'Authorization': `Bearer ${token}` } });
        const data = await res.json(); if (!res.ok) throw new Error(data.message);
        
        if(formEmpleado) formEmpleado.reset(); 
        resetearToggles(); 
        await cargarSelectsModal();
        
        const grupoGuardado = listaGruposCache.find(g => g.id == data.grupo_ocupacional_id);
        if(grupoGuardado) { 
            safelySetValue('aux_grupo_nombre', grupoGuardado.grupo_ocasional); 
            const eventoChange = new Event('change'); 
            document.getElementById('aux_grupo_nombre').dispatchEvent(eventoChange); 
            safelySetValue('modal_grupo_ocupacional', data.grupo_ocupacional_id); 
        }
        
        document.getElementById('modal-title').textContent = "EDITAR DATOS DEL EMPLEADO"; 
        safelySetValue('empleado_id', data.id); 
        safelySetValue('modal_id', data.id); 
        safelySetValue('persona_id', data.persona_id);
        
        seleccionarPersona({ id: data.persona_id, nombre: data.nombre, apellido_paterno: data.apellido_paterno, apellido_materno: data.apellido_materno, dni: data.dni, foto: data.foto });
        document.getElementById('btn_limpiar_seleccion').classList.add('hidden'); 
        
        safelySetValue('modal_tipo_empleado', data.tipo_contrato || ''); 
        const eventTipo = new Event('change');
        document.getElementById('modal_tipo_empleado').dispatchEvent(eventTipo);

        safelySetValue('modal_subtipo', data.subtipo || ''); 
        safelySetValue('modal_cargo', data.cargo_id || ''); 
        safelySetValue('modal_area', data.area_id || ''); 
        if (data.fecha_ingreso) { 
            let f = data.fecha_ingreso; 
            if(typeof f !== 'string') { try { f = f.toISOString(); } catch(e) { f = ''; } } 
            if(f) safelySetValue('modal_fecha_ingreso', f.split('T')[0]); 
        }

        setToggle('funcionario', data.es_funcionario); 
        safelySetValue('modal_funcionario_texto', data.funcionario_detalle || ''); 

        const estadoRegimen = (data.sin_regimen === true || data.sin_regimen === 1 || data.regimen_sin_efecto === 'Si') ? 'Si' : 'No';
        setToggle('regimen', estadoRegimen); 
        safelySetValue('modal_regimen_texto', data.regimen_detalle || '');

        safelySetValue('txtCuspp', data.cuspp || '');
        safelySetValue('modal_meta', data.meta_id || '');
        safelySetValue('modal_sistema_pension', data.sistema_pension_id || '');

        // Forzar la validación de AFP vs ONP al cargar los datos
        const selectPension = document.getElementById('modal_sistema_pension');
        if (selectPension) selectPension.dispatchEvent(new Event('change'));

        safelySetValue('modal_tipo_comision', data.tipo_comision || ''); 
        safelySetValue('modal_motivos', data.motivos || '');
        safelySetValue('modal_referencia', data.referencia || '');

        const btnBaja = document.getElementById('btn-modal-baja'); 
        if(btnBaja) { 
            btnBaja.style.display = 'inline-block'; 
            btnBaja.onclick = function() { window.abrirModalBaja(data.id); }; 
        }
        
        const btnHist = document.getElementById('btn-modal-historial'); 
        if(btnHist) btnHist.style.display = 'inline-block';
        
        if(empleadoModal) { 
            window.cambiarTab('tab-personales'); 
            empleadoModal.classList.remove('hidden'); 
            document.body.style.overflow = 'hidden'; 
        }
        setupToggles(); 

    } catch (err) { Swal.fire('Error', err.message, 'error'); }
};

async function ejecutarGuardar() {
    const btn = document.getElementById('btn-modal-guardar'); if(btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }
    const personaId = document.getElementById('persona_id').value; const empleadoId = document.getElementById('empleado_id').value;
    
    if (!personaId) { Swal.fire('Error', 'Seleccione una persona.', 'warning'); if(btn) { btn.disabled = false; btn.textContent = 'GUARDAR'; } return; }
    
    const url = empleadoId ? `${API_URL}/empleados/${empleadoId}` : `${API_URL}/empleados`; 
    const method = empleadoId ? 'PUT' : 'POST';
    
    const valorRegimen = document.getElementById('modal_regimen').value; 
    const esReincorporado = valorRegimen === 'Si'; 

    const payload = {
        periodo: periodo,
        persona_id: personaId, 
        area_id: document.getElementById('modal_area').value || null, 
        cargo_id: document.getElementById('modal_cargo').value || null,
        fecha_ingreso: document.getElementById('modal_fecha_ingreso').value || null, 
        tipo_contrato: document.getElementById('modal_tipo_empleado').value || null,
        subtipo: document.getElementById('modal_subtipo').value || null, 
        es_funcionario: document.getElementById('modal_funcionario').value, 
        funcionario_detalle: document.getElementById('modal_funcionario_texto').value,
        regimen_sin_efecto: valorRegimen, 
        regimen_detalle: document.getElementById('modal_regimen_texto').value, 
        sin_regimen: esReincorporado,
        cuspp: document.getElementById('txtCuspp').value.trim().toUpperCase(), 
        meta_id: document.getElementById('modal_meta').value || null,
        sistema_pension_id: document.getElementById('modal_sistema_pension').value || null, 
        tipo_comision: document.getElementById('modal_tipo_comision').value || null, 
        grupo_ocupacional_id: document.getElementById('modal_grupo_ocupacional').value || null,
        motivos: document.getElementById('modal_motivos').value || null,
        referencia: document.getElementById('modal_referencia').value || null
    };

    try {
        const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify(payload) });
        if (!res.ok) throw new Error((await res.json()).message);
        if (!empleadoId) { await fetch(`${API_URL}/personas/cambiar-estado`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ persona_id: personaId, nuevo_estado: 'activo', periodo: periodo }) }); }
        Swal.fire('Éxito', 'Guardado correctamente.', 'success'); 
        cerrarModalEmpleadoLogica();
    } catch (err) { 
        Swal.fire('Error', err.message, 'error'); 
    } finally { 
        if(btn) { btn.disabled = false; btn.textContent = 'GUARDAR'; } 
    }
}

// =======================================================
// === 6. BAJA, FILTROS Y OTROS ===
// =======================================================

async function cargarTablaEmpleados() { 
    if (!tablaBody) return; 
    tablaBody.innerHTML = '<tr><td colspan="5" class="px-6 py-4 text-center text-gray-500">Cargando...</td></tr>'; 
    try { 
        const res = await fetch(`${API_URL}/empleados?periodo=${periodo}`, { headers: { 'Authorization': `Bearer ${token}` } }); 
        if (!res.ok) { 
            if (res.status === 401) window.location.href = 'login.html'; 
            throw new Error('Error carga'); 
        } 
        const empleados = await res.json();
        renderizarTabla(empleados);
        filtrarTablaEmpleados(); 
    } catch (err) { 
        tablaBody.innerHTML = `<tr><td colspan="5" class="text-center text-red-500">Error: ${err.message}</td></tr>`; 
    } 
}

function renderizarTabla(empleados) { 
    tablaBody.innerHTML = ''; 
    if (!empleados || empleados.length === 0) { 
        tablaBody.innerHTML = '<tr><td colspan="5" class="px-6 py-4 text-center text-gray-500">No hay registros activos.</td></tr>'; 
        return; 
    } 
    empleados.forEach(emp => { 
        // [FIX VISUAL] SI ESTÁ INACTIVO, SALTAMOS Y NO LO DIBUJAMOS
        if (emp.estado === 'inactivo' || emp.estado === 'INACTIVO') return; 

        const row = document.createElement('tr'); 
        row.className = 'hover:bg-gray-50 border-b'; 
        
        const idReal = emp.id; 
        const empSafe = JSON.stringify(emp).replace(/"/g, '&quot;'); 
        const nombreCompleto = emp.nombre_completo || `${emp.nombre} ${emp.apellido_paterno}`;
        const nombreSafe = nombreCompleto.replace(/'/g, "\\'"); 
        
        row.innerHTML = `
            <td class="px-6 py-4 text-sm text-gray-500 font-mono">${idReal}</td>
            <td class="px-6 py-4 text-sm font-bold text-gray-700">${emp.dni}</td>
            <td class="px-6 py-4 text-sm text-gray-700 uppercase">${nombreCompleto}</td>
            <td class="px-6 py-4 text-sm"><span class="px-2 py-1 bg-blue-100 text-blue-800 rounded-full text-xs font-bold">${emp.tipo_contrato || '-'}</span></td>
            
            <td class="px-6 py-4 text-sm flex gap-1">
                <button onclick="window.abrirModalParaEditarDesdeTabla(${idReal})" class="text-white bg-yellow-500 hover:bg-yellow-600 px-2 py-1 rounded text-xs">EDITAR</button>
                <button onclick="window.abrirModalBaja(${idReal})" class="text-white bg-red-600 hover:bg-red-700 px-2 py-1 rounded text-xs">BAJA</button>
                <button onclick="window.abrirModalConceptos(${idReal}, '${nombreSafe}', '${emp.dni}')" class="text-white bg-green-600 hover:bg-green-700 px-2 py-1 rounded text-xs flex items-center" title="Conceptos Remunerativos"><i class="fas fa-money-bill-wave"></i></button>
            </td>`; 
        tablaBody.appendChild(row); 
    }); 
}

function filtrarTablaEmpleados() {
    const input = document.getElementById('valor_busqueda');
    const select = document.getElementById('tipo_busqueda');
    if(!input || !select) return;

    const query = input.value.trim().toUpperCase();
    const tipoBusqueda = select.value; 
    const rows = tablaBody.getElementsByTagName('tr');

    Array.from(rows).forEach(row => {
        if (row.cells.length < 4) return; 
        const textoDni = row.cells[1].textContent;
        const textoNombre = row.cells[2].textContent.toUpperCase();
        const textoTipo = row.cells[3].textContent.toUpperCase();

        let coincideTexto = (tipoBusqueda === 'dni') ? textoDni.includes(query) : textoNombre.includes(query);
        let coincideTipo = true;
        if (filtroTipoSeleccionado !== '') {
            coincideTipo = textoTipo.includes(filtroTipoSeleccionado);
        }
        row.style.display = (coincideTexto && coincideTipo) ? '' : 'none';
    });
}

function asignarListeners() {
    document.getElementById('btn-filtrar')?.addEventListener('click', filtrarTablaEmpleados);
    document.getElementById('btn-crear')?.addEventListener('click', window.abrirModalEmpleadoVacioParaCrear);
    document.getElementById('btn-modal-guardar')?.addEventListener('click', ejecutarGuardar);
    document.getElementById('btn-confirmar-baja')?.addEventListener('click', confirmarYRegistrarBaja);
    document.getElementById('btn-ver-historial-completo')?.addEventListener('click', window.abrirModalHistorialCompleto);
    document.getElementById('btn-modal-historial')?.addEventListener('click', window.ejecutarHistorialIndividual);
    
    // Enter en 'valor_busqueda' envía el formulario (submit implícito) y recarga la página:
    // lo interceptamos y aplicamos el mismo filtro que el botón BUSCAR.
    document.getElementById('form-buscar-empleado')?.addEventListener('submit', (e) => {
        e.preventDefault();
        filtrarTablaEmpleados();
    });

    const comboGrupo = document.getElementById('aux_grupo_nombre');
    const comboNivel = document.getElementById('modal_grupo_ocupacional');
    if (comboGrupo && comboNivel) {
        comboGrupo.addEventListener('change', function() {
            const grupoSeleccionado = this.value;
            comboNivel.innerHTML = '<option value="">Nivel</option>';
            if (grupoSeleccionado && listaGruposCache.length > 0) {
                const niveles = listaGruposCache.filter(g => g.grupo_ocasional === grupoSeleccionado && g.estado === 'activo');
                niveles.forEach(n => { comboNivel.innerHTML += `<option value="${n.id}">${n.nivel_remunerativo}</option>`; });
            }
        });
    }

    // LISTENER DE SEGURIDAD ONP vs AFP
    const selectPension = document.getElementById('modal_sistema_pension');
    const selectComision = document.getElementById('modal_tipo_comision');
    if (selectPension && selectComision) {
        selectPension.addEventListener('change', function() {
            if (this.selectedIndex === -1) return;
            const textoOpcion = this.options[this.selectedIndex].text.toUpperCase();
            
            // Si eligen ONP, bloqueamos y limpiamos el tipo de comisión
            if (textoOpcion.includes('ONP') || textoOpcion.includes('NACIONAL') || textoOpcion.includes('SNP')) {
                selectComision.value = '';
                selectComision.disabled = true;
                selectComision.classList.add('bg-gray-200', 'cursor-not-allowed');
            } else {
                // Si es AFP, habilitamos la selección
                selectComision.disabled = false;
                selectComision.classList.remove('bg-gray-200', 'cursor-not-allowed');
            }
        });
    }

    window.addEventListener('click', (e) => {
        if (e.target === empleadoModal) cerrarModalEmpleadoLogica();
        if (e.target === bajaModal) cerrarModalBajaLogica();
        if (e.target === historialCompletoModal) cerrarModalHistorialCompletoLogica();
        if (e.target === document.getElementById('filtroModal')) cerrarModalFiltro();
        if (e.target === conceptosModal) document.getElementById('modalConceptos').classList.add('hidden');
        if (e.target === modalEditarIndividual) cerrarModalIndividual();
    });
}

function safelySetValue(id, value) { const el = document.getElementById(id); if(el) el.value = (value !== null && value !== undefined) ? value : ''; }
function setupMayusculas() { ['valor_busqueda', 'live_search_input', 'modal_motivos', 'modal_referencia', 'modal_funcionario_texto', 'modal_regimen_texto', 'baja_detalle', 'txtCuspp'].forEach(id => { const input = document.getElementById(id); if(input) input.addEventListener('input', function() { const start = this.selectionStart; const end = this.selectionEnd; this.value = this.value.toUpperCase(); this.setSelectionRange(start, end); }); }); }

window.cambiarTab = function(tabId) {
    const tabs = ['tab-personales', 'tab-laborales', 'tab-remunerativos'];
    tabs.forEach(id => {
        document.getElementById(id).classList.add('hidden');
        const btn = document.getElementById('btn-' + id);
        if(btn) btn.className = "flex-1 py-4 text-center font-bold text-gray-500 hover:bg-gray-50 border-t-4 border-transparent";
    });
    document.getElementById(tabId).classList.remove('hidden');
    const activeBtn = document.getElementById('btn-' + tabId);
    if(activeBtn) {
        if(tabId === 'tab-remunerativos') {
            activeBtn.className = "flex-1 py-4 text-center font-bold text-green-700 bg-white border-t-4 border-green-600";
        } else {
            activeBtn.className = "flex-1 py-4 text-center font-bold text-gray-700 bg-white border-t-4 border-blue-600";
        }
    }
};

// =======================================================
// === 7. BAJA (CON BÚSQUEDA ROBUSTA DE ID) ===
// =======================================================

window.abrirModalBaja = async function(idEmpleado) {
    if(!bajaModal || !formBaja) return;
    
    try {
        const res = await fetch(`${API_URL}/buscar-empleado-por-id/${idEmpleado}`, { headers: { 'Authorization': `Bearer ${token}` } });
        if(!res.ok) throw new Error("No se pudo cargar empleado para baja");
        
        const emp = await res.json();
        
        formBaja.reset();
        
        // Obtenemos los IDs con seguridad
        let pId = emp.persona_id || emp.personaId;
        
        if (!pId) {
            Swal.fire("Error Interno", "No se encontró el ID de la Persona. Contacte a soporte.", "error");
            return;
        }

        formBaja.dataset.personaId = pId;
        formBaja.dataset.empleadoId = emp.id;
        
        safelySetValue('baja_empleado_id', emp.id);
        safelySetValue('baja_empleado_dni', emp.dni);
        const nombreFull = emp.apellido_paterno ? `${emp.nombre} ${emp.apellido_paterno}` : emp.nombre;
        safelySetValue('baja_empleado_nombre', nombreFull);
        
        bajaModal.classList.remove('hidden');
        
    } catch(e) {
        console.error(e);
        Swal.fire("Error", "No se pudo cargar datos para la baja", "error");
    }
};

const cerrarModalBajaLogica = function() { if(bajaModal) bajaModal.classList.add('hidden'); };
const cerrarModalEmpleadoLogica = function() { if(empleadoModal) empleadoModal.classList.add('hidden'); document.body.style.overflow = ''; cargarTablaEmpleados(); };
const cerrarModalHistorialCompletoLogica = function() { if(historialCompletoModal) historialCompletoModal.classList.add('hidden'); };

window.cerrarModalBaja = cerrarModalBajaLogica;
window.cerrarModalEmpleado = cerrarModalEmpleadoLogica;
window.cerrarModalHistorialCompleto = cerrarModalHistorialCompletoLogica;

async function confirmarYRegistrarBaja() {
    const motivo = document.getElementById('baja_motivo').value; 
    const fecha = document.getElementById('baja_fecha').value; 
    const detalle = document.getElementById('baja_detalle').value;
    
    // Validación de seguridad extra
    const pId = formBaja.dataset.personaId;
    if (!pId || pId === 'undefined') {
        Swal.fire('Error Crítico', 'No se ha cargado el ID de la persona. Cierre y vuelva a intentar.', 'error');
        return;
    }

    if (!motivo || !fecha) { Swal.fire('Faltan datos', 'Motivo y fecha requeridos.', 'warning'); return; }
    
    try {
        // Backend (transacción): empleados.fecha_baja + personas.estado='inactivo' + persona_historial_estado
        const res = await fetch(`${API_URL}/empleados/${formBaja.dataset.empleadoId}/baja`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ fecha_baja: fecha, motivo: motivo, detalle: detalle })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.message);
        Swal.fire('Baja Exitosa', data.message, 'success');
        cerrarModalBajaLogica(); 
        cerrarModalEmpleadoLogica(); 
    } catch (err) { Swal.fire('Error', err.message, 'error'); }
}

// =======================================================
// === 8. INACTIVOS Y REINCORPORACIÓN ===
// =======================================================
// La fila en 'empleados' es única por persona: reincorporar hace UPDATE de esa fila
// (fecha_baja = NULL, nueva fecha_ingreso), nunca un INSERT nuevo.
const inactivosModal = document.getElementById('inactivosModal');
const tablaInactivos = document.getElementById('cuerpo-tabla-inactivos');
let timerBusquedaInactivos = null;

function escaparHtml(txt) { return String(txt ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

window.abrirModalInactivos = function(terminoInicial = '') {
    if (!inactivosModal) return;
    const input = document.getElementById('inactivos_busqueda');
    if (input) input.value = terminoInicial;
    inactivosModal.classList.remove('hidden');
    cargarInactivos(terminoInicial);
    if (input) input.focus();
};
window.cerrarModalInactivos = function() { if (inactivosModal) inactivosModal.classList.add('hidden'); };

async function cargarInactivos(term = '') {
    if (!tablaInactivos) return;
    tablaInactivos.innerHTML = '<tr><td colspan="6" class="px-4 py-4 text-center text-gray-500">Buscando...</td></tr>';
    try {
        const res = await fetch(`${API_URL}/empleados-inactivos?term=${encodeURIComponent(term)}`, { headers: { 'Authorization': `Bearer ${token}` } });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message);
        if (!data.length) { tablaInactivos.innerHTML = '<tr><td colspan="6" class="px-4 py-4 text-center text-gray-500">No hay trabajadores dados de baja con ese criterio.</td></tr>'; return; }
        tablaInactivos.innerHTML = '';
        data.forEach(emp => {
            const tr = document.createElement('tr');
            tr.className = 'hover:bg-orange-50';
            tr.innerHTML = `
                <td class="px-4 py-2 font-bold text-gray-700">${escaparHtml(emp.dni)}</td>
                <td class="px-4 py-2 uppercase">${escaparHtml(emp.nombre_completo)}</td>
                <td class="px-4 py-2">${escaparHtml(emp.tipo_contrato || '-')}</td>
                <td class="px-4 py-2 font-mono">${escaparHtml(emp.fecha_ingreso || '-')}</td>
                <td class="px-4 py-2 font-mono text-red-600">${escaparHtml(emp.fecha_baja || '-')}</td>
                <td class="px-4 py-2 text-right"><button type="button" class="text-white bg-green-600 hover:bg-green-700 px-2 py-1 rounded text-xs font-bold">REINCORPORAR</button></td>`;
            tr.querySelector('button').onclick = () => window.reincorporarEmpleado(emp);
            tablaInactivos.appendChild(tr);
        });
    } catch (err) {
        tablaInactivos.innerHTML = `<tr><td colspan="6" class="px-4 py-4 text-center text-red-500">Error: ${escaparHtml(err.message)}</td></tr>`;
    }
}

// emp: { id, nombre_completo, dni, fecha_baja }
window.reincorporarEmpleado = async function(emp) {
    const hoy = new Date();
    const hoyStr = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}-${String(hoy.getDate()).padStart(2, '0')}`;
    const { value: form } = await Swal.fire({
        title: 'Reincorporar trabajador',
        html: `
            <p class="text-sm mb-1"><b>${escaparHtml(emp.nombre_completo)}</b> (DNI ${escaparHtml(emp.dni)})</p>
            <p class="text-xs text-gray-500 mb-4">Baja registrada: ${escaparHtml(emp.fecha_baja || '-')}</p>
            <label class="block text-left text-sm font-medium text-gray-700">Nueva fecha de ingreso (*)</label>
            <input type="date" id="swal-reinc-fecha" class="swal2-input" style="margin:4px 0 12px;width:100%" value="${hoyStr}" ${emp.fecha_baja ? `min="${emp.fecha_baja}"` : ''}>
            <label class="block text-left text-sm font-medium text-gray-700">Detalle / Documento (opcional)</label>
            <input type="text" id="swal-reinc-detalle" class="swal2-input" style="margin:4px 0;width:100%;text-transform:uppercase" placeholder="EJ: RESOLUCIÓN N° ...">`,
        focusConfirm: false,
        showCancelButton: true,
        confirmButtonText: 'Reincorporar',
        cancelButtonText: 'Cancelar',
        confirmButtonColor: '#16a34a',
        preConfirm: () => {
            const fecha = document.getElementById('swal-reinc-fecha').value;
            if (!fecha) { Swal.showValidationMessage('La fecha de ingreso es obligatoria.'); return false; }
            if (emp.fecha_baja && fecha <= emp.fecha_baja) { Swal.showValidationMessage(`Debe ser posterior a la baja (${emp.fecha_baja}).`); return false; }
            return { fecha_ingreso: fecha, detalle: document.getElementById('swal-reinc-detalle').value.trim().toUpperCase() };
        }
    });
    if (!form) return;

    try {
        const res = await fetch(`${API_URL}/empleados/${emp.id}/reincorporar`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify(form)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message);
        await Swal.fire('Reincorporado', `${data.message}<br><small>Revise sus datos laborales (cargo, área, régimen) con EDITAR.</small>`, 'success');
        window.cerrarModalInactivos();
        if (empleadoModal && !empleadoModal.classList.contains('hidden')) cerrarModalEmpleadoLogica();
        else cargarTablaEmpleados();
    } catch (err) { Swal.fire('Error', err.message, 'error'); }
};

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('btn-ver-inactivos')?.addEventListener('click', () => window.abrirModalInactivos());
    const input = document.getElementById('inactivos_busqueda');
    input?.addEventListener('input', function() {
        this.value = this.value.toUpperCase();
        clearTimeout(timerBusquedaInactivos);
        const term = this.value.trim();
        timerBusquedaInactivos = setTimeout(() => cargarInactivos(term), 300);
    });
    window.addEventListener('click', (e) => { if (e.target === inactivosModal) window.cerrarModalInactivos(); });
});

window.abrirModalHistorialCompleto = async function() { if(historialCompletoModal){ historialCompletoModal.classList.remove('hidden'); renderHistorialAPI(`${API_URL}/empleados/historial-completo`); } }
window.ejecutarHistorialIndividual = async function() { const id = document.getElementById('empleado_id').value; if(historialCompletoModal && id){ historialCompletoModal.classList.remove('hidden'); renderHistorialAPI(`${API_URL}/empleados/historial/${id}`); } }
async function renderHistorialAPI(url) { if(!historialCompletoContenido) return; historialCompletoContenido.innerHTML = '<div class="flex justify-center p-8"><i class="fas fa-spinner fa-spin text-3xl text-blue-500"></i></div>'; try { const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } }); const data = await res.json(); if(!data.length) { historialCompletoContenido.innerHTML = '<p class="text-center p-8 text-gray-500">Sin registros.</p>'; return; } let h = `<div class="overflow-x-auto"><table class="min-w-full text-xs text-left border-collapse table-fixed"><thead class="bg-gray-100 text-gray-700 uppercase font-bold sticky top-0 shadow-sm"><tr><th class="p-3 border-b w-24">Fecha</th><th class="p-3 border-b w-24">Usuario</th><th class="p-3 border-b w-20">Acción</th><th class="p-3 border-b w-40">Empleado</th><th class="p-3 border-b">Detalles</th></tr></thead><tbody class="divide-y divide-gray-200 bg-white">`; data.forEach(r => { h += `<tr><td class="p-3">${r.fecha_hora_formato}</td><td class="p-3 font-semibold text-blue-900">${r.usuario}</td><td class="p-3">${r.accion}</td><td class="p-3">${r.empleado_nombre || (r.empleado_id ? 'ID ' + r.empleado_id : '—')}</td><td class="p-3 italic text-gray-600">${r.detalles}</td></tr>`; }); h += '</tbody></table></div>'; historialCompletoContenido.innerHTML = h; } catch(e) { historialCompletoContenido.innerHTML = '<p class="text-red-500 text-center">Error carga.</p>'; } }

function setupLiveSearch() {
    const input = document.getElementById('live_search_input'); const lista = document.getElementById('lista_resultados'); const btnLimpiar = document.getElementById('btn_limpiar_seleccion'); if (!input || !lista) return;
    // Debounce + secuencia: una respuesta vieja (ej. de "881525") no debe pisar a la del DNI completo.
    let timerBusqueda = null; let secuenciaBusqueda = 0;
    input.addEventListener('input', function() { clearTimeout(timerBusqueda); const termino = this.value.trim(); if (termino.length < 2) { secuenciaBusqueda++; lista.classList.add('hidden'); return; } timerBusqueda = setTimeout(() => buscarPersonasLive(termino), 250); });
    async function buscarPersonasLive(termino) { const miSecuencia = ++secuenciaBusqueda; const tipo = /^\d+$/.test(termino) ? 'dni' : 'nombre'; try { const res = await fetch(`${API_URL}/buscar-persona?type=${tipo}&term=${encodeURIComponent(termino)}`, { headers: { 'Authorization': `Bearer ${token}` } }); const personas = await res.json(); if (miSecuencia !== secuenciaBusqueda) return; lista.innerHTML = ''; if (personas.length === 0) { lista.innerHTML = '<li class="px-4 py-2 text-sm text-gray-500">No encontrado.</li>'; } else { personas.forEach(p => { const li = document.createElement('li'); li.className = "px-4 py-2 hover:bg-blue-100 cursor-pointer text-sm text-gray-700 border-b flex justify-between"; const deBaja = p.empleado_id && (p.empleado_fecha_baja || p.estado === 'inactivo'); const tag = deBaja ? '<span class="text-xs bg-orange-100 text-orange-700 px-2 rounded ml-2">De baja</span>' : (p.empleado_id ? '<span class="text-xs bg-red-100 text-red-600 px-2 rounded ml-2">Registrado</span>' : ''); li.innerHTML = `<div><span class="font-bold text-blue-600">${p.dni}</span> - ${p.nombre} ${p.apellido_paterno}</div>${tag}`; li.onclick = () => { if (deBaja) { lista.classList.add('hidden'); window.reincorporarEmpleado({ id: p.empleado_id, dni: p.dni, nombre_completo: `${p.apellido_paterno || ''} ${p.apellido_materno || ''}, ${p.nombre}`, fecha_baja: p.empleado_fecha_baja }); return; } if (p.empleado_id) { Swal.fire('Aviso', 'Esta persona ya es empleado.', 'warning'); return; } seleccionarPersona(p); }; lista.appendChild(li); }); } lista.classList.remove('hidden'); } catch (err) { console.error(err); } }
    document.addEventListener('click', (e) => { if (!input.contains(e.target) && !lista.contains(e.target)) lista.classList.add('hidden'); }); if (btnLimpiar) btnLimpiar.onclick = limpiarSeleccionBusqueda;
}
function seleccionarPersona(p) { document.getElementById('persona_id').value = p.id; document.getElementById('lbl_nombre_completo').textContent = `${p.nombre} ${p.apellido_paterno}`; document.getElementById('lbl_dni').textContent = `DNI: ${p.dni}`; document.getElementById('modal_foto').src = p.foto ? (p.foto.startsWith('data:') ? p.foto : `data:image/jpeg;base64,${p.foto}`) : 'avatar.png'; document.getElementById('lista_resultados').classList.add('hidden'); document.getElementById('live_search_input').classList.add('hidden'); document.getElementById('tarjeta_seleccionada').classList.remove('hidden'); document.getElementById('btn_limpiar_seleccion').classList.remove('hidden'); }
function limpiarSeleccionBusqueda() { document.getElementById('persona_id').value = ''; document.getElementById('modal_foto').src = 'avatar.png'; document.getElementById('tarjeta_seleccionada').classList.add('hidden'); document.getElementById('btn_limpiar_seleccion').classList.add('hidden'); const input = document.getElementById('live_search_input'); if(input) { input.classList.remove('hidden'); input.value = ''; input.focus(); } }

function activarFiltroSubtipos() {
    const DATOS_SUBTIPOS = { "EMPLEADO": [ "Alcalde", "Nombrado permanente", "Mandato judicial", "Contratado" ], "OBRERO": [ "Nombrado permanente", "Mandato judicial", "Contratado" ], "CAS": [ "Confianza", "Indeterminado" ] };
    const selectTipo = document.getElementById('modal_tipo_empleado'); const selectSubtipo = document.getElementById('modal_subtipo'); if (!selectTipo || !selectSubtipo) return;
    selectTipo.addEventListener('change', function() {
        const tipoSeleccionado = this.value.trim().toUpperCase(); const valorAnterior = selectSubtipo.value; selectSubtipo.innerHTML = '<option value="">-- Seleccione Subtipo --</option>';
        if (DATOS_SUBTIPOS[tipoSeleccionado]) { DATOS_SUBTIPOS[tipoSeleccionado].forEach(opcionTexto => { const nuevaOpcion = document.createElement('option'); nuevaOpcion.value = opcionTexto; nuevaOpcion.textContent = opcionTexto; selectSubtipo.appendChild(nuevaOpcion); }); selectSubtipo.disabled = false; if(valorAnterior) { const existe = Array.from(selectSubtipo.options).some(o => o.value === valorAnterior); if(existe) selectSubtipo.value = valorAnterior; } } else { selectSubtipo.disabled = true; }
    });
}

// --------------------------------------------------------
// MODALES (FUNCIONES DE AYUDA)
// --------------------------------------------------------
window.abrirModalFiltro = function() { document.getElementById('filtroModal').classList.remove('hidden'); };
window.cerrarModalFiltro = function() { document.getElementById('filtroModal').classList.add('hidden'); };
window.aplicarFiltro = function(tipo) { filtroTipoSeleccionado = tipo ? tipo.toUpperCase() : ''; const etiqueta = document.getElementById('etiqueta-filtro-activo'); const texto = document.getElementById('texto-filtro-activo'); if (filtroTipoSeleccionado) { etiqueta.classList.remove('hidden'); texto.textContent = filtroTipoSeleccionado; } else { etiqueta.classList.add('hidden'); } cerrarModalFiltro(); filtrarTablaEmpleados(); };