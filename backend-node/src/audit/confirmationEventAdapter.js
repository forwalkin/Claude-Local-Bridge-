/**
 * Traduz um evento bruto do ConfirmationManager (eventName + payload, no
 * formato que seu `emit()` interno já produz) para o formato padrão que
 * AuditLogger.log() espera.
 *
 * Este módulo é o único ponto de acoplamento entre AuditLogger e
 * ConfirmationManager -- e mesmo assim, o acoplamento é só de FORMATO de
 * dado (a forma do payload que emit() produz), nunca um require() do
 * módulo confirmationManager.js em si.
 *
 * Uso pretendido, na futura camada de wiring/orquestração:
 *
 *   const confirmationManager = createConfirmationManager({
 *     onEvent: (eventName, payload) => {
 *       auditLogger.log(adaptConfirmationEvent(eventName, payload));
 *     }
 *   });
 */
function adaptConfirmationEvent(eventName, payload = {}) {
  if (typeof eventName !== "string" || eventName.length === 0) {
    throw new TypeError("adaptConfirmationEvent requer eventName (string não-vazia).");
  }

  // outcome é derivado do próprio eventName (removendo o prefixo
  // "confirmation."), já que o payload que ConfirmationManager passa para
  // emit() não inclui um campo "outcome" explícito hoje. Nota: para o
  // evento "confirmation.already_resolved_attempt", isso produz o outcome
  // "already_resolved_attempt" -- ligeiramente diferente do valor
  // "already_resolved" que resolveConfirmation() retorna ao CHAMADOR direto
  // (sem o sufixo "_attempt"). Isso é intencional e inofensivo: o outcome
  // aqui documenta o TIPO DE EVENTO logado, não precisa ser byte-a-byte
  // idêntico ao valor de retorno da função que o originou.
  const outcome = eventName.startsWith("confirmation.")
    ? eventName.slice("confirmation.".length)
    : eventName;

  const { skillName, sessionId, timestamp, ...rest } = payload && typeof payload === "object" ? payload : {};

  return {
    eventName,
    layer: "ConfirmationManager",
    outcome,
    skillName: skillName ?? null,
    sessionId: sessionId ?? null,
    // Preserva o timestamp que o próprio ConfirmationManager já gerou (via
    // seu clock injetado) em vez de deixar o AuditLogger gerar um novo --
    // reflete melhor o momento real do evento.
    timestamp: typeof timestamp === "string" ? timestamp : undefined,
    detail: rest
  };
}

module.exports = { adaptConfirmationEvent };
