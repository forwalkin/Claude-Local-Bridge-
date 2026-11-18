const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const {
  findDangerousPatternInRawPath,
  isContained,
  canonicalizeAgainstFilesystem
} = require("../src/security/pathResolution");

async function makeTempDir(prefix = "resolution-") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return fs.realpath(dir);
}

test("findDangerousPatternInRawPath: caminho relativo simples é seguro (null)", () => {
  assert.equal(findDangerousPatternInRawPath("arquivo.txt"), null);
  assert.equal(findDangerousPatternInRawPath("pasta/arquivo.txt"), null);
});

test("findDangerousPatternInRawPath: absoluto POSIX", () => {
  assert.equal(findDangerousPatternInRawPath("/etc/passwd"), "ABSOLUTE_PATH");
});

test("findDangerousPatternInRawPath: absoluto Windows com drive letter", () => {
  assert.equal(findDangerousPatternInRawPath("C:\\Windows"), "ABSOLUTE_PATH");
});

test("findDangerousPatternInRawPath: UNC path", () => {
  assert.equal(findDangerousPatternInRawPath("\\\\servidor\\share"), "ABSOLUTE_PATH");
});

test("findDangerousPatternInRawPath: segmento '..' com barra normal", () => {
  assert.equal(findDangerousPatternInRawPath("../fora"), "PARENT_SEGMENT");
});

test("findDangerousPatternInRawPath: segmento '..' com barra invertida", () => {
  assert.equal(findDangerousPatternInRawPath("..\\fora"), "PARENT_SEGMENT");
});

test("findDangerousPatternInRawPath: dois-pontos no meio do path", () => {
  assert.equal(findDangerousPatternInRawPath("arquivo.txt:oculto"), "COLON_CHARACTER");
});

test("findDangerousPatternInRawPath: byte nulo", () => {
  assert.equal(findDangerousPatternInRawPath("arquivo\0.txt"), "NULL_BYTE");
});

test("findDangerousPatternInRawPath: string vazia", () => {
  assert.equal(findDangerousPatternInRawPath(""), "EMPTY_OR_NOT_STRING");
});

test("findDangerousPatternInRawPath: não-string", () => {
  assert.equal(findDangerousPatternInRawPath(123), "EMPTY_OR_NOT_STRING");
  assert.equal(findDangerousPatternInRawPath(null), "EMPTY_OR_NOT_STRING");
  assert.equal(findDangerousPatternInRawPath(undefined), "EMPTY_OR_NOT_STRING");
});

test("isContained: target dentro do root", () => {
  assert.equal(isContained("/sandbox", "/sandbox/a/b.txt"), true);
});

test("isContained: target é o próprio root", () => {
  assert.equal(isContained("/sandbox", "/sandbox"), true);
});

test("isContained: target fora do root via '..'", () => {
  assert.equal(isContained("/sandbox/a", "/sandbox"), false);
});

test("isContained: NÃO confunde sandbox com sandbox_evil (bug clássico de startsWith)", () => {
  assert.equal(isContained("/sandbox", "/sandbox_evil/arquivo.txt"), false);
  assert.equal(isContained("/sandbox", "/sandbox_evil"), false);
});

test("isContained: caminhos irmãos completamente diferentes", () => {
  assert.equal(isContained("/sandbox", "/etc/passwd"), false);
});

test("canonicalizeAgainstFilesystem: alvo existente é resolvido via realpath", async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, "arquivo.txt");
  await fs.writeFile(filePath, "conteudo");

  const result = await canonicalizeAgainstFilesystem(filePath);

  assert.equal(result.existed, true);
  assert.equal(result.canonicalPath, filePath);
});

test("canonicalizeAgainstFilesystem: alvo inexistente com ancestral direto existente", async () => {
  const dir = await makeTempDir();
  const target = path.join(dir, "nao_existe.txt");

  const result = await canonicalizeAgainstFilesystem(target);

  assert.equal(result.existed, false);
  assert.equal(result.canonicalPath, target);
});

