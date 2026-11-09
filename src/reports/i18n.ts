export const REPORT_LANGS = ['en', 'pt', 'es'] as const;
export type ReportLang = (typeof REPORT_LANGS)[number];

export interface Strings {
  htmlLang: string;
  title: string;
  suiteTitle: string;
  application: string;
  environment: string;
  build: string;
  date: string;
  executor: string;
  routine: string;
  run: string;
  duration: string;
  verdict: string;
  passed: string;
  failed: string;
  error: string;
  notRun: string;
  green: string;
  red: string;
  infraError: string;
  steps: string;
  step: string;
  action: string;
  status: string;
  time: string;
  detail: string;
  failureEvidence: string;
  screenshots: string;
  console: string;
  consoleErrors: string;
  network: string;
  networkFailures: string;
  none: string;
  teardown: string;
  teardownFailed: string;
  variants: string;
  variant: string;
  summary: string;
  unknown: string;
  integrity: string;
  keyId: string;
  manifestHash: string;
  chainPosition: string;
  signatureValid: string;
  signatureInvalid: string;
  notSigned: string;
  notPinned: string;
  proves: string;
  doesNotProve: string;
  verifyHint: string;
  generated: string;
  totalRuns: string;
  testData: string;
  seed: string;
  sample: string;
  parameter: string;
  value: string;
  origin: string;
  syntheticTag: string;
  syntheticNote: string;
  replayHint: string;
  caseTables: string;
  caseTable: string;
  tableVersion: string;
  tableRowUsed: string;
  tableRows: string;
  tableDigest: string;
  tableHint: string;
  simulatedTitle: string;
  clockFixed: string;
  clockInstall: string;
  clockForward: string;
  clockNote: string;
  faultRequest: string;
  faultDone: string;
  faultCount: string;
  faultsNote: string;
  quarantineTitle: string;
  quarantineNote: string;
  quarantinedTag: string;
  passedOnRetryTag: string;
  passedOnRetryNote: string;
  attempt: string;
  a11yTitle: string;
  a11yStandard: string;
  a11yBaseline: string;
  a11yNew: string;
  a11yFixed: string;
  a11yUnchanged: string;
  a11yNoBaseline: string;
  a11yTopOnly: string;
  a11yImpact: string;
  a11yRule: string;
  a11yElement: string;
  a11yAdjust: string;
  a11yNeedsReview: string;
  a11yCut: string;
  a11yAxeChanged: string;
  a11yGuidanceNote: string;
  a11yNone: string;
  a11yCounts: string;
  a11yNothingNew: string;
  a11ySuiteAudit: string;
  a11yColNew: string;
  a11yColFixed: string;
  a11ySuiteVariants: string;
  a11ySuiteAudits: string;
  a11ySuiteNewTotal: string;
  a11ySuiteWithBaseline: string;
  a11ySuiteNoBaselineAtAll: string;
  a11ySuiteSevere: string;
  a11ySuiteWithoutBaseline: string;
  a11ySuiteExpired: string;
  a11ySuiteOpenRun: string;
  piiTitle: string;
  piiNone: string;
  piiNote: string;
  piiSeverity: string;
  piiDetector: string;
  piiSurface: string;
  piiLocation: string;
  piiSample: string;
  piiTimes: string;
  piiLooked: string;
  piiCut: string;
  piiSuppressed: string;
  piiUntil: string;
  piiReason: string;
}

