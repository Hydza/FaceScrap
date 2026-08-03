# Aviso de privacidad de FaceScrap

- **English:** [PRIVACY.md](PRIVACY.md)
- **Última actualización:** 2 de agosto de 2026
- **Responsable:** Hydza

Este aviso describe cómo FaceScrap 1.0.2 maneja información cuando se instala como una extensión
desempaquetada del navegador. FaceScrap funciona dentro del navegador y no requiere una cuenta de
FaceScrap.

## Información procesada por la extensión

FaceScrap procesa la información necesaria para identificar, mostrar y descargar contenido
compatible de las páginas de Facebook que visita el usuario:

- Direcciones de contenido y metadatos relacionados expuestos por la página, sus respuestas o
  sus solicitudes de recursos.
- El identificador de la pestaña activa, la ubicación de la página, el estado de reproducción y
  el estado temporal de captura.
- Preferencias de la extensión, como idioma, apariencia, comportamiento de descarga y atajos.
- Contadores y eventos locales de diagnóstico, como nombres de consultas, cantidades de
  resultados, códigos de estado y rutas de recursos sanitizadas.
- Un fondo opcional para el panel elegido por el usuario.

La extensión tiene acceso a páginas de Facebook y recursos de `fbcdn.net` porque esos permisos de
host son necesarios para las funciones de captura y descarga. El manifiesto de la extensión no
solicita acceso a otros hosts de sitios web.

## Almacenamiento y conservación

FaceScrap utiliza el almacenamiento de extensiones administrado por el navegador:

- `chrome.storage.session` conserva capturas, comprobantes de elementos guardados y otro estado
  por pestaña durante la sesión del navegador.
- `chrome.storage.local` conserva preferencias, idioma, diagnósticos y un fondo opcional del
  panel. Estos datos pueden permanecer entre reinicios del navegador hasta que se borren o se
  elimine la extensión.
- Los archivos descargados y los informes de diagnóstico exportados se escriben mediante el
  navegador en la ubicación de descarga seleccionada. Permanecen fuera del almacenamiento de la
  extensión hasta que el usuario los elimine.

El almacenamiento de diagnóstico tiene límites en la versión actual. Su formateador está
diseñado para omitir cuerpos de respuestas, encabezados de solicitudes, cookies y valores de
consulta firmados. Aun así, el usuario debe revisar cualquier informe o captura de pantalla antes
de adjuntarlo a un reporte público.

## Actividad de red y divulgación

El código actual de la extensión no incluye un servicio del proyecto para métricas, publicidad o
telemetría. Observa solicitudes realizadas por páginas de Facebook y puede solicitar el contenido
seleccionado a `fbcdn.net` cuando el usuario inicia una descarga. Los servicios del navegador y
Facebook procesan esas solicitudes conforme a sus propios términos y avisos de privacidad.

FaceScrap no incluye código que venda datos de la extensión ni que los envíe a un servidor
operado por el proyecto. La información que un usuario publique voluntariamente en un reporte,
debate o aviso de seguridad del repositorio queda sujeta al servicio de alojamiento y a la
visibilidad seleccionada ahí.

## Controles del usuario

El usuario puede borrar las capturas de la pestaña activa, cambiar o restablecer preferencias,
quitar un fondo personalizado del panel y desinstalar la extensión desde el navegador. La
desinstalación no borra los archivos ya guardados en Descargas ni las copias de informes
compartidas en otros lugares.

## Cambios y preguntas

Este aviso puede actualizarse cuando cambien los permisos o el manejo de datos de la extensión.
Los cambios importantes deben acompañar a la versión que los introduzca. Para una pregunta de
privacidad, abre un [reporte en el repositorio](https://github.com/Hydza/FaceScrap/issues) sin
incluir datos privados. Para un asunto de seguridad sensible, consulta [SECURITY.md](SECURITY.md).
