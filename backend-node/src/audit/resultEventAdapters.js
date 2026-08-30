/**
 * Traduz os resultados estruturados retornados por PermissionEngine.evaluate()
 * e PathPolicy.evaluate() para o formato padrão de evento do AuditLogger.
 *
 * IMPORTANTE: PermissionEngine e PathPolicy não emitem eventos por conta
 * própria hoje (diferente de ConfirmationManager, que já tem `onEvent`
 * embutido) -- eles só retornam { allowed, code, reason, ... }
 * sincronamente para quem os chama. Por isso, estes adaptadores não são
 * "ouvidos" automaticamente por nada ainda: são funções puras, prontas para
 * o futuro orquestrador chamar manualmente depois de cada
 * permissionEngine.evaluate(...)/pathPolicy.evaluate(...), assim:
 *
 *   const result = permissionEngine.evaluate({ skill, input });
 *   auditLogger.log(adaptPermissionResult(result));
 *   if (!result.allowed) { ... }
 *
 * Nenhuma mudança foi feita em permissionEngine.js ou pathPolicy.js para
 * viabilizar isso -- ambos continuam exatamente como estavam, agnósticos
 * de auditoria. O acoplamento fica inteiramente aqui.
 */

function adaptPermissionResult(result, { skillName } = {}) {
  if (!result || typeof result !== "object" || typeof result.code !== "string") {
    throw new TypeError("adaptPermissionResult requer um resultado válido de PermissionEngine.evaluate().");
  }

  const eventName = result.allowed
    ? "permission.allowed"
    : `permission.denied.${result.code.toLowerCase()}`;

  return {
    eventName,
    layer: "PermissionEngine",
    outcome: result.code,
    // PermissionEngine.evaluate() já inclui skillName no próprio resultado
    // (result.skillName) -- preferido sobre o parâmetro de contexto, que
    // existe só como fallback caso um resultado malformado não o traga.
    skillName: result.skillName ?? skillName ?? null,
    sessionId: null, // PermissionEngine não conhece sessão -- fora do seu escopo
    detail: {
      reason: result.reason,
      destructive: result.destructive,
      permissions: result.permissions
    }
  };
}

function adaptPathResult(result, { skillName } = {}) {
  if (!result || typeof result !== "object" || typeof result.code !== "string") {
    throw new TypeError("adaptPathResult requer um resultado válido de PathPolicy.evaluate().");
  }

  const eventName = result.allowed
    ? "path.allowed"
    : `path.denied.${result.code.toLowerCase()}`;

  return {
    eventName,
    layer: "PathPolicy",
    outcome: result.code,
    // Diferente de PermissionEngine, o resultado de PathPolicy.evaluate()
    // NÃO inclui skillName (ver forma de retorno: { allowed, code, reason,
    // resolvedPaths }) -- por isso precisa vir do contexto de quem chama.
    skillName: skillName ?? null,
    sessionId: null, // PathPolicy não conhece sessão -- fora do seu escopo
    detail: {
      reason: result.reason,
      resolvedPaths: result.resolvedPaths
    }
  };
}

module.exports = { adaptPermissionResult, adaptPathResult };
