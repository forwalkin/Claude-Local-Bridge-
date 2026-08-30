const { computeOperationFingerprint } = require("../security/operationFingerprint");
const { resolveRunnerPath } = require("./runnerPath");

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576; // 1 MiB
const KILL_GRACE_MS = 2000; // decisão aprovada: fixo, não configurável no MVP

const DEFAULT_INTERPRETER = process.platform === "win32" ? "python" : "python3";

const ALLOWED_ENV_KEYS = ["PATH", "SYSTEMROOT", "TEMP", "TMP"];

function buildAllowlistedEnv(sourceEnv) {
  const env = {};
  for (const key of ALLOWED_ENV_KEYS) {
    if (sourceEnv[key] !== undefined) env[key] = sourceEnv[key];
  }
  return env;
}

/**
 * ExecutionEngine.execute -- roda uma skill como processo filho isolado.
 * Nunca re-resolve paths a partir de input bruto; nunca executa
 * destructive:true sem consumeConfirmation() retornar consumed:true;
 * stdout/stderr são sempre dados de diagnóstico, nunca instrução.
 */
function createExecutionEngine({
  runnersRoot,
  auditLogger,
  confirmationManager,
  clock = { now: () => Date.now() },
  spawnFn,
  interpreter = DEFAULT_INTERPRETER,
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  killGraceMs = KILL_GRACE_MS
} = {}) {
  if (typeof spawnFn !== "function") {
    throw new TypeError("createExecutionEngine requer spawnFn (injetável, ex: child_process.spawn).");
  }
  if (!runnersRoot) {
    throw new TypeError("createExecutionEngine requer runnersRoot.");
  }

  function log(eventName, payload) {
    if (auditLogger) {
      auditLogger.log({ eventName, layer: "ExecutionEngine", ...payload });
    }
  }

  async function execute({ operation, skill, confirmationId, fingerprint }) {
    if (!operation || typeof operation !== "object" || !skill || typeof skill !== "object") {
      throw new TypeError("execute() requer operation e skill válidos.");
    }

    const skillName = operation.skillName;

    // --- Checagem de confirmação, sempre ANTES de qualquer spawn ---
    if (operation.destructive === true) {
      if (!confirmationId || !fingerprint) {
        log("execution.attempted_without_confirmation", {
          severity: "critical", outcome: "CONFIRMATION_REQUIRED", skillName
        });
        return { status: "confirmation_required", exitCode: null, stdout: "", stderr: "", durationMs: 0, truncated: false };
      }

      // Defesa em profundidade local: recomputa o fingerprint da operação
      // que está prestes a rodar ANTES de consultar o ConfirmationManager.
      const localFingerprint = computeOperationFingerprint(operation);
      if (localFingerprint !== fingerprint) {
        log("execution.attempted_without_confirmation", {
          severity: "critical", outcome: "FINGERPRINT_MISMATCH_LOCAL", skillName
        });
        return { status: "confirmation_invalid", exitCode: null, stdout: "", stderr: "", durationMs: 0, truncated: false };
      }

      const consumeResult = confirmationManager.consumeConfirmation({ confirmationId, fingerprint });
      if (consumeResult.consumed !== true) {
        log("execution.attempted_without_confirmation", {
          severity: "critical", outcome: consumeResult.reason, skillName
        });
        return { status: "confirmation_invalid", exitCode: null, stdout: "", stderr: "", durationMs: 0, truncated: false };
      }
    }

    // --- Resolução do runner: erro de invariante, não negação de negócio ---
    const runnerPath = resolveRunnerPath({ runnersRoot, skillName });

    // --- Spawn isolado ---
    const startedAt = clock.now();
    log("execution.started", { outcome: "STARTED", skillName });

    const child = spawnFn(interpreter, [runnerPath], {
      cwd: runnersRoot,
      env: buildAllowlistedEnv(process.env),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });

    const payload = JSON.stringify({
      skillName: operation.skillName,
      resolvedPaths: operation.resolvedPaths,
      input: operation.input
    });

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let truncated = false;
    let settled = false;
    let killedFor = null; // "timeout" | "output_exceeded"

    return new Promise((resolve) => {
      function finish(status, exitCode) {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        clearTimeout(graceHandle);

        const durationMs = clock.now() - startedAt;
        const result = { status, exitCode, stdout, stderr, durationMs, truncated };

        const eventName =
          status === "succeeded" ? "execution.succeeded" :
          status === "timeout" ? "execution.timeout" :
          status === "output_exceeded" ? "execution.output_exceeded" :
          "execution.failed";

        log(eventName, {
          outcome: status.toUpperCase(),
          skillName,
          detail: { exitCode, durationMs, truncated, outputBytes }
        });

        resolve(result);
      }

      function killWithGrace(reason) {
        if (settled) return;
        killedFor = reason;
        try { child.kill("SIGTERM"); } catch (_) { /* processo já pode ter morrido */ }
        graceHandle = setTimeout(() => {
          if (!settled) {
            try { child.kill("SIGKILL"); } catch (_) { /* idem */ }
          }
        }, killGraceMs);
      }

      let graceHandle = null;
      const timeoutHandle = setTimeout(() => killWithGrace("timeout"), defaultTimeoutMs);

      child.stdout.on("data", (chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > maxOutputBytes) {
          truncated = true;
          killWithGrace("output_exceeded");
          return;
        }
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > maxOutputBytes) {
          truncated = true;
          killWithGrace("output_exceeded");
          return;
        }
        stderr += chunk.toString();
      });

      child.on("error", (err) => {
        // Falha ao fazer spawn em si (ex: interpretador não encontrado) --
        // erro de infraestrutura, não negação de negócio. Propaga como
        // exceção via rejeição não seria consistente com o contrato
        // "execute() nunca lança para status de negócio" -- mas isso NÃO é
        // status de negócio, é falha de ambiente. Loga como invariant
        // violation e resolve com status "failed" carregando a causa, já
        // que rejeitar a Promise aqui exigiria try/catch em todo chamador
        // para um caso que se sobrepõe pouco aos demais "failed".
        log("execution.invariant_violation", {
          severity: "critical", outcome: "SPAWN_ERROR", skillName, detail: { message: err.message }
        });
        finish("failed", null);
      });

      child.on("close", (code) => {
        if (killedFor === "timeout") {
          finish("timeout", code);
        } else if (killedFor === "output_exceeded") {
          finish("output_exceeded", code);
        } else {
          finish(code === 0 ? "succeeded" : "failed", code);
        }
      });

      child.stdin.write(payload);
      child.stdin.end();
    });
  }

  return { execute };
}

module.exports = { createExecutionEngine, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_BYTES, KILL_GRACE_MS };
