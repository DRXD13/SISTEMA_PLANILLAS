<?php
ob_start();
     session_start();
         if(!isset($_SESSION['rol'])){
    header('location: ../erro404.php');
  }
?>
<?php if(isset($_SESSION['id'])) { ?>

<!doctype html>
<html lang="es">
  <head>
        <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no">
       <meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1">
       <title>Modulo RENIEC | PIDE</title>

          <link rel="stylesheet" href="../../backend/css/bootstrap.min.css">
                 <link rel="stylesheet" href="../../backend/css/custom.css">
               
      <link rel="stylesheet" type="text/css" href="../../backend/css/material.css">
      <link rel="icon" type="image/png" href="../../backend/img/logoPisco.png"/>
                                                    <link rel="stylesheet" type="text/css" href="../../backend/css/datatable.css">
    <link rel="stylesheet" type="text/css" href="../../backend/css/buttonsdataTables.css">
    <link rel="stylesheet" type="text/css" href="../../backend/css/font.css">
  </head>
  <body>
  
<?php include '../navbar/navbarsis.php'; ?>
               
<div class="main-content">
    <div class="row">
      <div class="col-lg-12 col-md-12">
         <div class="card" style="min-height: 485px">
            <div class="card-header card-header-text">
                <h4 class="card-title">MODULO DE CONSULTA DE DNI EN LA RENIEC</h4>
                <p class="category">Criterios de la búsqueda</p>
            </div>
            <hr>
            <div class="card-content table-responsive">
                <form enctype="multipart/form-data" method="POST"  autocomplete="off">
                    <div class="row">
                        <div class="col-md-2">
                            <div class="form-group">
                                <label for="titulolabel">N° RUC:<span class="text-danger">*</span></label>
                                <input type="text"  class="form-control" id="numruc" name="numruc" value="<?php echo $_SESSION['ruc'] ?>" readonly>
                            </div>   
                        </div>
                        <div class="col-md-3">
                            <div class="form-group">
                                <label for="titulolabel">N° DNI en consulta:<span class="text-danger">*</span></label>
                                <input type="text"  class="form-control" id="numdni" name="numdni" onKeypress="if (event.keyCode < 45 || event.keyCode > 57) event.returnValue = false;" required>
                            </div>   
                        </div>
                        <div class="col-md-2">
                            <div class="form-group">
                                <label for="titulolabel">N° DNI usuario:<span class="text-danger">*</span></label>
                                <input type="text"  class="form-control" id="numdniusu" name="numdniusu" value="<?php echo $_SESSION['dni'] ?>" readonly>
                            </div>   
                        </div>
                        <div class="col-md-3">
                            <div class="form-group">
                                <label for="titulolabel">Credenciales:<span class="text-danger">*</span></label>
                                <input type="password"  class="form-control" id="credencial" name="credencial" onKeypress="if (event.keyCode < 45 || event.keyCode > 57) event.returnValue = false;" required>
                            </div>   
                        </div>

                        
                        <div class="form-group">
                            <div class="col-md-2">
                                <label for="email">&nbsp;</label>
                                <button type="submit" class="btn btn-success text-white"><i class="material-icons">search</i>Buscar</button>                       
                            </div>
                        </div>
                        
                    </div>
                </form>
                <hr>
            
<?php
if ($_SERVER["REQUEST_METHOD"] == "POST") {

   
    if(isset($_POST["numdni"])){

        $numruc=$_POST['numruc'];
        $numdni=$_POST['numdni'];
        $numdniusu=$_POST['numdniusu'];
        $credencial=$_POST['credencial'];

          if(strlen($numdni)==8){
        
          
            $curl = curl_init();

            curl_setopt_array($curl, array(
              CURLOPT_URL => "https://ws2.pide.gob.pe/Rest/RENIEC/Consultar?nuDniConsulta=".$numdni."&nuDniUsuario=".$numdniusu."&nuRucUsuario=".$numruc."&password=".$credencial."&out=json",
              CURLOPT_RETURNTRANSFER => true,
              CURLOPT_ENCODING => "",
              CURLOPT_MAXREDIRS => 10,
              CURLOPT_TIMEOUT => 30,
              CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1,
              CURLOPT_CUSTOMREQUEST => "GET",
              CURLOPT_HTTPHEADER => array(
                "Accept: application/json",
                "Content-Type: application/json"
              ),
            ));

            $response = curl_exec($curl);
            $err = curl_error($curl);

            curl_close($curl);
            
            if ($err) {
              echo "cURL Error #:" . $err;
            } else {
               $prueba = json_decode($response,true);
            }
            
            $dato = array(
                "coResultado" => $prueba['consultarResponse']['return']['coResultado'] ?? '-',
                "apPrimer" => $prueba['consultarResponse']['return']['datosPersona']['apPrimer'] ?? '-',
                "apSegundo" => $prueba['consultarResponse']['return']['datosPersona']['apSegundo'] ?? '-',
                "direccion" => $prueba['consultarResponse']['return']['datosPersona']['direccion'] ?? '-',
                "estadoCivil" => $prueba['consultarResponse']['return']['datosPersona']['estadoCivil'] ?? '-',
                "foto" => $prueba['consultarResponse']['return']['datosPersona']['foto'] ?? '-',
                "prenombres" => $prueba['consultarResponse']['return']['datosPersona']['prenombres'] ?? '-',
                "restriccion" => $prueba['consultarResponse']['return']['datosPersona']['restriccion'] ?? '-',
                "ubigeo" => $prueba['consultarResponse']['return']['datosPersona']['ubigeo'] ?? '-'
            
            );
        

        if($dato['coResultado']=="0000"){
?>
                                <div class="top-navbar">
                    <nav class="navbar navbar-expand-sm">
                        <div class="container-fluid">
                            <div>Resultado de la Búsqueda</div>
                                
                        </div>
                    </nav>

                    <div class="list-group">
                                            <form target="_blank" action="../pdf/pdf_reniec.php" method="POST" enctype="multipart/form-data">
                        <div class="list-group-item">
                            <div class="row">
                                <div class="col-9">
                                <div class="list-group-item">
                                    <div class="row">
                                        <div class="col-sm-4">
                                            <h6 class="list-group-item-heading">DNI:</h6>
                                        </div>
                                        <div class="col-sm-5">
                                            <input type='hidden' name='numdni' value="<?php echo $numdni ?>" />
                                            <p class="list-group-item-text" ><?php echo $numdni ?></p>
                                        </div>
                                    </div>
                                    </div>
                                    <div class="list-group-item">
                                    <div class="row">
                                        <div class="col-sm-4">
                                            <h6 class="list-group-item-heading">Apellido Paterno:</h6>
                                        </div>
                                        <div class="col-sm-5">
                                            <input type='hidden' name='apPrimer' value="<?php echo $dato['apPrimer'] ?>" />
                                            <p class="list-group-item-text"><?php echo $dato['apPrimer'] ?></p>
                                        </div>
                                    </div>
                                    </div>
                                    <div class="list-group-item">
                                    <div class="row">
                                        <div class="col-sm-4">
                                            <h6 class="list-group-item-heading">Apellido Materno:</h6>
                                        </div>
                                        <div class="col-sm-5">
                                            <input type='hidden' name='apSegundo' value="<?php echo $dato['apSegundo'] ?>" />
                                            <p class="list-group-item-text"><?php echo $dato['apSegundo'] ?></p>
                                        </div>
                                    </div>
                                    </div>
                                    <div class="list-group-item">
                                    <div class="row">
                                        <div class="col-sm-4">
                                            <h6 class="list-group-item-heading">Nombres:</h6>
                                        </div>
                                        <div class="col-sm-5">
                                            <input type='hidden' name='prenombres' value="<?php echo $dato['prenombres'] ?>" />
                                            <p class="list-group-item-text"><?php echo $dato['prenombres'] ?></p>
                                        </div>
                                    </div>
                                    </div>
                                    <div class="list-group-item">
                                    <div class="row">
                                        <div class="col-sm-4">
                                            <h6 class="list-group-item-heading">Estado Civil:</h6>
                                        </div>
                                        <div class="col-sm-5">
                                            <input type='hidden' name='estadoCivil' value="<?php echo $dato['estadoCivil'] ?>" />
                                            <p class="list-group-item-text"><?php echo $dato['estadoCivil'] ?></p>
                                        </div>
                                    </div>
                                    </div>
                                    <div class="list-group-item">
                                    <div class="row">
                                        <div class="col-sm-4">
                                            <h6 class="list-group-item-heading">Ubigeo:</h6>
                                        </div>
                                        <div class="col-sm-5">
                                            <input type='hidden' name='ubigeo' value="<?php echo $dato['ubigeo'] ?>" />
                                            <p class="list-group-item-text"><?php echo $dato['ubigeo'] ?></p>
                                        </div>
                                    </div>
                                    </div>
                                    <div class="list-group-item">
                                    <div class="row">
                                        <div class="col-sm-4">
                                            <h6 class="list-group-item-heading">Direccion:</h6>
                                        </div>
                                        <div class="col-sm-5">
                                            <input type='hidden' name='direccion' value="<?php echo $dato['direccion'] ?>" />
                                            <p class="list-group-item-text"><?php echo $dato['direccion'] ?></p>
                                        </div>
                                    </div>
                                    </div>
                                    <div class="list-group-item">
                                    <div class="row">
                                        <div class="col-sm-4">
                                            <h6 class="list-group-item-heading">Restricciones:</h6>
                                        </div>
                                        <div class="col-sm-5">
                                            <input type='hidden' name='restriccion' value="<?php echo $dato['restriccion'] ?>" />
                                            <p class="list-group-item-text"><?php echo $dato['restriccion'] ?></p>
                                        </div>
                                    </div>
                                    </div>                       
                                </div>
                                <div class="col-3">
                                    <div class="list-group-item">
                                    <div class="row">
                                        <div class="col-sm-12">
                                            <input type='hidden' name='foto' value="data:image/jpg;base64, <?php echo $dato['foto'] ?>" />
                                            <img src="data:image/jpg;base64, <?php echo $dato['foto'] ?>">
                                            <br>
                                            <br>
                                            <button type="submit" class="btn btn-danger text-white"><i class="material-icons">print</i>Imprimir Constancia</button>
                                            
                                        </div>
                                    </div>
                                    </div>
                                </div>

                            </div>
                        </div>
                                                    
                    </div>                    </form>
                    <div class="text-center">
                        <small>Fecha consulta: <?php echo date("d/m/Y"); ?></small>
                    </div>                </div>
<?php        
        }else if($dato['coResultado']=="0001"){ 
?>       
                <div class="top-navbar">
                    <nav class="navbar navbar-expand-sm">
                        <div class="container-fluid">
                            <div>Resultado de la Búsqueda</div>     
                        </div>
                    </nav>
                    <div class="list-group">
                                            <div class="list-group-item">
                            <div class="row">
                                <div class="col-12">
                                        <div class="alert alert-danger" role="alert">
                                        El número de DNI corresponde a un menor de edad
                                        </div>  
                                </div>
                            </div>
                        </div>
                                                    
                    </div>                    <div class="text-center">
                        <small>Fecha consulta: <?php echo date("d/m/Y"); ?></small>
                    </div>                </div>
<?php  
        }else if($dato['coResultado']=="0999"){ 
?>   
            <div class="top-navbar">
                <nav class="navbar navbar-expand-sm">
                    <div class="container-fluid">
                        <div>Resultado de la Búsqueda</div>     
                    </div>
                </nav>
                <div class="list-group">
                                      <div class="list-group-item">
                        <div class="row">
                            <div class="col-12">
                                    <div class="alert alert-danger" role="alert">
                                    No se ha encontrado información para el número de DNI
                                    </div>  
                            </div>
                        </div>
                    </div>
                                                
                </div>                <div class="text-center">
                      <small>Fecha consulta: <?php echo date("d/m/Y"); ?></small>
                </div>            </div>
<?php  
        }else if($dato['coResultado']=="1000"){ 
?>   
            <div class="top-navbar">
                <nav class="navbar navbar-expand-sm">
                    <div class="container-fluid">
                        <div>Resultado de la Búsqueda</div>     
                    </div>
                </nav>
                <div class="list-group">
                                      <div class="list-group-item">
                        <div class="row">
                            <div class="col-12">
                                    <div class="alert alert-danger" role="alert">
                                    Uno o más datos de la petición no son válidos
                                    </div>  
                            </div>
                        </div>
                    </div>
                                                
                </div>                <div class="text-center">
                      <small>Fecha consulta: <?php echo date("d/m/Y"); ?></small>
                </div>            </div>
<?php  
        }else if($dato['coResultado']=="1001"){ 
?> 
            <div class="top-navbar">
                <nav class="navbar navbar-expand-sm">
                    <div class="container-fluid">
                        <div>Resultado de la Búsqueda</div>     
                    </div>
                </nav>
                <div class="list-group">
                                      <div class="list-group-item">
                        <div class="row">
                            <div class="col-12">
                                    <div class="alert alert-danger" role="alert">
                                    El DNI, RUC y contraseña no corresponden a un usuario válido
                                    </div>  
                            </div>
                        </div>
                    </div>
                                                
                </div>                <div class="text-center">
                      <small>Fecha consulta: <?php echo date("d/m/Y"); ?></small>
                </div>            </div>
<?php  
        }else if($dato['coResultado']=="1002"){ 
?> 
            <div class="top-navbar">
                <nav class="navbar navbar-expand-sm">
                    <div class="container-fluid">
                        <div>Resultado de la Búsqueda</div>     
                    </div>
                </nav>
                <div class="list-group">
                                      <div class="list-group-item">
                        <div class="row">
                            <div class="col-12">
                                    <div class="alert alert-danger" role="alert">
                                    La contraseña para el DNI y RUC está caducada
                                    </div>  
                            </div>
                        </div>
                    </div>
                                                
                </div>                <div class="text-center">
                      <small>Fecha consulta: <?php echo date("d/m/Y"); ?></small>
                </div>            </div>
<?php  
        }else if($dato['coResultado']=="1003"){ 
?>
            <div class="top-navbar">
                <nav class="navbar navbar-expand-sm">
                    <div class="container-fluid">
                        <div>Resultado de la Búsqueda</div>     
                    </div>
                </nav>
                <div class="list-group">
                                      <div class="list-group-item">
                        <div class="row">
                            <div class="col-12">
                                    <div class="alert alert-danger" role="alert">
                                    Se ha alcanzado el límite de consultas permitidas por día
                                    </div>  
                            </div>
                        </div>
                    </div>
                                                
                </div>                <div class="text-center">
                      <small>Fecha consulta: <?php echo date("d/m/Y"); ?></small>
                </div>            </div>
<?php  
        }else if($dato['coResultado']=="1999"){ 
?>
            <div class="top-navbar">
                <nav class="navbar navbar-expand-sm">
                    <div class="container-fluid">
                        <div>Resultado de la Búsqueda</div>     
                    </div>
                </nav>
                <div class="list-group">
                                      <div class="list-group-item">
                        <div class="row">
                            <div class="col-12">
                                    <div class="alert alert-danger" role="alert">
                                    Error desconocido / inesperado
                                    </div>  
                            </div>
                        </div>
                    </div>
                                                
                </div>                <div class="text-center">
                      <small>Fecha consulta: <?php echo date("d/m/Y"); ?></small>
                </div>            </div>

<?php  
        };       
        }
        }
}
?>


            </div>
         </div> 
      </div>
    </div>               
</div>
                         
        </div>
              
        </div>
    </div>

  <?php include('../../backend/modal/modacerrar.php'); ?>

            <script src="../../backend/js/jquery-3.3.1.slim.min.js"></script>
   <script src="../../backend/js/popper.min.js"></script>
   <script src="../../backend/js/bootstrap.min.js"></script>
   <script src="../../backend/js/jquery-3.3.1.min.js"></script>
   <script type="text/javascript" src="../../backend/js/sidebarCollapse.js"></script>

              <script type="text/javascript" src="../../backend/js/datatable.js"></script>
    <script type="text/javascript" src="../../backend/js/datatablebuttons.js"></script>
    <script type="text/javascript" src="../../backend/js/jszip.js"></script>
    <script type="text/javascript" src="../../backend/js/pdfmake.js"></script>
    <script type="text/javascript" src="../../backend/js/vfs_fonts.js"></script>
    <script type="text/javascript" src="../../backend/js/buttonshtml5.js"></script>
    <script type="text/javascript" src="../../backend/js/buttonsprint.js"></script>
    <script type="text/javascript" src="../../backend/js/example.js"></script>
    <script src="../../backend/js/sweetalert.js"></script>


    <script type="text/x-javascript">
    //codigo javascript
    
    var isCtrl = false;
    document.onkeyup=function(e){
    if(e.which == 17) isCtrl=false;
    }
    document.onkeydown=function(e){
    if(e.which == 17) isCtrl=true;
    if(e.which == 80 && isCtrl == true) {
    //Combinancion de teclas CTRL+P y bloquear su ejecucion en el navegador
    return false;
    }
    }
    </script>
        
  </body>
  </html>

<?php }else{ 
    header('Location: ../erro404.php');
 } ?>
 <?php ob_end_flush(); ?>