test("canonicalizeAgainstFilesystem: alvo inexistente com vários níveis de ancestrais inexistentes", async () => {
  const dir = await makeTempDir();
  const target = path.join(dir, "a", "b", "c", "arquivo.txt");

  const result = await canonicalizeAgainstFilesystem(target);

  assert.equal(result.existed, false);
  assert.equal(result.canonicalPath, target);
});

test("canonicalizeAgainstFilesystem: ancestral é symlink -> resolve para o alvo real do symlink", async () => {
  const dir = await makeTempDir();
  const outsideDir = await makeTempDir("outside-");

  await fs.symlink(outsideDir, path.join(dir, "link"));

  const target = path.join(dir, "link", "arquivo_novo.txt");
  const result = await canonicalizeAgainstFilesystem(target);

  assert.equal(result.existed, false);
  assert.equal(result.canonicalPath, path.join(outsideDir, "arquivo_novo.txt"));
});

test("canonicalizeAgainstFilesystem: sobe múltiplos ancestrais inexistentes até achar um real", async () => {
  const dir = await makeTempDir();
  await fs.rm(dir, { recursive: true, force: true });

  const target = path.join(dir, "a", "b", "c.txt");

  const result = await canonicalizeAgainstFilesystem(target);
  assert.equal(result.existed, false);
});

function fsError(code, message = code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// realpath controlado: mapeia path -> valor retornado ou erro lançado, e
// registra a ordem das chamadas. Não toca o filesystem nem depende de
// permissões do SO (funciona igual em Windows, Linux e como root).
function makeFakeRealpath(behavior) {
  const calls = [];
  const realpath = async (p) => {
    calls.push(p);
    const outcome = behavior(p);
    if (outcome instanceof Error) {
      throw outcome;
    }
    return outcome;
  };
  return { realpath, calls };
}

test("canonicalizeAgainstFilesystem: propaga erros de filesystem que não são ENOENT", async () => {
  const target = path.join(path.resolve("raiz"), "restrito", "arquivo.txt");
  const ancestor = path.dirname(target);
  const denied = fsError("EACCES", "permissão negada simulada");

  const { realpath, calls } = makeFakeRealpath((p) =>
    p === target ? fsError("ENOENT") : denied
  );

  await assert.rejects(
    () => canonicalizeAgainstFilesystem(target, { realpath }),
    (err) => {
      assert.equal(err, denied); // mesma identidade: erro original, sem wrapper
      assert.equal(err.code, "EACCES");
      assert.equal(err.message, "permissão negada simulada");
      return true;
    }
  );

  // Tentou o alvo (ENOENT) e depois o ancestral (EACCES); não seguiu subindo.
  assert.deepEqual(calls, [target, ancestor]);
});

test("canonicalizeAgainstFilesystem: propaga EPERM lançado ao resolver o próprio alvo", async () => {
  const target = path.join(path.resolve("raiz"), "arquivo.txt");
  const denied = fsError("EPERM");
  const { realpath, calls } = makeFakeRealpath(() => denied);

  await assert.rejects(
    () => canonicalizeAgainstFilesystem(target, { realpath }),
    (err) => err === denied && err.code === "EPERM"
  );
  assert.deepEqual(calls, [target]);
});

test("canonicalizeAgainstFilesystem: ENOENT continua subindo até o ancestral existente", async () => {
  const base = path.resolve("raiz");
  const target = path.join(base, "a", "b", "c.txt");
  const realBase = path.resolve("real");

  const { realpath, calls } = makeFakeRealpath((p) =>
    p === base ? realBase : fsError("ENOENT")
  );

  const result = await canonicalizeAgainstFilesystem(target, { realpath });

  assert.deepEqual(result, {
    canonicalPath: path.join(realBase, "a", "b", "c.txt"),
    existed: false
  });
  assert.deepEqual(calls, [
    target,
    path.join(base, "a", "b"),
    path.join(base, "a"),
    base
  ]);
});

test("canonicalizeAgainstFilesystem: rejeita realpath injetado que não é função", async () => {
  await assert.rejects(
    () => canonicalizeAgainstFilesystem(path.resolve("x"), { realpath: "nope" }),
    TypeError
  );
});
