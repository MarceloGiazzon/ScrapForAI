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
};

export const STRINGS: Record<ReportLang, Strings> = { en, pt, es };
