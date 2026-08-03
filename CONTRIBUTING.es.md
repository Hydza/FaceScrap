# Colaborar en FaceScrap

**English:** [CONTRIBUTING.md](CONTRIBUTING.md)

Las invariantes están documentadas en [ARCHITECTURE.md](ARCHITECTURE.md). Lee ese archivo antes de
realizar cambios estructurales. Esta guía resume los comandos y las convenciones del repositorio.

## Comandos

```bash
npm run lint          # Revisa TS, JS, JSON, HTML, CSS y SVG con Biome
npm run format        # Aplica el formato configurado en el repositorio
npm run typecheck     # Comprueba los tipos de src/ y tests/
npm test              # Ejecuta las pruebas con node:test
npm run policy        # Comprueba autoría, referencias restringidas y comentarios
npm run quality:code  # Busca código sin uso, duplicación, ciclos y dependencias inconsistentes
npm run check         # Ejecuta lint, tipos, política, build y pruebas
npm run build         # Genera iconos y crea dist/
npm run package       # Ejecuta todas las comprobaciones y crea el ZIP de publicación
npm run verify        # Ejecuta check y una revisión visual del panel lateral
npm run qa:matrix     # Revisa las combinaciones principales de idioma y tema
```

Para revisar una configuración concreta del panel:

```bash
npm run qa:sidepanel -- --browser=cft --lang=es --theme=dark
```

`--browser` acepta `cft`, `edge` o `brave`; `--lang` acepta `en` o `es`; y `--theme` acepta
`light`, `dark` o `auto`. Los resultados se escriben en
`artifacts/qa/<browser>/<language>/<theme>/`.

## Flujo de higiene del código

1. Ejecuta `npm run quality:code` y localiza los consumidores de cada archivo, exportación o
   bloque duplicado reportado.
2. Elimina código inalcanzable y consolida duplicados que compartan el mismo contrato. Conserva
   una duplicación intencional únicamente cuando su supresión explique el motivo vigente.
3. Escribe comentarios breves en inglés que describan restricciones o intención actuales. Elimina
   código comentado, marcadores de trabajo pendiente e historial de correcciones obsoleto.
4. Ejecuta `npm run policy` y después `npm run check`. Ambos deben terminar correctamente antes de
   solicitar una revisión.

## Qué ejecutar según el cambio

| Archivos modificados | Comprobación mínima |
| --- | --- |
| `src/shared/`, `src/background/` | `npm run check` |
| `src/sidepanel/` | `npm run verify` y revisión de las evidencias visuales |
| `src/content/`, `src/offscreen/` | `npm run check` y carga manual de `dist/` |
| `manifest.json`, `src/_locales/` | `npm run check` |
| Documentación y plantillas | `npm run policy` y `git diff --check` |

## Convenciones

- Añade pruebas de comportamiento con `node:test` y `assert`. Usa `tests/chrome-fake.ts` cuando
  una prueba necesite las API del navegador.
- Evita pruebas que inspeccionen la forma interna del código. Las excepciones son artefactos que
  solo pueden verificarse desde su fuente, como CSS, HTML, manifiesto, traducciones y atributos de
  accesibilidad.
- Coloca los textos visibles para el usuario en `src/shared/i18n.ts` y conserva la paridad entre
  inglés y español.
- Mantén los comentarios del código en inglés, claros, concisos y orientados al comportamiento
  actual.
- No incluyas datos privados, cookies, encabezados ni valores firmados de recursos en pruebas,
  capturas, reportes o commits.
- Respeta [SECURITY.md](SECURITY.md) para vulnerabilidades y [PRIVACY.md](PRIVACY.md) para el manejo
  de información.

## Solicitudes de cambio

Antes de abrir una solicitud:

1. Mantén el cambio enfocado y documenta el comportamiento observable.
2. Añade o actualiza las pruebas necesarias.
3. Ejecuta las comprobaciones correspondientes a los archivos modificados.
4. Resume el cambio, sus riesgos y la evidencia de validación.

Al contribuir aceptas que tu aportación se distribuya bajo la licencia MIT del proyecto. El
responsable del proyecto es Hydza.
