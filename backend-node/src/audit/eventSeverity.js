/**
 * Tabela fixa de severidade por eventName. Centralizada aqui em vez de
 * decidida ad-hoc por quem chama log() -- isso é o que garante que o mesmo
 * tipo de evento sempre produz a mesma severidade, em qualquer camada.
 *
 * Convenção de eventName usada em todo o sistema:
 *   <layer>.<resultado>[.<code_especifico_em_snake_case>]
 *
 * Para ConfirmationManager, os eventNames já existem no código-fonte
 * (confirmation.approved, confirmation.expired, etc.) -- listados aqui tal
 * como emitidos de fato, verificado por inspeção de código antes desta
 * implementação.
 *
 * Para PermissionEngine e PathPolicy, que hoje NÃO emitem eventos por conta
 * própria (só retornam { allowed, code, reason, ... } de forma síncrona),
 * os eventNames abaixo são a convenção proposta para quando o futuro
 * orquestrador vier a chamar o AuditLogger com base nesses resultados --
 * ver src/audit/resultEventAdapters.js, que já implementa essa tradução.
 */
const EVENT_SEVERITY = {
  // ConfirmationManager -- eventNames confirmados por inspeção do código-fonte.
  "confirmation.requested": "info",
  "confirmation.approved": "info",
  "confirmation.denied": "notice",
  "confirmation.expired": "notice",
  "confirmation.consumed": "info",
  "confirmation.already_resolved_attempt": "notice",
  "confirmation.not_found": "warning",
  "confirmation.session_mismatch": "critical",
  "confirmation.fingerprint_mismatch": "critical",
  "confirmation.consume_without_approval": "critical",

  // PermissionEngine -- eventNames propostos, derivados de result.code via
  // resultEventAdapters.adaptPermissionResult().
  "permission.allowed": "info",
  "permission.denied.input_missing": "notice",
  "permission.denied.input_schema_invalid": "notice",
  // PERMISSIONS_EMPTY e PERMISSIONS_UNKNOWN são "warning", não "notice":
  // teoricamente já deveriam ter sido barrados na carga do manifesto pelo
  // skillValidator -- chegar até aqui é defesa em profundidade funcionando,
  // mas merece mais atenção que uma negação puramente esperada de input.
  "permission.denied.permissions_empty": "warning",
  "permission.denied.permissions_unknown": "warning",
  "permission.invariant_violation": "critical",

  // PathPolicy -- eventNames propostos, derivados de result.code via
  // resultEventAdapters.adaptPathResult().
  "path.allowed": "info",
  "path.denied.path_field_missing": "notice",
  "path.denied.path_absolute_rejected": "warning",
  "path.denied.path_traversal_rejected": "warning",
  // Decisão de MVP (registrada na especificação, pendente de calibração
  // futura com telemetria real): PATH_ESCAPE_VIA_SYMLINK é "warning", não
  // "critical". É o cenário mais sério que o PathPolicy detecta, mas ainda
  // representa o sistema funcionando corretamente e bloqueando -- diferente
  // de um mismatch de fingerprint/sessão, que indica algo que nem deveria
  // ser possível acontecer legitimamente dado o desenho do fluxo.
  "path.denied.path_escape_via_symlink": "warning",
  "path.invariant_violation": "critical"
};

const DEFAULT_SEVERITY = "warning";

/**
 * Retorna a severidade conhecida para um eventName, ou DEFAULT_SEVERITY se
 * o eventName não estiver na tabela. Nunca lança -- um eventName
 * desconhecido não deveria fazer o AuditLogger falhar, só ser tratado com
 * cautela (default "warning": "não sei classificar isso, mas não vou
 * descartar silenciosamente").
 */
function getSeverity(eventName) {
  return EVENT_SEVERITY[eventName] ?? DEFAULT_SEVERITY;
}

module.exports = { EVENT_SEVERITY, DEFAULT_SEVERITY, getSeverity };
