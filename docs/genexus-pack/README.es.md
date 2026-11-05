# Paquete GeneXus para ScrapForAI

Para equipos que mantienen aplicaciones GeneXus (Java o .NET) y quieren pruebas de regresión repetibles sin escribir código. El paquete trae:

| Qué | Dónde | Para qué |
|---|---|---|
| Perfiles de destino | `templates/targets/` | Dicen "qué aplicación, en qué ambiente, con qué reglas". `genexus-dev` y `genexus-staging`. |
| Rutinas modelo | `templates/routines/gx-*.routine.json` | Login GAM, página de humo, **Work With** (buscar en la grilla), **Transaction** (insertar y verificar) y **Prompt** (elegir en la ventana de búsqueda). |
| Rutinas de caos y concurrencia | `templates/routines/chaos-*`, `concurrency-*` | Qué pasa cuando la API falla o dos usuarios guardan a la vez. Se adaptan a mano. |
| Guía de convenciones | `docs/genexus-routine-conventions.md` (inglés) y esta guía | Lo que se aprendió probando GeneXus. |
| Skill para agentes | `skill/scrapforai/SKILL.md` | Para que un agente de IA (Claude Code u otro cliente MCP) use ScrapForAI correctamente. |
| Mapa de accesibilidad | `docs/a11y-platform-mapping.md` | Qué ajustar en GeneXus/NPDev para cada violación WCAG. |
| `answers.example.json` | raíz | El archivo de respuestas del instalador (abajo). |

`npm run cli -- pack build --out scrapforai-genexus-pack.zip` arma todo en un solo `.zip` (con una lista `MANIFEST.sha256`).

## Antes de empezar

1. ScrapForAI funcionando (`npm run dev`) y `.env` con `SCRAPFORAI_API_KEY` y **`ALLOWED_TARGET_ORIGINS`** con el origen de la aplicación (`https://dev.ejemplo.com`). Todo lo que ScrapForAI navega pasa por esa lista.
2. Un **usuario de prueba** de la aplicación en ese ambiente. Nunca el de una persona real. Si la aplicación permite una sola sesión por usuario (lo normal en GeneXus con GAM), este usuario es solo de ScrapForAI.
3. Guarde sus credenciales **en el cofre del servidor**, nunca en una rutina:
   ```powershell
   $key = (Select-String -Path .env -Pattern '^SCRAPFORAI_API_KEY=(.+)$').Matches.Groups[1].Value
   $body = @{ boundOrigins = @('https://dev.ejemplo.com'); values = @{ loginUser = 'usuario.prueba'; loginPassword = '...' } } | ConvertTo-Json
   Invoke-RestMethod -Method Post -Uri http://localhost:3000/v1/credentials/gam-prueba -Headers @{Authorization="Bearer $key"} -ContentType 'application/json' -Body $body
   ```
   El conjunto queda **atado a ese origen**: aunque alguien escriba una rutina que apunte a otro sitio, ScrapForAI no escribe allí la contraseña. Los valores son de solo escritura (ninguna respuesta los devuelve).

## Instalar en 5 pasos

1. **Copie** `templates/genexus-pack.answers.example.json` a `respuestas.json` y complételo: id del perfil, qué rutinas instalar y el valor de cada `REPLACE_...` (la tabla está en `templates/targets/README.md` y `templates/routines/README.md`). Un mismo `REPLACE_...` puede significar otra cosa en cada rutina (`REPLACE_PAGE_URL` es la página probada en una, el formulario de alta en otra): para eso existe `routineValues`, por id de rutina, que pisa a `values` solo en esa rutina.
2. **Encuentre los selectores reales** de su aplicación. Los de login (`#vUSER`, `#vUSRPSWING`, `BTNENTER`) son comunes en GAM pero **confírmelos**. Con el agente: "usá `inspect_dom` sobre la página de login"; sin agente: `POST /v1/explorations/inspect-dom`.
3. **Pruebe sin enviar nada:**
   ```
   npm run cli -- pack apply respuestas.json --dry-run
   ```
   Lista lo que guardaría, o qué falta. No envía **nada** mientras quede un `REPLACE_...` o algo sea inválido.
4. **Instale:** `npm run cli -- pack apply respuestas.json`. Guarda primero el perfil (una rutina no se puede guardar sin su perfil), luego la rutina `login` que el perfil nombra y luego las demás. Las rutinas quedan en `draft`.
5. **Ejecute cada una** (`npm run cli -- run login`, luego `run smoke-page`...). Cuando pase, guárdela como `"status": "active"` (es una versión nueva). Otras rutinas incluyen `login` con `"version": 1`: **fije siempre la versión**, o la prueba deja de ser reproducible.

Desde ahí: `npm run cli -- run <rutina>`, `suite`, o un agente con la skill.

## Convenciones GeneXus (lo que el perfil `platform: genexus` ya hace por usted)

