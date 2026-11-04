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
};

export const STRINGS: Record<ReportLang, Strings> = { en, pt, es };
