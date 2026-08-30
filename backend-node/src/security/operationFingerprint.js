const crypto = require("node:crypto");

/**
 * Serializa um valor de forma canônica e determinística: chaves de objeto
 * sempre em ordem alfabética, recursivamente, para que a mesma estrutura
 * lógica produza sempre a mesma string, independente da ordem em que as
 * propriedades foram inseridas no objeto original.
 *
 * NÃO usa JSON.stringify puro porque JSON.stringify preserva a ordem de
 * inserção das chaves — duas operações logicamente idênticas, mas
 * construídas em ordens diferentes, produziriam fingerprints diferentes,
 * o que quebraria a garantia de determinismo exigida pela especificação.
 */
function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }

  const sortedKeys = Object.keys(value).sort();
  const entries = sortedKeys.map(
    (key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`
  );

  return `{${entries.join(",")}}`;
}

/**
 * Calcula o fingerprint de uma operação já validada pelas camadas
 * anteriores (PermissionEngine + PathPolicy).
 *
 * Representa EXATAMENTE { skillName, destructive, permissions,
 * resolvedPaths, input } — nunca confirmationId, sessionId, timestamps
 * ou TTL, que não fazem parte da identidade da operação em si.
 *
 * Campos extras eventualmente presentes no objeto `operation` (ex: uma
 * `description` usada só para exibição) são ignorados deliberadamente:
 * o fingerprint é construído a partir de uma projeção fixa dos 5 campos
 * que definem "o que vai ser executado", não do objeto inteiro.
 */
function computeOperationFingerprint(operation) {
  if (!operation || typeof operation !== "object") {
    throw new TypeError("computeOperationFingerprint requer um objeto de operação válido.");
  }

  const projected = {
    skillName: operation.skillName,
    destructive: operation.destructive,
    permissions: operation.permissions,
    resolvedPaths: operation.resolvedPaths,
    input: operation.input
  };

  const canonical = canonicalize(projected);
  const hash = crypto.createHash("sha256").update(canonical).digest("hex");

  return `sha256:${hash}`;
}

module.exports = { canonicalize, computeOperationFingerprint };