const en: Strings = {
  htmlLang: 'en',
  title: 'Test evidence report',
  suiteTitle: 'Test suite report',
  application: 'Application',
  environment: 'Environment',
  build: 'Build',
  date: 'Date',
  executor: 'Executed by',
  routine: 'Routine',
  run: 'Run',
  duration: 'Duration',
  verdict: 'Verdict',
  passed: 'PASSED',
  failed: 'FAILED',
  error: 'ERROR',
  notRun: 'NOT RUN',
  green: 'GREEN',
  red: 'RED',
  infraError: 'INFRASTRUCTURE ERROR',
  steps: 'Steps',
  step: '#',
  action: 'Action',
  status: 'Status',
  time: 'Time',
  detail: 'Detail',
  failureEvidence: 'Evidence of the failure',
  screenshots: 'Screenshots',
  console: 'Console',
  consoleErrors: 'Console errors',
  network: 'Network requests',
  networkFailures: 'Failed requests',
  none: 'none',
  teardown: 'Cleanup (teardown)',
  teardownFailed: 'The cleanup failed: test data may have been left behind.',
  variants: 'Runs',
  variant: 'Run',
  summary: 'Summary',
  unknown: 'not recorded',
  integrity: 'Integrity of this evidence',
  keyId: 'Signing key id',
  manifestHash: 'Manifest sha256',
  chainPosition: 'Position in the chain of signed evidence',
  signatureValid: 'Signature valid: the evidence files match the signed manifest.',
  signatureInvalid: 'SIGNATURE INVALID: do not rely on this report.',
  notSigned: 'Not signed: the evidence of this run was not pinned.',
  notPinned: 'The evidence has expired or was never kept.',
  proves: 'A valid signature proves that the installation that owns the key recorded exactly these files, and that they have not changed since.',
  doesNotProve: 'It does not prove that the test itself was correct or complete.',
  verifyHint: 'To verify: export the evidence and run "scrapforai evidence verify <folder> --expected-key-id <key id>".',
  generated: 'Report generated',
  totalRuns: 'Total runs',
  testData: 'Test data',
  seed: 'Seed',
  sample: 'Sample',
  parameter: 'Parameter',
  value: 'Value',
  origin: 'Origin',
  syntheticTag: 'synthetic',
  syntheticNote: "Synthetic data: the generated identity documents are made up but carry correct check digits, so one may coincide with a real person's or company's. Use only in dev/QA environments.",
  replayHint: 'Run again with the same seed and sample to reproduce these values.',
  caseTables: 'Case tables',
  caseTable: 'Table',
  tableVersion: 'Version',
  tableRowUsed: 'Row used',
  tableRows: 'Rows',
  tableDigest: 'SHA-256',
  tableHint: 'The values typed and the expected result of this run come from the row shown. The version and the digest identify the exact table that ran.',
  simulatedTitle: 'Simulated conditions',
  clockFixed: 'Browser clock fixed at',
  clockInstall: 'Browser clock started at',
  clockForward: 'then moved forward by',
  clockNote: "Only the browser's clock was changed. Rules that run on the server (most GeneXus date rules) saw the real date, so this run does not prove them.",
  faultRequest: 'Request',
  faultDone: 'What was done to it',
  faultCount: 'Times',
  faultsNote: 'These requests were answered wrongly on purpose to see how the application copes. Errors shown in this report may be a result of that, not defects of the server.',
  quarantineTitle: 'Quarantined routines (not counted in the verdict)',
  quarantineNote: 'These routines are quarantined because they were unstable. They ran, and their results are shown here, but they do not change the verdict of the suite.',
  quarantinedTag: 'quarantined',
  passedOnRetryTag: 'passed on a new attempt',
  passedOnRetryNote: 'These runs failed once and passed when tried again automatically. They count as passed, and the failed attempt is kept: it is listed below with its own run id.',
  attempt: 'Attempt',
  a11yTitle: "Accessibility",
  a11yStandard: "Standard",
  a11yBaseline: "Baseline",
  a11yNew: "New since the baseline",
  a11yFixed: "Fixed since the baseline",
  a11yUnchanged: "Unchanged",
  a11yNoBaseline: "No baseline was given, so this is not a comparison. Take an evolution snapshot with accessibility and name its screen in the step to see only what changed.",
  a11yTopOnly: "Showing the most serious findings only",
  a11yImpact: "Impact",
  a11yRule: "Rule",
  a11yElement: "Element",
  a11yAdjust: "What to adjust",
  a11yNeedsReview: "rule(s) the tool could not decide: a person has to look",
  a11yCut: "The list was cut: the totals are complete, the rows are not.",
  a11yAxeChanged: "The audit tool changed version between the baseline and this run; a new finding may come from a changed rule, not from the application.",
  a11yGuidanceNote: "The platform notes are orientation for a GeneXus/NPDev model; property names vary with the version. Confirm before applying.",
  a11yNone: "No violations found by the automated rules (this does not prove the page is accessible: most criteria need a person).",
  a11yCounts: "violation(s)",
  a11yNothingNew: "Nothing new and nothing fixed.",
  a11ySuiteAudit: "Audit",
  a11yColNew: "New",
  a11yColFixed: "Fixed",
  a11ySuiteVariants: "Variants audited",
  a11ySuiteAudits: "audit(s)",
  a11ySuiteNewTotal: "New violations vs baseline",
  a11ySuiteWithBaseline: "audit(s) with a baseline",
  a11ySuiteNoBaselineAtAll: "No audit had a baseline, so nothing can be called new.",
  a11ySuiteSevere: "Serious + critical violations",
  a11ySuiteWithoutBaseline: "audit(s) without a baseline are not part of the new count.",
  a11ySuiteExpired: "The evidence of these runs has expired, so their audits (if any) are not summarized here. Pin the runs you will report on",
  a11ySuiteOpenRun: "Only counts are shown. The findings of each audit are in the report of the run named in the last column.",
  piiTitle: 'Privacy scan',
  piiNone: 'No personal data or secrets were found in the places that were looked at (listed below). This does not prove there are none elsewhere.',
  piiNote: 'The values are not stored: each finding shows a masked sample and says where it was seen. The result also keeps a fingerprint, so the same value can be recognised elsewhere without being stored.',
  piiSeverity: 'Severity',
  piiDetector: 'What',
  piiSurface: 'Where',
  piiLocation: 'Location',
  piiSample: 'Sample',
  piiTimes: 'Times',
  piiLooked: 'Looked at',
  piiCut: 'The list was cut at its limit: more findings exist than are shown.',
  piiSuppressed: 'Suppressed by the profile (still listed, not counted)',
  piiUntil: 'Until',
  piiReason: 'Reason',
};