1. **Siempre una "puerta" después del login.** Tras el submit, esperar una parte de la URL que solo existe después de loguearse (`loginGate.urlContains`, p. ej. `hwbwkw01`). Si el login no terminó, falla ahí y no como un timeout confuso más adelante. El perfil la agrega solo: una ejecución con `credentialSet` incluye la rutina `login` y luego la puerta.
2. **Una sola sesión por usuario.** Un segundo login con el mismo usuario puede devolver al `wblogin`. ScrapForAI **nunca** usa el mismo conjunto de credenciales en dos sesiones a la vez (las suites esperan; una ejecución síncrona recibe `409 CredentialInUse`) y el `teardown` de `login` cierra la sesión.
3. **No persiga fallas falsas.** Los `net::ERR_ABORTED` (documentos, imágenes del tema) son redirecciones del lado del cliente de GeneXus; el perfil los cuenta como ruido (`evidence.noiseFiltered`). Las señales confiables: `consoleErrors`, `pageErrors`, sus aserciones y la puerta de login. Un "componente que falta" suele ser consecuencia de no haber llegado a la página.
4. **Los ids de GeneXus:** `vNOMBRE` es una variable; en una grilla se vuelve `vNOMBRE_0001` (el sufijo es la **fila**); dentro de un web component se antepone `W0012`. Prefiera el `vNOMBRE` sin posición; un selector con `:nth-child(...)` es frágil (la regla `SEL001` lo avisa).
5. **Salir del campo.** GeneXus valida al perder el foco: las plantillas hacen `press Tab` después de cada `fill`.
6. **Esperar la red, no el tiempo.** `waitForQuiet` espera a que no haya XHR/fetch pendientes (en cualquier frame). `waitForTimeout` fijo es frágil (regla `WT001`).

Al **guardar** una rutina el servidor aplica estas reglas: `GX001` (error: submit de una credencial sin puerta de login), `GX002` (aviso: inicia sesión y no cierra), `WT001`, `SEL001`. Un error impide guardar; un aviso vuelve en la respuesta. Se puede suprimir una regla con `lintSuppress` (y una razón de 10 caracteres o más), y queda visible en la rutina.

## Las plantillas de pantalla

| Plantilla | Qué prueba | Cambia datos |
|---|---|---|
| `gx-login` | Login GAM con puerta y cierre de sesión. Guárdela como la rutina `login`. | No |
| `gx-smoke-page` | Entrar, llegar a una página, verificar que no cayó al login, captura. La forma de todo ítem de la bóveda. | No |
| `gx-work-with-search` | Work With: escribe un valor en el filtro, busca, la grilla muestra filas y la primera tiene el valor; ningún stack trace llega a la pantalla. | No |
| `gx-transaction-insert` | Transaction: inserta con un código único **generado**, lo encuentra en la lista (exactamente una fila) y lo borra en el `teardown`. | **Sí** (y limpia) |
| `gx-prompt-select` | Prompt: abre la ventana de búsqueda, filtra, elige una fila y verifica que el formulario muestra lo elegido. | No |

Las de **caos** (`chaos-*`) rompen una llamada a propósito (500, lenta, JSON roto) y verifican que la pantalla lo diga con palabras propias y sin errores crudos. Las de **concurrencia** (`concurrency-*`) usan dos usuarios a la vez. Ambas necesitan decisiones suyas: léalas en `templates/routines/README.md`. Un perfil `staging` rechaza el caos salvo que una persona active `flags.allowFaults`.

## Límites, dichos con franqueza

- Las plantillas de login se basan en una aplicación GeneXus real con GAM; **Work With, Transaction y Prompt son borradores** armados con las convenciones de ids de GeneXus y ejecutados en un navegador real contra una **aplicación simulada** que imita esas pantallas (`test/genexus-pack.smoke.ts`: cada plantilla pasa, y se pone en rojo en el paso correcto cuando la pantalla tiene el defecto), **no contra una aplicación GeneXus real ni contra la suya**. Cada selector `REPLACE_...` hay que confirmarlo.
- **El Prompt solo se alcanza si se abre dentro de la página** (capa con iframe). Una ventana del navegador separada no la controlan estos pasos: cambie el modo de ventana del prompt en el modelo, o pruebe esa pantalla por su URL.
- Aún no hay reglas propias para `platform: npdev` (a definir con ese equipo) ni se midió si el runtime de GeneXus expone un indicador de "ocupado": por eso se espera por actividad de red.
- Los datos de prueba son su responsabilidad: `gx-transaction-insert` borra lo que creó, pero un `teardown` no puede arreglar un ambiente con datos reales. Use un ambiente de desarrollo/QA.
- Las reglas de "qué ajustar en GeneXus" para accesibilidad son orientación y **no están verificadas contra una build concreta**.

## Qué sigue

Cuando una rutina pasa, es una **prueba de regresión**: guárdela en la bóveda (`vault add-from-run`) con la falla roja demostrada y luego la verde. Para varias personas y un servidor siempre encendido: `docs/TEAM-SERVER.md` (inglés). Para ver cómo cambió la aplicación entre builds: instantáneas de evolución (`scrapforai evolution snapshot`). Para qué rol ve qué pantalla: matriz de permisos. Para datos personales en URLs y consola: `options.piiScan`.
