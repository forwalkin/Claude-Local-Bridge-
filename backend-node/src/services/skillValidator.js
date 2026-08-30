// O schema usa draft 2020-12; o pacote "ajv" padrão só entende até draft-07,
// por isso é preciso importar a variante que registra o meta-schema 2020-12.
const Ajv2020 = require("ajv/dist/2020");

const paths = require("../config/paths");
const skillSchema = require(paths.SKILLS_SCHEMA);

const ajv = new Ajv2020({
  allErrors: true,
  strict: true
});

const validate = ajv.compile(skillSchema);

module.exports = validate;
