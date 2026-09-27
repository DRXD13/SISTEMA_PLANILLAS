document.addEventListener('DOMContentLoaded', () => {
    // Leemos el rol guardado al iniciar sesión
    const rol = localStorage.getItem('rol');

    // Selectores de los botones restringidos
    const btnGestionUsuarios = document.getElementById('btn-gestion-usuarios');
    const menuMantenimientoBtn = document.querySelector('[data-collapse-toggle="dropdown-mantenimiento"]');
    const menuMantenimientoContenido = document.getElementById('dropdown-mantenimiento');
    const linkPlanilla = document.getElementById('link-planilla');
    const linkSindicato = document.getElementById('link-sindicatos-operacion');
    const linkPrestamos = document.getElementById('link-prestamos');
    const linkComisiones = document.getElementById('link-comisiones-spp');
    const linkJudiciales = document.getElementById('link-judiciales');

    // 1. REGLAS PARA "GESTOR RRHH"
    // (Ocultar Configuración Técnica y Gestión de Usuarios)
    if (rol === 'Gestor RRHH') {
        if (btnGestionUsuarios) btnGestionUsuarios.style.display = 'none'; // No puede crear cuentas
        
        // Ocultar opción "Configuración" dentro de Mantenimiento
        const linkConfiguracion = document.querySelector('a[href="mantenimiento-configuracion.html"]');
        if (linkConfiguracion) linkConfiguracion.parentElement.style.display = 'none';
    }

    // 2. REGLAS PARA "ASISTENTE"
    // (Ocultar TODO excepto Persona y Asistencias)
    if (rol === 'Asistente') {
        if (btnGestionUsuarios) btnGestionUsuarios.style.display = 'none';
        if (menuMantenimientoBtn) menuMantenimientoBtn.style.display = 'none';
        if (menuMantenimientoContenido) menuMantenimientoContenido.style.display = 'none';
        if (linkPlanilla) linkPlanilla.style.display = 'none';
        if (linkSindicato) linkSindicato.style.display = 'none';
        if (linkPrestamos) linkPrestamos.style.display = 'none';
        if (linkComisiones) linkComisiones.style.display = 'none';
        if (linkJudiciales) linkJudiciales.style.display = 'none';
    }

    // Si es "Administrador", no entra a los IF y ve todo el sistema intacto.
});