const pt: Strings = {
  htmlLang: 'pt',
  title: 'Relatório de evidência de teste',
  suiteTitle: 'Relatório de suíte de testes',
  application: 'Aplicação',
  environment: 'Ambiente',
  build: 'Build',
  date: 'Data',
  executor: 'Executado por',
  routine: 'Rotina',
  run: 'Execução',
  duration: 'Duração',
  verdict: 'Veredito',
  passed: 'APROVADO',
  failed: 'REPROVADO',
  error: 'ERRO',
  notRun: 'NÃO EXECUTADO',
  green: 'VERDE',
  red: 'VERMELHO',
  infraError: 'ERRO DE INFRAESTRUTURA',
  steps: 'Passos',
  step: 'Nº',
  action: 'Ação',
  status: 'Status',
  time: 'Tempo',
  detail: 'Detalhe',
  failureEvidence: 'Evidência da falha',
  screenshots: 'Capturas de tela',
  console: 'Console',
  consoleErrors: 'Erros de console',
  network: 'Requisições de rede',
  networkFailures: 'Requisições com falha',
  none: 'nenhum',
  teardown: 'Limpeza (teardown)',
  teardownFailed: 'A limpeza falhou: podem ter ficado dados de teste.',
  variants: 'Execuções',
  variant: 'Execução',
  summary: 'Resumo',
  unknown: 'não registrado',
  integrity: 'Integridade desta evidência',
  keyId: 'Id da chave de assinatura',
  manifestHash: 'sha256 do manifesto',
  chainPosition: 'Posição na cadeia de evidências assinadas',
  signatureValid: 'Assinatura válida: os arquivos de evidência conferem com o manifesto assinado.',
  signatureInvalid: 'ASSINATURA INVÁLIDA: não confie neste relatório.',
  notSigned: 'Sem assinatura: a evidência desta execução não foi fixada.',
  notPinned: 'A evidência expirou ou nunca foi guardada.',
  proves: 'Uma assinatura válida prova que a instalação dona da chave registrou exatamente estes arquivos e que eles não mudaram desde então.',
  doesNotProve: 'Não prova que o teste em si estava correto ou completo.',
  verifyHint: 'Para verificar: exporte a evidência e execute "scrapforai evidence verify <pasta> --expected-key-id <id da chave>".',
  generated: 'Relatório gerado em',
  totalRuns: 'Total de execuções',
  testData: 'Dados de teste',
  seed: 'Semente',
  sample: 'Amostra',
  parameter: 'Parâmetro',
  value: 'Valor',
  origin: 'Origem',
  syntheticTag: 'sintético',
  syntheticNote: 'Dados sintéticos: os documentos gerados são inventados, mas têm dígitos verificadores corretos, então um deles pode coincidir com o de uma pessoa ou empresa real. Use apenas em ambientes de dev/QA.',
  replayHint: 'Execute de novo com a mesma semente e amostra para reproduzir estes valores.',
  caseTables: 'Tabelas de casos',
  caseTable: 'Tabela',
  tableVersion: 'Versão',
  tableRowUsed: 'Linha usada',
  tableRows: 'Linhas',
  tableDigest: 'SHA-256',
  tableHint: 'Os valores digitados e o resultado esperado desta execução vêm da linha indicada. A versão e o resumo (hash) identificam a tabela exata que foi usada.',
  simulatedTitle: 'Condições simuladas',
  clockFixed: 'Relógio do navegador fixado em',
  clockInstall: 'Relógio do navegador iniciado em',
  clockForward: 'e adiantado em',
  clockNote: 'Só o relógio do navegador foi alterado. Regras que rodam no servidor (a maioria das regras de data do GeneXus) viram a data real, então esta execução não as comprova.',
  faultRequest: 'Requisição',
  faultDone: 'O que foi feito com ela',
  faultCount: 'Vezes',
  faultsNote: 'Estas requisições foram respondidas errado de propósito para ver como a aplicação reage. Erros mostrados neste relatório podem ser resultado disso, não defeitos do servidor.',
  quarantineTitle: 'Rotinas em quarentena (não contam no veredito)',
  quarantineNote: 'Estas rotinas estão em quarentena por serem instáveis. Elas rodaram e o resultado aparece aqui, mas não alteram o veredito da suíte.',
  quarantinedTag: 'quarentena',
  passedOnRetryTag: 'passou em nova tentativa',
  passedOnRetryNote: 'Estas execuções falharam uma vez e passaram quando foram repetidas automaticamente. Contam como aprovadas, e a tentativa que falhou foi mantida: aparece abaixo com o seu próprio id de execução.',
  attempt: 'Tentativa',
  a11yTitle: "Acessibilidade",
  a11yStandard: "Padrão",
  a11yBaseline: "Linha de base",
  a11yNew: "Novas desde a linha de base",
  a11yFixed: "Corrigidas desde a linha de base",
  a11yUnchanged: "Inalteradas",
  a11yNoBaseline: "Nenhuma linha de base foi informada, então isto não é uma comparação. Faça um snapshot de evolução com acessibilidade e indique a tela no step para ver só o que mudou.",
  a11yTopOnly: "Mostrando apenas as ocorrências mais graves",
  a11yImpact: "Impacto",
  a11yRule: "Regra",
  a11yElement: "Elemento",
  a11yAdjust: "O que ajustar",
  a11yNeedsReview: "regra(s) que a ferramenta não conseguiu decidir: uma pessoa precisa olhar",
  a11yCut: "A lista foi cortada: os totais estão completos, as linhas não.",
  a11yAxeChanged: "A ferramenta de auditoria mudou de versão entre a linha de base e esta execução; uma ocorrência nova pode vir de uma regra alterada, e não da aplicação.",
  a11yGuidanceNote: "As notas de plataforma são orientação para um modelo GeneXus/NPDev; os nomes das propriedades variam com a versão. Confirme antes de aplicar.",
  a11yNone: "Nenhuma violação encontrada pelas regras automáticas (isso não prova que a página é acessível: a maioria dos critérios exige uma pessoa).",
  a11yCounts: "violação(ões)",
  a11yNothingNew: "Nada novo e nada corrigido.",
  a11ySuiteAudit: "Auditoria",
  a11yColNew: "Novas",
  a11yColFixed: "Corrigidas",
  a11ySuiteVariants: "Variantes auditadas",
  a11ySuiteAudits: "auditoria(s)",
  a11ySuiteNewTotal: "Violações novas vs linha de base",
  a11ySuiteWithBaseline: "auditoria(s) com linha de base",
  a11ySuiteNoBaselineAtAll: "Nenhuma auditoria tinha linha de base, então nada pode ser chamado de novo.",
  a11ySuiteSevere: "Violações graves + críticas",
  a11ySuiteWithoutBaseline: "auditoria(s) sem linha de base não entram na contagem de novas.",
  a11ySuiteExpired: "A evidência destas execuções expirou, então as auditorias delas (se houve) não estão resumidas aqui. Fixe (pin) as execuções sobre as quais vai reportar",
  a11ySuiteOpenRun: "Só as contagens são mostradas. As ocorrências de cada auditoria estão no relatório da execução indicada na última coluna.",
  piiTitle: 'Varredura de privacidade',
  piiNone: 'Nenhum dado pessoal nem segredo foi encontrado nos lugares examinados (listados abaixo). Isso não prova que não existam em outros lugares.',
  piiNote: 'Os valores não são guardados: cada achado mostra uma amostra mascarada e diz onde foi visto. O resultado também guarda uma impressão digital, para reconhecer o mesmo valor em outro lugar sem guardá-lo.',
  piiSeverity: 'Severidade',
  piiDetector: 'O quê',
  piiSurface: 'Onde',
  piiLocation: 'Local',
  piiSample: 'Amostra',
  piiTimes: 'Vezes',
  piiLooked: 'Examinado',
  piiCut: 'A lista foi cortada no limite: existem mais achados do que os mostrados.',
  piiSuppressed: 'Suprimidos pelo perfil (continuam listados, não contam)',
  piiUntil: 'Até',
  piiReason: 'Motivo',
};

const es: Strings = {
  htmlLang: 'es',
  title: 'Informe de evidencia de prueba',
  suiteTitle: 'Informe de suite de pruebas',
  application: 'Aplicación',
  environment: 'Ambiente',
  build: 'Build',
  date: 'Fecha',
  executor: 'Ejecutado por',
  routine: 'Rutina',
  run: 'Ejecución',
  duration: 'Duración',
  verdict: 'Veredicto',
  passed: 'APROBADO',
  failed: 'REPROBADO',
  error: 'ERROR',
  notRun: 'NO EJECUTADO',
  green: 'VERDE',
  red: 'ROJO',
  infraError: 'ERROR DE INFRAESTRUCTURA',
  steps: 'Pasos',
  step: 'N.º',
  action: 'Acción',
  status: 'Estado',
  time: 'Tiempo',
  detail: 'Detalle',
  failureEvidence: 'Evidencia del fallo',
  screenshots: 'Capturas de pantalla',
  console: 'Consola',
  consoleErrors: 'Errores de consola',
  network: 'Solicitudes de red',
  networkFailures: 'Solicitudes fallidas',
  none: 'ninguno',
  teardown: 'Limpieza (teardown)',
  teardownFailed: 'La limpieza falló: pueden haber quedado datos de prueba.',
  variants: 'Ejecuciones',
  variant: 'Ejecución',
  summary: 'Resumen',
  unknown: 'no registrado',
  integrity: 'Integridad de esta evidencia',
  keyId: 'Id de la clave de firma',
  manifestHash: 'sha256 del manifiesto',
  chainPosition: 'Posición en la cadena de evidencias firmadas',
  signatureValid: 'Firma válida: los archivos de evidencia coinciden con el manifiesto firmado.',
  signatureInvalid: 'FIRMA INVÁLIDA: no confíe en este informe.',
  notSigned: 'Sin firma: la evidencia de esta ejecución no fue fijada.',
  notPinned: 'La evidencia expiró o nunca se guardó.',
  proves: 'Una firma válida prueba que la instalación dueña de la clave registró exactamente estos archivos y que no cambiaron desde entonces.',
  doesNotProve: 'No prueba que la prueba en sí fuera correcta o completa.',
  verifyHint: 'Para verificar: exporte la evidencia y ejecute "scrapforai evidence verify <carpeta> --expected-key-id <id de la clave>".',
  generated: 'Informe generado el',
  totalRuns: 'Total de ejecuciones',
  testData: 'Datos de prueba',
  seed: 'Semilla',
  sample: 'Muestra',
  parameter: 'Parámetro',
  value: 'Valor',
  origin: 'Origen',
  syntheticTag: 'sintético',
  syntheticNote: 'Datos sintéticos: los documentos generados son inventados pero tienen dígitos verificadores correctos, por lo que uno puede coincidir con el de una persona o empresa real. Úselos solo en entornos de dev/QA.',
  replayHint: 'Ejecute de nuevo con la misma semilla y muestra para reproducir estos valores.',
  caseTables: 'Tablas de casos',
  caseTable: 'Tabla',
  tableVersion: 'Versión',
  tableRowUsed: 'Fila usada',
  tableRows: 'Filas',
  tableDigest: 'SHA-256',
  tableHint: 'Los valores escritos y el resultado esperado de esta ejecución vienen de la fila indicada. La versión y el resumen (hash) identifican la tabla exacta que se usó.',
  simulatedTitle: 'Condiciones simuladas',
  clockFixed: 'Reloj del navegador fijado en',
  clockInstall: 'Reloj del navegador iniciado en',
  clockForward: 'y adelantado en',
  clockNote: 'Solo se cambió el reloj del navegador. Las reglas que corren en el servidor (la mayoría de las reglas de fecha de GeneXus) vieron la fecha real, por lo que esta ejecución no las comprueba.',
  faultRequest: 'Solicitud',
  faultDone: 'Qué se hizo con ella',
  faultCount: 'Veces',
  faultsNote: 'Estas solicitudes se respondieron mal a propósito para ver cómo reacciona la aplicación. Los errores mostrados en este informe pueden ser resultado de eso, no defectos del servidor.',
  quarantineTitle: 'Rutinas en cuarentena (no cuentan en el veredicto)',
  quarantineNote: 'Estas rutinas están en cuarentena por ser inestables. Se ejecutaron y su resultado se muestra aquí, pero no cambian el veredicto de la suite.',
  quarantinedTag: 'cuarentena',
  passedOnRetryTag: 'pasó en un nuevo intento',
  passedOnRetryNote: 'Estas ejecuciones fallaron una vez y pasaron al repetirse automáticamente. Cuentan como aprobadas, y el intento que falló se conserva: aparece abajo con su propio id de ejecución.',
  attempt: 'Intento',
  a11yTitle: "Accesibilidad",
  a11yStandard: "Estándar",
  a11yBaseline: "Línea base",
  a11yNew: "Nuevas desde la línea base",
  a11yFixed: "Corregidas desde la línea base",
  a11yUnchanged: "Sin cambios",
  a11yNoBaseline: "No se indicó una línea base, así que esto no es una comparación. Haga un snapshot de evolución con accesibilidad e indique la pantalla en el step para ver solo lo que cambió.",
  a11yTopOnly: "Se muestran solo los hallazgos más graves",
  a11yImpact: "Impacto",
  a11yRule: "Regla",
  a11yElement: "Elemento",
  a11yAdjust: "Qué ajustar",
  a11yNeedsReview: "regla(s) que la herramienta no pudo decidir: una persona debe revisar",
  a11yCut: "La lista se cortó: los totales están completos, las filas no.",
  a11yAxeChanged: "La herramienta de auditoría cambió de versión entre la línea base y esta ejecución; un hallazgo nuevo puede venir de una regla modificada, no de la aplicación.",
  a11yGuidanceNote: "Las notas de plataforma son orientación para un modelo GeneXus/NPDev; los nombres de las propiedades varían con la versión. Confirme antes de aplicar.",
  a11yNone: "Ninguna violación encontrada por las reglas automáticas (esto no prueba que la página sea accesible: la mayoría de los criterios requiere una persona).",
  a11yCounts: "violación(es)",
  a11yNothingNew: "Nada nuevo y nada corregido.",
  a11ySuiteAudit: "Auditoría",
  a11yColNew: "Nuevas",
  a11yColFixed: "Corregidas",
  a11ySuiteVariants: "Variantes auditadas",
  a11ySuiteAudits: "auditoría(s)",
  a11ySuiteNewTotal: "Violaciones nuevas vs línea base",
  a11ySuiteWithBaseline: "auditoría(s) con línea base",
  a11ySuiteNoBaselineAtAll: "Ninguna auditoría tenía línea base, así que nada puede llamarse nuevo.",
  a11ySuiteSevere: "Violaciones graves + críticas",
  a11ySuiteWithoutBaseline: "auditoría(s) sin línea base no entran en la cuenta de nuevas.",
  a11ySuiteExpired: "La evidencia de estas ejecuciones expiró, así que sus auditorías (si las hubo) no están resumidas aquí. Fije (pin) las ejecuciones sobre las que va a reportar",
  a11ySuiteOpenRun: "Solo se muestran los conteos. Los hallazgos de cada auditoría están en el reporte de la ejecución indicada en la última columna.",
  piiTitle: 'Escaneo de privacidad',
  piiNone: 'No se encontraron datos personales ni secretos en los lugares examinados (listados abajo). Eso no prueba que no existan en otros lugares.',
  piiNote: 'Los valores no se guardan: cada hallazgo muestra una muestra enmascarada y dice dónde se vio. El resultado también guarda una huella, para reconocer el mismo valor en otro lugar sin guardarlo.',
  piiSeverity: 'Severidad',
  piiDetector: 'Qué',
  piiSurface: 'Dónde',
  piiLocation: 'Lugar',
  piiSample: 'Muestra',
  piiTimes: 'Veces',
  piiLooked: 'Examinado',
  piiCut: 'La lista se cortó en su límite: hay más hallazgos que los mostrados.',
  piiSuppressed: 'Suprimidos por el perfil (siguen listados, no cuentan)',
  piiUntil: 'Hasta',
  piiReason: 'Motivo',
};

export const STRINGS: Record<ReportLang, Strings> = { en, pt, es };
